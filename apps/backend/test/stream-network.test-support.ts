import { EventEmitter } from "node:events";
import type { FastifyReply } from "fastify";
import { EventStreams } from "../dist/http/routes/events.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readEvents, RunState } from "../../../packages/chat-client/dist/index.js";
import { network, until, inspect, rawStream } from "./stream-fixtures.js";
import { ApplicationError } from "../dist/application/errors.js";

test("S02/S06：真实断流只释放订阅，重连按序重放且完成全文对账", async t => {
  const f = await network(t), run = await f.submit();
  const start = await f.client.run(run.runId), state = new RunState(); state.reconcile(start);
  const response = await f.get(run.runId, "?afterSequence=" + start.lastSequence);
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.equal(response.headers.get("x-accel-buffering"), "no"); assert.equal(response.headers.get("cache-control"), "no-store");
  const reader = readEvents(response.body!);
  f.gate.calls[0]!.push({ type: "text_delta", text: "前半🙂" });
  const first = (await reader.next()).value!; state.apply(first); assert.equal(state.value.reply!.content, "前半🙂");
  await reader.return(undefined); await until(() => f.events.diagnostics.connections === 0);
  assert.equal((await f.client.run(run.runId)).status, "running"); assert.equal(f.gate.calls[0]!.signal.aborted, false);
  await f.finish("后半"); await until(() => f.api.queries.run("owner-a", run.runId).status === "completed");
  const replay = await f.get(run.runId, "?afterSequence=" + start.lastSequence);
  for await (const event of readEvents(replay.body!)) state.apply(event);
  assert.equal(state.value.reply!.content, "前半🙂后半"); assert.equal(state.value.status, "completed");
  assert.equal((await f.get(run.runId, "", { "last-event-id": String(state.value.lastSequence) })).status, 204);
});

test("S03：历史读取后提交的事件由订阅唤醒，不依赖定时轮询", async t => {
  let commit: (() => void) | undefined;
  const f = await network(t, { pollMs: 10000, heartbeatMs: 10000 }, store => ({
    ...store, read(owner, id, cursor) { const page = store.read(owner, id, cursor); if (!page.event && commit) { const action = commit; commit = undefined; action(); } return page; },
  }));
  const run = await f.submit(), before = await f.client.run(run.runId);
  commit = () => { f.gate.calls[0]!.push({ type: "text_delta", text: "竞态增量" }); };
  const response = await f.get(run.runId, "?afterSequence=" + before.lastSequence), iterator = readEvents(response.body!);
  const first = await iterator.next(); assert.equal(first.value?.type, "reply.delta");
  if (first.value?.type === "reply.delta") assert.equal(first.value.text, "竞态增量");
  await iterator.return(undefined);
});

test("S04：Last-Event-ID 优先，越界/非法/签名错误均受控拒绝", async t => {
  const f = await network(t), run = await f.submit(); await f.finish();
  await until(() => f.api.queries.run("owner-a", run.runId).status === "completed");
  const snapshot = await f.client.run(run.runId);
  assert.equal((await f.get(run.runId, "?afterSequence=99999", { "last-event-id": String(snapshot.lastSequence) })).status, 204);
  for (const cursor of ["-1", "1.2", "01", "9007199254740992", String(snapshot.lastSequence + 1)]) {
    const response = await f.get(run.runId, "", { "last-event-id": cursor });
    assert.equal(response.status, 400); assert.equal((await response.json() as { error: { code: string } }).error.code, "CURSOR_INVALID");
  }
  const invalid = await fetch(f.origin + "/api/v1/conversations/conversation-a/messages?cursor=bad-signature", { headers: f.headers });
  assert.equal(invalid.status, 400); await invalid.body?.cancel();
});

test("S04：七天终态清理后旧游标410，快照与最后事件可恢复，活动事件保留", async t => {
  const f = await network(t), run = await f.submit(); await f.finish();
  await until(() => f.api.queries.run("owner-a", run.runId).status === "completed");
  const terminal = await f.client.run(run.runId);
  const pending = f.runs.submit("owner-a", "conversation-a", { clientMessageId: f.ids.next(), text: "活动合成" });
  inspect(f.root, db => db.prepare("UPDATE runs SET finished_at=? WHERE id=?").run(Date.now() - 8 * 86400000, run.runId));
  assert.equal(f.storage.eventAccess().prune(Date.now()), 1);
  inspect(f.root, db => {
    assert.equal((db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id=?").get(run.runId) as { n: number }).n, 1);
    assert.ok((db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id=?").get(pending.runId) as { n: number }).n >= 1);
  });
  const expired = await f.get(run.runId); assert.equal(expired.status, 410);
  assert.equal((await expired.json() as { error: { code: string } }).error.code, "EVENT_WINDOW_EXPIRED");
  assert.deepEqual(await f.client.run(run.runId), terminal);
  const final = await f.get(run.runId, "?afterSequence=" + (terminal.lastSequence - 1));
  const frames = []; for await (const event of readEvents(final.body!)) frames.push(event);
  assert.equal(frames.length, 1); assert.equal(frames[0]!.type, "run.completed");
  assert.equal((await f.get(run.runId, "?afterSequence=" + terminal.lastSequence)).status, 204);
});

test("S08/A02：四连接上限、注销关闭全部连接且拒绝重连", async t => {
  const f = await network(t), run = await f.submit();
  const streams = await Promise.all(Array.from({ length: 4 }, () => rawStream(f.origin + "/api/v1/runs/" + run.runId + "/events", f.headers)));
  streams.forEach(s => { s.resume(); t.after(() => s.destroy()); });
  assert.equal(f.events.diagnostics.connections, 4);
  const excess = await f.get(run.runId); assert.equal(excess.status, 429); await excess.body?.cancel();
  const logout = await fetch(f.origin + "/api/v1/auth/logout", { method: "POST", headers: f.headers, body: "{}" }); assert.equal(logout.status, 204);
  await until(() => f.events.diagnostics.connections === 0 && streams.every(s => s.destroyed), 1000);
  const retry = await f.get(run.runId); assert.equal(retry.status, 401); await retry.body?.cancel();
  assert.equal(f.gate.calls[0]!.signal.aborted, false);
});

test("S08/A02：首连与注释心跳均不刷新闲置时间，闲置及绝对过期关闭流", async t => {
  for (const column of ["last_seen_at", "expires_at"] as const) {
    const f = await network(t), run = await f.submit(), old = Date.now() - 120000;
    inspect(f.root, db => db.prepare("UPDATE auth_sessions SET last_seen_at=?").run(old));
    const stream = await rawStream(f.origin + "/api/v1/runs/" + run.runId + "/events", f.headers); t.after(() => stream.destroy());
    let text = ""; stream.on("data", chunk => { text += chunk; });
    await until(() => text.includes(": heartbeat"));
    inspect(f.root, db => assert.equal((db.prepare("SELECT last_seen_at AS value FROM auth_sessions").get() as { value: number }).value, old));
    inspect(f.root, db => db.prepare("UPDATE auth_sessions SET " + column + "=?").run(Date.now() - (column === "last_seen_at" ? 86400001 : 1)));
    await until(() => stream.destroyed && f.events.diagnostics.connections === 0, 1000);
  }
});

test("S08：错误归属、非法存储事件和隐藏正文不会进入SSE", async t => {
  const f = await network(t), run = await f.submit();
  assert.throws(() => f.storage.eventAccess().read("other-owner", run.runId, 0), (e: unknown) => e instanceof ApplicationError && e.code === "NOT_FOUND");
  f.gate.calls[0]!.push({ type: "text_delta", text: "synthetic-hidden-marker" });
  await until(() => f.api.queries.run("owner-a", run.runId).lastSequence >= 3);
  inspect(f.root, db => db.prepare("UPDATE messages SET visibility='suppressed' WHERE id=?").run(run.replyId));
  const response = await f.get(run.runId, "?afterSequence=2");
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /synthetic-hidden-marker/);
  inspect(f.root, db => db.prepare("UPDATE messages SET visibility='visible' WHERE id=?").run(run.replyId));
  inspect(f.root, db => db.prepare("UPDATE run_events SET payload_json=json_set(payload_json,'$.private','synthetic-private-marker') WHERE run_id=? AND seq=3").run(run.runId));
  const invalid = await f.get(run.runId, "?afterSequence=2"); assert.equal(invalid.status, 500);
  assert.doesNotMatch(await invalid.text() + f.logs(), /synthetic-private-marker|synthetic-hidden-marker/);
});

test("S05：真实暂停接收产生背压，输出有界且断开不停止生成", { timeout: 20000 }, async t => {
  const f = await network(t), run = await f.submit(), n = 50000;
  // 仅本测试新建库：构造合法小增量长序列，填满真实系统的 socket 缓冲。
  inspect(f.root, db => db.transaction(() => {
    const insert = db.prepare("INSERT INTO run_events(run_id,seq,type,payload_json,created_at) VALUES(?,?,'reply.delta',?,?)");
    for (let i = 0; i < n; i++) insert.run(run.runId, i + 3, JSON.stringify({ runId: run.runId, sequence: i + 3, type: "reply.delta", occurredAt: new Date().toISOString(), replyId: run.replyId, text: "x", revision: i + 3 }), Date.now());
    db.prepare("UPDATE runs SET last_event_seq=? WHERE id=?").run(n + 2, run.runId);
    db.prepare("UPDATE messages SET content=?,updated_revision=? WHERE id=?").run("x".repeat(n), n + 2, run.replyId);
    db.prepare("UPDATE conversations SET change_revision=? WHERE id='conversation-a'").run(n + 2);
  })());
  const stream = await rawStream(f.origin + "/api/v1/runs/" + run.runId + "/events", f.headers); t.after(() => stream.destroy()); stream.pause();
  await until(() => f.events.diagnostics.backpressureClosures > 0, 15000);
  assert.ok(f.events.diagnostics.peakWritableBytes <= 256 * 1024);
  assert.equal(f.events.diagnostics.connections, 0); assert.equal(f.gate.calls[0]!.signal.aborted, false);
  await f.finish("末尾"); await until(() => f.api.queries.run("owner-a", run.runId).status === "completed");
  assert.equal((await f.client.run(run.runId)).reply!.content, "x".repeat(n) + "末尾");
});

test("S05：单帧超预算关闭连接，快照保留大段回复", async t => {
  const f = await network(t, { maxBytes: 1024 }), run = await f.submit();
  const stream = await rawStream(f.origin + "/api/v1/runs/" + run.runId + "/events", f.headers); stream.resume(); t.after(() => stream.destroy());
  await f.finish("合".repeat(1000)); await until(() => stream.destroyed && f.events.diagnostics.connections === 0);
  await until(() => f.api.queries.run("owner-a", run.runId).status === "completed");
  assert.equal((await f.client.run(run.runId)).reply!.content.length, 1000);
  assert.ok(f.events.diagnostics.peakWritableBytes <= 1024);
});

test("S05/S08：关服清理长连接，事务回滚不通知，提交才通知", async t => {
  const f = await network(t), run = await f.submit(); await delay(5);
  let wakes = 0; const stop = f.storage.subscribeCommits(() => { wakes++; });
  assert.throws(() => f.storage.write("owner-a", () => { throw new Error("synthetic-rollback"); }));
  await delay(5); assert.equal(wakes, 0);
  f.storage.write("owner-a", repo => repo.createConversation("wake", "character-a", "合成", Date.now()));
  await delay(5); assert.equal(wakes, 1); stop();
  const stream = await rawStream(f.origin + "/api/v1/runs/" + run.runId + "/events", f.headers); stream.resume(); t.after(() => stream.destroy());
  await f.app.close(); await until(() => stream.destroyed);
  assert.equal(f.app.server.listening, false); assert.equal(f.events.diagnostics.connections, 0);
});

test("S08：失败事件使用统一安全错误，存储原始错误正文不外露", async t => {
  const f = await network(t), run = await f.submit();
  f.gate.calls[0]!.end(); await until(() => f.api.queries.run("owner-a", run.runId).status === "failed");
  inspect(f.root, db => db.prepare("UPDATE run_events SET payload_json=json_set(payload_json,'$.code','synthetic-private-code','$.message','synthetic-private-error') WHERE run_id=? AND type='run.failed'").run(run.runId));
  const response = await f.get(run.runId), text = await response.text(); assert.equal(response.status, 200);
  assert.match(text, /INTERNAL_ERROR/); assert.doesNotMatch(text + f.logs(), /synthetic-private-code|synthetic-private-error/);
});

test("S05：write返回true但终态未写完时，仍保留连接额度并受超时约束", async t => {
  const f = await network(t), run = await f.submit(); await f.finish();
  await until(() => f.api.queries.run("owner-a", run.runId).status === "completed");
  const snapshot = await f.client.run(run.runId);
  const manager = new EventStreams(f.storage.eventAccess(), wake => f.storage.subscribeCommits(wake), f.api.sessions, f.clock, { backpressureMs: 25 });
  t.after(() => manager.close());
  class Stalled extends EventEmitter {
    writableLength = 0; destroyed = false; ended = false;
    socket = { setTimeout() {} };
    writeHead() {} flushHeaders() {}
    write(text: string, _callback: (error?: Error | null) => void) { this.writableLength = Buffer.byteLength(text); return true; }
    destroy() { this.destroyed = true; this.emit("close"); }
    end() { this.ended = true; this.emit("finish"); }
  }
  const raw = new Stalled(), reply = { raw, hijack() {} } as unknown as FastifyReply;
  const session = f.api.sessions.authenticate(f.headers.cookie.split("=")[1], false, false);
  manager.open(session, run.runId, snapshot.lastSequence - 1, reply);
  assert.equal(manager.diagnostics.connections, 1); assert.equal(raw.ended, false);
  await until(() => raw.destroyed);
  assert.equal(manager.diagnostics.connections, 0); assert.equal(manager.diagnostics.backpressureClosures, 1);
});
