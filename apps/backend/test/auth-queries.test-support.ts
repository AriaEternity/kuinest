import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, inspect, accepted, seed, clientId, password, isCode, directory } from "./auth-fixtures.js";
import { startServer } from "../dist/server.js";
import { loadSyntheticKey } from "../dist/auth/secrets.js";
import { createServer } from "node:net";
import { SqliteStorage } from "../dist/storage/storage.js";
import { PasswordHasher } from "../dist/auth/password.js";

test("查询验收：会话游标稳定遍历同时间记录，校验签名、owner 和查询类型", t => {
  const f = fixture(t); f.init();
  for (let i = 0; i < 5; i++) f.api.queries.createConversation("owner-a", "合成-" + i);
  const all: string[] = []; let cursor: string | undefined;
  do {
    const page = f.api.queries.conversations("owner-a", cursor, 2); all.push(...page.items.map(c => c.id)); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(all.length, 5); assert.equal(new Set(all).size, 5);
  const next = f.api.queries.conversations("owner-a", undefined, 2).nextCursor!;
  assert.ok(next.length <= 256);
  assert.throws(() => f.api.queries.conversations("owner-b", next, 2), isCode("CURSOR_INVALID"));
  assert.throws(() => f.api.queries.history("owner-a", all[0]!, next, 2), isCode("CURSOR_INVALID"));
  assert.throws(() => f.api.queries.conversations("owner-a", next.slice(0, 5) + "!" + next.slice(6), 2), isCode("CURSOR_INVALID"));
  const malformed = f.signing.cursor(["conversations", "owner-a"], [-1, "id"]);
  assert.throws(() => f.api.queries.conversations("owner-a", malformed, 2), isCode("CURSOR_INVALID"));
});
test("查询验收：历史分页按消息顺序返回、排除 suppressed、绑定会话，保留 partial/runId", t => {
  const f = fixture(t); seed(f.storage); f.storage.write("owner-a", repo => accepted(repo));
  f.storage.write("owner-a", repo => {
    for (let i = 3; i <= 7; i++) repo.insertMessage({ id: "message-" + i, conversationId: "conversation-a", seq: i, role: "assistant", content: "合成-" + i, status: "complete", revision: i, createdAt: 100000 });
    repo.createConversation("conversation-a2", "character-a", "合成空会话", 100000);
  });
  inspect(f.root, db => {
    db.exec("UPDATE conversations SET change_revision=7,next_public_seq=8 WHERE id='conversation-a'");
    db.exec("UPDATE messages SET visibility='suppressed' WHERE id='message-7'");
  });
  const first = f.api.queries.history("owner-a", "conversation-a", undefined, 2); assert.deepEqual(first.items.map(m => m.id), ["message-5", "message-6"]);
  assert.equal(first.revision, 7);
  const second = f.api.queries.history("owner-a", "conversation-a", first.nextCursor!, 2); assert.deepEqual(second.items.map(m => m.id), ["message-3", "message-4"]);
  const last = f.api.queries.history("owner-a", "conversation-a", second.nextCursor!, 2); assert.equal(last.nextCursor, null);
  assert.deepEqual(last.items.map(m => m.id), ["user-a", "reply-a"]); assert.equal(last.items[1]!.status, "partial"); assert.equal(last.items[0]!.runId, "run-a");
  assert.throws(() => f.api.queries.history("owner-a", "conversation-a2", first.nextCursor!, 2), isCode("CURSOR_INVALID"));
});
test("查询验收：changes 能取回旧消息的新 revision，超过一页可连续追平", t => {
  const f = fixture(t); seed(f.storage);
  f.storage.write("owner-a", repo => {
    for (let i = 1; i <= 102; i++) repo.insertMessage({ id: "m-" + i, conversationId: "conversation-a", seq: i, role: "assistant", content: "合成", status: "partial", revision: i, createdAt: 100000 });
  });
  inspect(f.root, db => {
    db.exec("UPDATE conversations SET change_revision=103,next_public_seq=103 WHERE id='conversation-a'");
    db.exec("UPDATE messages SET content='合成更新',status='complete',updated_revision=103 WHERE id='m-1'");
  });
  const first = f.api.queries.changes("owner-a", "conversation-a", 0); assert.equal(first.items.length, 100); assert.equal(first.hasMore, true); assert.equal(first.throughRevision, 101);
  const second = f.api.queries.changes("owner-a", "conversation-a", first.throughRevision); assert.equal(second.hasMore, false); assert.equal(second.throughRevision, 103);
  assert.deepEqual(second.items.map(m => m.id), ["m-102", "m-1"]); assert.equal(second.items[1]!.content, "合成更新");
  assert.deepEqual(f.api.queries.changes("owner-a", "conversation-a", 103), { items: [], throughRevision: 103, hasMore: false });
  assert.throws(() => f.api.queries.changes("owner-a", "conversation-a", 104), isCode("CURSOR_INVALID"));
});
test("A04/A07：运行与幂等查询只公开白名单字段，隐藏后台错误和 suppressed 回复", async t => {
  const f = fixture(t); seed(f.storage); f.storage.write("owner-a", repo => accepted(repo));
  f.storage.apiAccess().changePassword("owner-a", "synthetic-not-a-password-hash", "fake:" + password, f.clock.now());
  inspect(f.root, db => db.prepare("UPDATE runs SET request_key=?,input_json=?,error_code=?,status='failed',finished_at=100001 WHERE id='run-a'").run("user:" + clientId, '{"reasoning_content":"synthetic-internal-marker"}', "synthetic-error-marker"));
  const s = await f.login("合成主人-a"), headers = { cookie: s.cookie };
  const snapshot = await f.app.inject({ url: "/api/v1/runs/run-a", headers }); assert.equal(snapshot.statusCode, 200);
  assert.deepEqual(Object.keys(snapshot.json()).sort(), ["conversationId", "error", "lastSequence", "origin", "reply", "runId", "status"]);
  assert.equal(snapshot.json().error.code, "INTERNAL_ERROR");
  const lookup = await f.app.inject({ url: "/api/v1/conversations/conversation-a/submissions/" + clientId, headers });
  assert.equal(lookup.statusCode, 200); assert.equal(lookup.json().submission.messageId, "user-a");
  assert.doesNotMatch(snapshot.body + lookup.body + f.logs(), /synthetic-internal-marker|synthetic-error-marker|input_json|reasoning_content|passwordHash/);
  inspect(f.root, db => db.exec("UPDATE messages SET visibility='suppressed' WHERE id='reply-a'"));
  const hidden = f.api.queries.run("owner-a", "run-a"); assert.equal(hidden.reply, undefined);
});
test("查询验收：SSE 预留入口校验序号，Last-Event-ID 优先，超前或非法值拒绝", async t => {
  const f = fixture(t); seed(f.storage); f.storage.write("owner-a", repo => accepted(repo));
  f.storage.apiAccess().changePassword("owner-a", "synthetic-not-a-password-hash", "fake:" + password, f.clock.now()); const s = await f.login("合成主人-a");
  for (const input of ["-1", "1.5", "9007199254740992", "2"]) {
    const response = await f.app.inject({ url: "/api/v1/runs/run-a/events", headers: { cookie: s.cookie, "last-event-id": input } }); assert.equal(response.statusCode, 400);
  }
  const priority = await f.app.inject({ url: "/api/v1/runs/run-a/events?afterSequence=99", headers: { cookie: s.cookie, "last-event-id": "1" } }); assert.equal(priority.statusCode, 503);
});
test("A01/A02：真实启动、登录与重启恢复使用同一合成会话和签名密钥", async t => {
  const root = directory(true), hasher = new PasswordHasher(), hash = await hasher.hash(password);
  const store = new SqliteStorage({ dataRoot: root, instanceId: "bootstrap-test", clock: { now: Date.now } });
  store.apiAccess().initializeOwner({ id: "owner-a", username: "synthetic-a", passwordHash: hash, createdAt: Date.now(), characterId: "c", versionId: "v", profileId: "p" }); await store.close();
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const origin = "http://127.0.0.1:" + address.port, env = { NODE_ENV: "development", APP_MODE: "synthetic", DATA_ROOT: root, PORT: String(address.port), PUBLIC_ORIGIN: origin };
  const app = await startServer(env); t.after(() => app.close());
  const result = await fetch(origin + "/api/v1/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "synthetic-a", password }) });
  assert.equal(result.status, 200); const cookie = result.headers.get("set-cookie")!.split(";")[0]!;
  const key = loadSyntheticKey(root); await app.close();
  const second = await startServer(env); t.after(() => second.close());
  assert.deepEqual(loadSyntheticKey(root), key);
  const session = await fetch(origin + "/api/v1/auth/session", { headers: { cookie } }); assert.equal(session.status, 200);
  await second.close(); assert.equal(second.server.listening, false);
});

test("查询验收：最新历史包含合法的最大安全序号，不被默认游标排除", t => {
  const f = fixture(t); seed(f.storage);
  f.storage.write("owner-a", repo => repo.insertMessage({ id: "max-seq", conversationId: "conversation-a", seq: Number.MAX_SAFE_INTEGER, role: "assistant", content: "纯合成边界", status: "complete", revision: 1, createdAt: 100000 }));
  assert.equal(f.api.queries.history("owner-a", "conversation-a", undefined, 50).items[0]!.id, "max-seq");
});
