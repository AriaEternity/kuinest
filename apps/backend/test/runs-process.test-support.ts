import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "../dist/conversations/worker.js";
import { startServer, projectRoot } from "../dist/server.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { tokenHash } from "../dist/auth/sessions.js";
import { submission } from "../dist/conversations/submit.js";
import { fixture, controlled, until, inspect } from "./run-fixtures.js";

test("R03/R06：真实子进程强制中断后由新fence恢复，只继续未开始任务", async t => {
  const f = fixture(t), a = f.submit("子进程中断输入"), b = f.submit("尚未开始");
  await f.storage.close();
  const child = fork(join(projectRoot, "apps/backend/dist-test/run-crash-child.js"), [f.root, String(f.clock.now()), a.runId], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill(); });
  const message = await once(child, "message", { signal: AbortSignal.timeout(5000) }); assert.deepEqual(message[0], { status: "persisted" });
  const exited = once(child, "exit"); assert.equal(child.kill(), true); await exited;
  await f.reopen(30000);
  const gate = controlled(), worker = new Worker(f.store, gate.provider, f.clock, f.ids, { pollMs: 10, abortDrainMs: 30 }); f.cleanup(() => worker.close()); worker.start();
  await until(() => gate.calls.length === 1);
  inspect(f.root, db => {
    assert.deepEqual(db.prepare("SELECT status,error_code FROM runs WHERE id=?").get(a.runId), { status: "failed", error_code: "RUN_INTERRUPTED" });
    const reply = db.prepare("SELECT content,status FROM messages WHERE id=?").get(a.replyId) as { content: string; status: string };
    assert.match(reply.content, /^纯合成中断证据/); assert.equal(reply.status, "partial");
    assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(b.runId) as { status: string }).status, "running");
  });
  assert.deepEqual(gate.calls[0]!.request.messages.map(m => m.content), ["子进程中断输入", "尚未开始"]);
});
test("R01/R06：真实回环HTTP发送、查询完成、关服与重启不重复执行终态", async t => {
  const parent = join(projectRoot, "runtime/dev-synthetic"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "stage04-http-")), store = new SqliteStorage({ dataRoot: root, clock: { now: Date.now }, instanceId: randomUUID() });
  store.apiAccess().initializeOwner({ id: "owner-a", username: "synthetic-network-owner", passwordHash: "synthetic-network-hash", characterId: "c", profileId: "p", versionId: "v", createdAt: Date.now() });
  store.write("owner-a", repo => repo.createConversation("conversation-a", "c", "合成", Date.now()));
  const token = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
  store.apiAccess().createSession({ tokenHash: tokenHash(token), ownerId: "owner-a", csrfToken: csrf, createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + 86400000 }, "synthetic-network-hash");
  const queued = store.runAccess().submit("owner-a", "conversation-a", submission({ clientMessageId: randomUUID(), text: "启动前接受" }), Date.now(), { next: randomUUID }, { perConversationQueue: 4, globalQueue: 16 });
  await store.close();
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const origin = "http://127.0.0.1:" + address.port, env = { NODE_ENV: "development", APP_MODE: "synthetic", DATA_ROOT: root, PORT: String(address.port), PUBLIC_ORIGIN: origin };
  const app = await startServer(env); t.after(() => app.close());
  const headers = { cookie: "kuinest_dev_session=" + token, origin, "x-csrf-token": csrf, "content-type": "application/json" };
  const response = await fetch(origin + "/api/v1/conversations/conversation-a/messages", { method: "POST", headers, body: JSON.stringify({ clientMessageId: randomUUID(), text: "实际HTTP合成请求" }) });
  assert.equal(response.status, 202); const receipt = await response.json() as { runId: string };
  for (const id of [queued.runId, receipt.runId]) {
    const end = Date.now() + 4000;
    while (true) {
      const result = await fetch(origin + "/api/v1/runs/" + id, { headers }); const snapshot = await result.json() as { status: string; reply?: { content: string } };
      if (snapshot.status === "completed") { assert.match(snapshot.reply!.content, /合成演示/); break; }
      assert.ok(Date.now() < end, "HTTP生成未完成"); await delay(10);
    }
  }
  assert.equal((await fetch(origin + "/health/ready")).status, 200);
  await app.close(); assert.equal(app.server.listening, false);
  const before = inspect(root, db => db.prepare("SELECT id,status,last_event_seq FROM runs ORDER BY id").all());
  const next = await startServer(env); t.after(() => next.close()); await delay(80);
  inspect(root, db => assert.deepEqual(db.prepare("SELECT id,status,last_event_seq FROM runs ORDER BY id").all(), before));
  await next.close(); assert.equal(next.server.listening, false);
});
