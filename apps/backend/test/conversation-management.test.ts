import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { fixture, writeHeaders, password, inspect } from "./auth-fixtures.js";
import { harness, controlled, until } from "./run-fixtures.js";
import { releaseFixture, password as releasePassword } from "./release-fixtures.js";
import { projectRoot, startServer } from "../dist/server.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { loadMigrations } from "../dist/storage/migrations.js";
import { ChatClient } from "@kuinest/chat-client";
import { submission } from "../dist/conversations/submit.js";
import { loadConfig } from "../dist/config.js";

function removeSynthetic(root: string): void {
  const parent = realpathSync(join(projectRoot, ".cache"));
  const target = realpathSync(root);
  assert.ok(target.startsWith(parent + sep) && target !== parent);
  rmSync(target, { recursive: true });
}

test("会话改名走真实HTTP，保留消息revision、分页键且重开库后持久存在", async t => {
  const f = fixture(t); f.init();
  t.after(async () => { await f.app.close(); removeSynthetic(f.root); });
  const session = await f.login(), headers = writeHeaders(session);
  const created = await f.app.inject({ method: "POST", url: "/api/v1/conversations", headers, payload: { title: "原合成标题" } });
  const id = created.json().id as string, before = f.storage.apiAccess().conversation("owner-a", id)!;
  f.clock.value += 1000;
  const renamed = await f.app.inject({ method: "PATCH", url: "/api/v1/conversations/" + id, headers, payload: { title: "  改名后的会话✨  " } });
  assert.equal(renamed.statusCode, 200); assert.equal(renamed.json().title, "改名后的会话✨");
  assert.equal(renamed.json().revision, before.revision);
  assert.equal(f.storage.apiAccess().conversation("owner-a", id)!.createdAt, before.createdAt);
  await f.reopen();
  assert.equal((await f.app.inject({ url: "/api/v1/conversations/" + id, headers: { cookie: session.cookie } })).json().title, "改名后的会话✨");
});

test("改名与删除要求本人会话及Origin/CSRF，空白、超长或多余字段不写入", async t => {
  const f = fixture(t); f.init();
  t.after(async () => { await f.app.close(); removeSynthetic(f.root); });
  const session = await f.login(), headers = writeHeaders(session);
  const item = f.storage.apiAccess().createConversation("owner-a", randomUUID(), "原名", f.clock.now());
  const url = "/api/v1/conversations/" + item.id;
  for (const method of ["PATCH", "DELETE"] as const) {
    const payload = method === "PATCH" ? { title: "新名" } : {};
    assert.equal((await f.app.inject({ method, url, payload })).statusCode, 401);
    assert.equal((await f.app.inject({ method, url, headers: { ...headers, origin: "https://other.invalid" }, payload })).statusCode, 403);
    assert.equal((await f.app.inject({ method, url, headers: { cookie: session.cookie, origin: headers.origin }, payload })).statusCode, 403);
  }
  f.storage.provisionOwner({ id: "owner-b", username: "synthetic-b", passwordHash: "fake:" + password, createdAt: f.clock.now() });
  const other = writeHeaders(await f.login("synthetic-b"));
  for (const method of ["GET", "PATCH", "DELETE"] as const) assert.equal((await f.app.inject({ method, url, headers: other, ...(method === "GET" ? {} : { payload: method === "PATCH" ? { title: "越权" } : {} }) })).statusCode, 404);
  for (const payload of [{ title: "  " }, { title: "x".repeat(101) }, { title: "a\nb" }, { title: "合法", ownerId: "owner-b" }, { title: 1 }]) {
    assert.equal((await f.app.inject({ method: "PATCH", url, headers, payload })).statusCode, 400);
  }
  assert.equal(f.storage.apiAccess().conversation("owner-a", item.id)!.title, "原名");
});

test("正在回复可改名但不能删除；停止后删除同时封闭消息、run、SSE与新提交", async t => {
  const gate = controlled(), h = harness(t, gate.provider), headers = await h.headers();
  t.after(async () => { await h.app.close(); removeSynthetic(h.f.root); });
  const input = { clientMessageId: randomUUID(), text: "纯合成生成请求" };
  const received = await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload: input });
  assert.equal(received.statusCode, 202); const runId = received.json().runId as string;
  await until(() => gate.calls.length === 1);
  assert.equal((await h.app.inject({ method: "PATCH", url: "/api/v1/conversations/conversation-a", headers, payload: { title: "生成中改名" } })).statusCode, 200);
  const busy = await h.app.inject({ method: "DELETE", url: "/api/v1/conversations/conversation-a", headers });
  assert.equal(busy.statusCode, 409); assert.equal(busy.json().error.code, "CONVERSATION_BUSY");
  await h.app.inject({ method: "POST", url: "/api/v1/runs/" + runId + "/cancel", headers, payload: {} });
  await until(() => h.api.queries.run("owner-a", runId).status === "cancelled");
  const messagesBefore = inspect(h.f.root, db => (db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n);
  assert.equal((await h.app.inject({ method: "DELETE", url: "/api/v1/conversations/conversation-a", headers })).statusCode, 204);
  assert.equal((await h.app.inject({ method: "DELETE", url: "/api/v1/conversations/conversation-a", headers })).statusCode, 204);
  for (const url of ["/api/v1/conversations/conversation-a", "/api/v1/conversations/conversation-a/messages", "/api/v1/conversations/conversation-a/changes?afterRevision=0", "/api/v1/conversations/conversation-a/submissions/" + input.clientMessageId, "/api/v1/runs/" + runId, "/api/v1/runs/" + runId + "/events"]) assert.equal((await h.app.inject({ url, headers })).statusCode, 404, url);
  assert.equal((await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload: { clientMessageId: randomUUID(), text: "删除后不应受理" } })).statusCode, 404);
  assert.equal((await h.app.inject({ url: "/api/v1/conversations", headers })).json().items.length, 0);
  assert.equal(inspect(h.f.root, db => (db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n), messagesBefore);
});

test("删除会话保留已确认长期记忆，新会话仍能查询同一候选决定", async t => {
  const f = await releaseFixture();
  const app = await startServer(f.env, { transport: async () => { throw Error("禁止真实模型请求"); } });
  t.after(async () => { await app.close(); removeSynthetic(f.root); });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: f.env.PUBLIC_ORIGIN }, payload: { username: f.username, password: releasePassword } });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, origin: f.env.PUBLIC_ORIGIN, "x-csrf-token": login.json().csrfToken as string };
  const first = (await app.inject({ method: "POST", url: "/api/v1/conversations", headers, payload: { title: "合成来源会话" } })).json().id as string;
  const proposal = (await app.inject({ method: "POST", url: "/api/v1/conversations/" + first + "/memory-proposals", headers, payload: { clientRequestId: randomUUID(), content: "纯合成验收记忆" } })).json();
  const confirm = await app.inject({ method: "POST", url: "/api/v1/memory-proposals/" + proposal.id + "/confirm", headers, payload: { revision: proposal.revision, contentSha256: proposal.contentSha256 } });
  assert.equal(confirm.statusCode, 200); assert.equal(confirm.json().status, "confirmed");
  const countBefore = inspect(f.root, db => (db.prepare("SELECT count(*) AS n FROM memory_heads").get() as { n: number }).n);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/conversations/" + first, headers })).statusCode, 204);
  const second = (await app.inject({ method: "POST", url: "/api/v1/conversations", headers, payload: {} })).json().id as string;
  const queue = await app.inject({ url: "/api/v1/conversations/" + second + "/memory-proposals", headers });
  assert.equal(queue.statusCode, 200); assert.ok(queue.json().items.some((item: { id: string; status: string }) => item.id === proposal.id && item.status === "confirmed"));
  assert.equal(inspect(f.root, db => (db.prepare("SELECT count(*) AS n FROM memory_heads").get() as { n: number }).n), countBefore);
});

test("旧五段schema原地升级保留原会话，删除标记在重开库后继续生效", async () => {
  const parent = join(projectRoot, ".cache", "conversation-migration-tests"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "synthetic-")), clock = { now: () => 100000 };
  let store = new SqliteStorage({ dataRoot: root, instanceId: randomUUID(), clock, migrations: loadMigrations().slice(0, 5) });
  try {
    store.apiAccess().initializeOwner({ id: "owner-upgrade", username: "synthetic-upgrade", passwordHash: "fake:synthetic-only", characterId: "character-upgrade", versionId: "version-upgrade", profileId: "profile-upgrade", createdAt: clock.now() });
    store.write("owner-upgrade", repo => repo.createConversation("conversation-upgrade", "character-upgrade", "升级前会话", clock.now()));
    await store.close(); store = new SqliteStorage({ dataRoot: root, instanceId: randomUUID(), clock });
    assert.equal(store.apiAccess().conversation("owner-upgrade", "conversation-upgrade")!.title, "升级前会话");
    store.apiAccess().deleteConversation("owner-upgrade", "conversation-upgrade", clock.now());
    await store.close(); store = new SqliteStorage({ dataRoot: root, instanceId: randomUUID(), clock });
    assert.equal(store.apiAccess().conversation("owner-upgrade", "conversation-upgrade"), undefined);
    assert.equal(store.apiAccess().conversations("owner-upgrade", undefined, 50).length, 0);
  } finally { await store.close(); removeSynthetic(root); }
});

test("删除同时停用该会话调度，之后不能重新启用或受理内部新消息", async () => {
  const f = await releaseFixture();
  const clock = { now: () => Date.now() };
  const store = new SqliteStorage({ dataRoot: f.root, instanceId: randomUUID(), clock });
  try {
    const conversation = store.apiAccess().createConversation(f.owner, randomUUID(), "合成调度会话", clock.now());
    const id = randomUUID(), scheduler = store.schedulerAccess();
    scheduler.create(f.owner, id, { conversationId: conversation.id, intervalSeconds: 3600, timezone: "UTC", nextDueAt: clock.now(), definition: { documentVersionId: f.version, documentName: "HEARTBEAT.md", allowWebSearch: false, allowMemoryWrite: false, silenceMarkers: ["SYNTHETIC_SILENT"], delivery: "web" } }, clock.now());
    scheduler.setEnabled(f.owner, id, 1, true);
    store.apiAccess().deleteConversation(f.owner, conversation.id, clock.now());
    assert.equal(scheduler.tick(clock.now(), { next: randomUUID }), 0);
    assert.throws(() => scheduler.setEnabled(f.owner, id, 3, true), error => (error as { code?: string }).code === "NOT_FOUND");
    assert.throws(() => store.imageAccess().requireConversation(f.owner, conversation.id), error => (error as { code?: string }).code === "NOT_FOUND");
    assert.throws(() => store.runAccess().submit(f.owner, conversation.id, submission({ clientMessageId: randomUUID(), text: "删除后不应受理" }), clock.now(), { next: randomUUID }, loadConfig(f.env, projectRoot).limits), error => (error as { code?: string }).code === "NOT_FOUND");
    inspect(f.root, db => {
      assert.equal((db.prepare("SELECT enabled FROM scheduled_tasks WHERE id=?").get(id) as { enabled: number }).enabled, 0);
      assert.equal((db.prepare("SELECT count(*) AS n FROM runs WHERE conversation_id=?").get(conversation.id) as { n: number }).n, 0);
    });
  } finally { await store.close(); removeSynthetic(f.root); }
});

test("共享客户端校验会话身份及删除204，服务器失败时不伪造成功", async () => {
  const csrf = "x".repeat(43), conversation = { id: "synthetic-id", title: "新名称", updatedAt: "2026-10-28T00:00:00.000Z", revision: 0 };
  const calls: RequestInit[] = [];
  const client = new ChatClient("/api/v1", async (_url, options) => { calls.push(options!); return options!.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(conversation); });
  assert.equal((await client.renameConversation(conversation.id, conversation.title, csrf)).title, conversation.title);
  await client.deleteConversation(conversation.id, csrf);
  assert.equal(calls[0]!.method, "PATCH"); assert.equal(new Headers(calls[1]!.headers).get("x-csrf-token"), csrf);
  const wrong = new ChatClient("/api/v1", async () => Response.json({ ...conversation, id: "other-id" }));
  await assert.rejects(() => wrong.renameConversation(conversation.id, "新名称", csrf), /CONVERSATION_IDENTITY_INVALID/);
  const failed = new ChatClient("/api/v1", async () => new Response(null, { status: 409 }));
  await assert.rejects(() => failed.deleteConversation(conversation.id, csrf));
});
