import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { readContract, allSchemas, type RunEvent, type RunSnapshot } from "@kuinest/contracts";
import { Ajv } from "ajv";
import { ChatClient, SseParser, RunState, ConversationState, readEvents } from "../../../packages/chat-client/dist/index.js";
import { network, until, inspect } from "./stream-fixtures.js";

const at = "2026-09-09T00:00:00.000Z";
const snapshot = (): RunSnapshot => ({ runId: "run", origin: "user", conversationId: "conv", status: "running", lastSequence: 2, reply: { id: "reply", runId: "run", conversationId: "conv", role: "assistant", content: "", status: "partial", revision: 2, createdAt: at } });
const delta = (text = "中文🙂", sequence = 3, revision = 3): RunEvent => ({ runId: "run", sequence, occurredAt: at, type: "reply.delta", replyId: "reply", text, revision });
const frame = (event: RunEvent, eol = "\n") => ["id: " + event.sequence, "event: " + event.type, "data: " + JSON.stringify(event), "", ""].join(eol);

test("S01：逐字节 UTF-8、CRLF/CR/LF、BOM、注释、多行data和未完成帧", () => {
  for (const eol of ["\n", "\r", "\r\n"]) {
    const parser = new SseParser(), found: RunEvent[] = [], event = delta();
    for (const byte of new TextEncoder().encode("\ufeff: 注释" + eol + eol + frame(event, eol))) found.push(...parser.push(Uint8Array.of(byte)));
    parser.end(); assert.deepEqual(found, [event]);
  }
  const event = delta(), parser = new SseParser();
  const multiline = frame(event).replace(',"text":', ',\ndata: "text":');
  assert.deepEqual([...parser.push(new TextEncoder().encode(multiline))], [event]);
  const unfinished = new SseParser(); assert.deepEqual([...unfinished.push(new TextEncoder().encode(frame(event).slice(0, -1)))], []); unfinished.end();
});

test("S01：真实HTTP跨块发送中文与表情，客户端读取完整帧", async t => {
  const event = delta(), bytes = Buffer.from(frame(event, "\r\n"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    void (async () => { for (const byte of bytes) { res.write(Uint8Array.of(byte)); await delay(1); } res.end(); })();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch("http://127.0.0.1:" + address.port), events = [];
  for await (const item of readEvents(response.body!)) events.push(item);
  assert.deepEqual(events, [event]);
});

test("S01：拒绝超帧预算、非法UTF-8、ID错配和额外内部字段", () => {
  assert.throws(() => [...new SseParser(20).push(new TextEncoder().encode("data: " + "x".repeat(30)))], /STREAM_FRAME_TOO_LARGE/);
  assert.throws(() => [...new SseParser().push(Uint8Array.of(255))]);
  assert.throws(() => [...new SseParser().push(new TextEncoder().encode(frame(delta()).replace("id: 3", "id: 4")))], /STREAM_ENVELOPE_INVALID/);
  const invalid = frame(delta()).replace('"text":', '"reasoning_content":"synthetic-secret","text":');
  assert.throws(() => [...new SseParser().push(new TextEncoder().encode(invalid))], /PUBLIC_CONTRACT_INVALID/);
  const incomplete = new SseParser(); [...incomplete.push(Uint8Array.of(0xf0, 0x9f))]; assert.throws(() => incomplete.end());
});

test("S02/S09：消息revision与事件sequence分别去重，全文快照不重复拼接", () => {
  const state = new RunState(), full = snapshot(); full.lastSequence = 3; full.reply!.content = "已有"; full.reply!.revision = 8;
  state.reconcile(full); assert.equal(state.apply(delta("重复", 3, 3)), false);
  assert.equal(state.apply(delta("也重复", 4, 8)), true); assert.equal(state.value.reply!.content, "已有");
  assert.equal(state.apply(delta("新增", 5, 9)), true); assert.equal(state.value.reply!.content, "已有新增");
  const copy = state.value; copy.reply!.content = "外部篡改"; assert.equal(state.value.reply!.content, "已有新增");
  state.reconcile(snapshot()); assert.equal(state.value.lastSequence, 5);
  assert.throws(() => state.apply(delta("缺口", 7, 10)), /STREAM_SEQUENCE_GAP/);
  assert.throws(() => state.apply({ ...delta(), runId: "other" }), /RUN_IDENTITY_INVALID/);
});

test("S06：真实EOF后查快照确认失败，部分回复始终不被标为完成", async t => {
  let reads = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/events")) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(frame(delta("半条"))); return; }
    const value = snapshot(); reads++;
    if (reads > 1) { value.status = "failed"; value.lastSequence = 4; value.reply!.content = "半条"; value.reply!.revision = 4; value.error = { code: "UPSTREAM_INCOMPLETE", message: "合成中断" }; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = new ChatClient("http://127.0.0.1:" + address.port + "/api/v1");
  const states = []; for await (const state of client.watch("run", { signal: AbortSignal.timeout(4000) })) states.push(state);
  assert.equal(reads, 2); assert.equal(states.at(-1)!.status, "failed"); assert.equal(states.at(-1)!.reply!.content, "半条");
  assert.ok(states.every(s => s.status !== "completed" && s.reply!.status === "partial"));
});

test("S04：客户端410自动获取同一快照全文与终态", async t => {
  const f = await network(t), run = await f.submit(), initial = await f.client.run(run.runId);
  await f.finish("清理后全文"); await until(() => f.api.queries.run("owner-a", run.runId).status === "completed");
  inspect(f.root, db => db.prepare("UPDATE runs SET finished_at=? WHERE id=?").run(Date.now() - 8 * 86400000, run.runId));
  f.storage.eventAccess().prune(Date.now());
  const states = []; for await (const state of f.client.watch(run.runId, { initial, signal: AbortSignal.timeout(5000), retryMs: 1 })) states.push(state);
  assert.equal(states.at(-1)!.status, "completed"); assert.equal(states.at(-1)!.reply!.content, "清理后全文");
});

test("S07/S09：新设备旧历史通过runId加载新快照，再接增量不漏字", async t => {
  const f = await network(t), run = await f.submit(), conversation = new ConversationState("conversation-a");
  conversation.history(await f.client.history("conversation-a", { limit: 1 }));
  const oldReply = conversation.items[0]!; assert.equal(oldReply.runId, run.runId); assert.equal(oldReply.content, "");
  f.gate.calls[0]!.push({ type: "text_delta", text: "历史之后" });
  await until(() => f.api.queries.run("owner-a", run.runId).reply!.content === "历史之后");
  const watching = f.client.watch(oldReply.runId!, { signal: AbortSignal.timeout(5000) }), first = (await watching.next()).value!;
  assert.equal(first.reply!.content, "历史之后"); conversation.upsert(first.reply!);
  const rest = (async () => { for await (const value of watching) conversation.upsert(value.reply!); })();
  await f.finish("续接"); await rest;
  await f.client.sync(conversation);
  const final = conversation.items.find(m => m.id === run.replyId)!;
  assert.equal(final.content, "历史之后续接"); assert.equal(final.status, "complete");
  inspect(f.root, db => assert.equal((db.prepare("SELECT seq FROM messages WHERE id=?").get(run.replyId) as { seq: number }).seq, 2));
});

test("S07：加载旧历史不跳过新changes，重复和乱序投影不会覆盖新版", async t => {
  const f = await network(t), run = await f.submit(), state = new ConversationState("conversation-a");
  const newest = await f.client.history("conversation-a", { limit: 1 }); state.history(newest); const baseline = state.revision;
  await f.finish("占位变完整"); await until(() => f.api.queries.run("owner-a", run.runId).status === "completed");
  const older = await f.client.history("conversation-a", { cursor: newest.nextCursor!, limit: 1 }); state.history(older);
  assert.equal(state.revision, baseline); await f.client.sync(state);
  const final = state.items.find(m => m.id === run.replyId)!; assert.equal(final.status, "complete");
  state.history(newest); assert.equal(state.items.find(m => m.id === run.replyId)!.revision, final.revision);
  const before = state.revision; await f.client.sync(state); assert.equal(state.revision, before);
});

test("S09：失败和取消在文字未变时仍推进revision并通过changes发现", async t => {
  for (const status of ["failed", "cancelled"] as const) {
    const f = await network(t), run = await f.submit();
    f.gate.calls[0]!.push({ type: "text_delta", text: "保留部分" });
    await until(() => f.api.queries.run("owner-a", run.runId).reply!.content === "保留部分");
    const before = await f.client.run(run.runId), history = new ConversationState("conversation-a"); history.history(await f.client.history("conversation-a"));
    if (status === "cancelled") f.runs.cancel("owner-a", run.runId); else f.gate.calls[0]!.end();
    await until(() => f.api.queries.run("owner-a", run.runId).status === status);
    const current = await f.client.run(run.runId); assert.equal(current.reply!.content, before.reply!.content);
    assert.ok(current.reply!.revision > before.reply!.revision); assert.equal(current.reply!.status, "partial");
    await f.client.sync(history); assert.equal(history.items.find(m => m.id === run.replyId)!.revision, current.reply!.revision);
  }
});

test("公开运行时校验与现有Ajv合同一致，拒绝深层多余字段与非法整数", () => {
  const validator = new Ajv({ strict: true, allErrors: false }); allSchemas.forEach(schema => validator.addSchema(schema));
  const cases: [Parameters<typeof readContract>[0], unknown][] = [
    ["runEvent", delta()], ["runEvent", { ...delta(), sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ["runSnapshot", snapshot()], ["runSnapshot", { ...snapshot(), reply: { ...snapshot().reply, internal: "synthetic" } }],
    ["historyPage", { items: [snapshot().reply], nextCursor: null, revision: 2 }],
    ["messageChanges", { items: [], throughRevision: 0, hasMore: false }],
    ["messageChanges", { items: [], throughRevision: -1, hasMore: false }],
  ];
  for (const [name, value] of cases) {
    const ajvResult = validator.getSchema("urn:kuinest:0.3:" + name)!(value);
    let result = true; try { readContract(name, value); } catch { result = false; }
    assert.equal(result, ajvResult, name);
  }
});

test("S04：超前的客户端游标收到400后，用真实快照重新建立基线", async t => {
  const f = await network(t), run = await f.submit(), initial = await f.client.run(run.runId);
  initial.lastSequence = 99999; initial.reply!.revision = 99999; initial.reply!.content = "失效本地基线";
  await f.finish("真实合成全文"); await until(() => f.api.queries.run("owner-a", run.runId).status === "completed");
  const states = []; for await (const state of f.client.watch(run.runId, { initial, signal: AbortSignal.timeout(5000), retryMs: 1 })) states.push(state);
  assert.equal(states.at(-1)!.status, "completed"); assert.equal(states.at(-1)!.reply!.content, "真实合成全文");
  assert.ok(states.at(-1)!.lastSequence < 99999);
});

test("S08：客户端收到401停止重连，取消订阅信号不取消后台运行", async t => {
  const f = await network(t), run = await f.submit(), controller = new AbortController();
  const watching = f.client.watch(run.runId, { signal: controller.signal });
  await watching.next();
  const pending = watching.next(); await until(() => f.events.diagnostics.connections === 1);
  controller.abort(); await assert.rejects(pending);
  await until(() => f.events.diagnostics.connections === 0); assert.equal(f.gate.calls[0]!.signal.aborted, false);
  const again = f.client.watch(run.runId, { signal: AbortSignal.timeout(5000) }); await again.next();
  const logout = await fetch(f.origin + "/api/v1/auth/logout", { method: "POST", headers: f.headers, body: "{}" }); assert.equal(logout.status, 204);
  await assert.rejects(again.next(), (e: unknown) => e instanceof Error && e.message === "HTTP_401");
});

test("S07：会话变更可发现合成主动回复；静默终态只公开无正文事件", async t => {
  const f = await network(t), conversation = new ConversationState("conversation-a");
  conversation.history(await f.client.history("conversation-a"));
  for (const [index, visibility] of ["visible", "suppressed"].entries()) {
    const id = "synthetic-heartbeat-" + index, replyId = "synthetic-heartbeat-reply-" + index;
    inspect(f.root, db => db.transaction(() => {
      const now = Date.now(), seq = index + 1;
      db.prepare("INSERT INTO messages(id,conversation_id,seq,role,content,status,visibility,updated_revision,created_at) VALUES(?,'conversation-a',?,'assistant',?,'complete',?,?,?)").run(replyId, seq, visibility === "visible" ? "合成主动回复" : "synthetic-hidden-candidate", visibility, seq, now);
      db.prepare("UPDATE conversations SET change_revision=?,next_public_seq=? WHERE id='conversation-a'").run(seq, seq + 1);
      db.prepare("INSERT INTO runs(id,conversation_id,origin,request_key,input_hash,reply_message_id,input_json,status,created_at,finished_at,last_event_seq) VALUES(?,'conversation-a','heartbeat',?,'synthetic',?,'{}','completed',?,?,1)").run(id, id, replyId, now, now);
      const reply = { id: replyId, runId: id, conversationId: "conversation-a", role: "assistant", content: "合成主动回复", status: "complete", revision: seq, createdAt: new Date(now).toISOString() };
      db.prepare("INSERT INTO run_events VALUES(?,1,'run.completed',?,?)").run(id, JSON.stringify({ runId: id, sequence: 1, type: "run.completed", occurredAt: new Date(now).toISOString(), ...(visibility === "visible" ? { reply } : {}) }), now);
    })());
    const response = await f.get(id); assert.equal(response.status, 200);
    const events = []; for await (const event of readEvents(response.body!)) events.push(event);
    assert.equal(events.length, 1); assert.doesNotMatch(JSON.stringify(events), /synthetic-hidden-candidate/);
    const state = new RunState(); state.reconcile(await f.client.run(id)); assert.equal(state.value.status, "completed");
  }
  await f.client.sync(conversation); assert.equal(conversation.items.length, 1); assert.equal(conversation.items[0]!.content, "合成主动回复");
  const meta = await fetch(f.origin + "/api/v1/meta", { headers: f.headers });
  const value = await meta.json() as { capabilities: { proactiveMessages: boolean; resumableEvents: boolean } };
  assert.equal(value.capabilities.proactiveMessages, false); assert.equal(value.capabilities.resumableEvents, true);
});
