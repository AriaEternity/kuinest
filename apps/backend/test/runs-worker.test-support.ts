import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "../dist/conversations/worker.js";
import { fixture, harness, controlled, until, inspect } from "./run-fixtures.js";
import type { ProviderAdapter } from "../dist/ports.js";

test("R04：worker全局单生成，完成A之后才调用B并固定上下文", async t => {
  const gate = controlled(), h = harness(t, gate.provider);
  const a = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "输入A" });
  const b = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "输入B" });
  await until(() => gate.calls.length === 1);
  assert.deepEqual(gate.calls[0]!.request.messages.map(m => m.content), ["输入A"]);
  gate.calls[0]!.push({ type: "text_delta", text: "回复A" }); gate.calls[0]!.push({ type: "finish", reason: "stop" }); gate.calls[0]!.end();
  await until(() => gate.calls.length === 2);
  assert.equal(h.api.queries.run("owner-a", a.runId).status, "completed");
  assert.deepEqual(gate.calls[1]!.request.messages.map(m => m.content), ["输入A", "回复A", "输入B"]);
  gate.calls[1]!.push({ type: "text_delta", text: "回复B" }); gate.calls[1]!.push({ type: "finish", reason: "stop" }); gate.calls[1]!.end();
  await until(() => h.api.queries.run("owner-a", b.runId).status === "completed");
  assert.equal(gate.maximum(), 1);
});
test("R03：没有内存通知的已提交任务仍由数据库扫描执行", async t => {
  const h = harness(t);
  const receipt = h.f.submit("跳过通知的合成输入");
  await until(() => h.api.queries.run("owner-a", receipt.runId).status === "completed");
  assert.match(h.api.queries.run("owner-a", receipt.runId).reply!.content, /合成演示/);
});
test("R06：断流保留partial和失败事实，失败输入在后续上下文里", async t => {
  const gate = controlled(), h = harness(t, gate.provider), first = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "失败前输入" });
  await until(() => gate.calls.length === 1);
  gate.calls[0]!.push({ type: "text_delta", text: "已收到部分" }); gate.calls[0]!.end();
  await until(() => h.api.queries.run("owner-a", first.runId).status === "failed");
  const result = h.api.queries.run("owner-a", first.runId);
  assert.equal(result.error!.code, "UPSTREAM_INCOMPLETE"); assert.equal(result.reply!.content, "已收到部分"); assert.equal(result.reply!.status, "partial");
  h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "后续输入" });
  await until(() => gate.calls.length === 2);
  assert.deepEqual(gate.calls[1]!.request.messages.map(m => m.content), ["失败前输入", "后续输入"]);
});
test("R05：running取消在无新输出时也终结，忽略取消之后的增量", async t => {
  const gate = controlled(), h = harness(t, gate.provider), receipt = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "合成取消" });
  await until(() => gate.calls.length === 1);
  gate.calls[0]!.push({ type: "text_delta", text: "保留部分" });
  await until(() => h.api.queries.run("owner-a", receipt.runId).reply!.content === "保留部分");
  const before = h.api.queries.run("owner-a", receipt.runId).reply!.revision;
  const accepted = h.runs.cancel("owner-a", receipt.runId); assert.equal(accepted.run.status, "running");
  gate.calls[0]!.push({ type: "text_delta", text: "禁止内容" });
  await until(() => h.api.queries.run("owner-a", receipt.runId).status === "cancelled");
  const result = h.api.queries.run("owner-a", receipt.runId);
  assert.equal(result.reply!.content, "保留部分"); assert.ok(result.reply!.revision > before); assert.equal(gate.active(), 0);
});
test("R05：不依赖内存abort通知，持久取消标志由运行检查发现", async t => {
  const gate = controlled(), h = harness(t, gate.provider), receipt = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "合成" });
  await until(() => gate.calls.length === 1);
  h.f.store.cancel("owner-a", receipt.runId, h.f.clock.now(), h.f.ids);
  await until(() => h.api.queries.run("owner-a", receipt.runId).status === "cancelled");
  assert.equal(gate.calls[0]!.signal.aborted, true);
});
test("R06：整体运行超时会终结、停止适配器并保留受控错误", async t => {
  const gate = controlled(), h = harness(t, gate.provider, { timeoutMs: 80 }), receipt = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "超时合成" });
  await until(() => h.api.queries.run("owner-a", receipt.runId).status === "failed");
  assert.equal(h.api.queries.run("owner-a", receipt.runId).error!.code, "RUN_TIMEOUT"); assert.equal(gate.active(), 0);
});
test("R06：不响应abort的适配器使worker停止，不与下一任务重叠", async t => {
  let calls = 0;
  const stuck: ProviderAdapter = { stream() { calls++; const iterator: AsyncIterableIterator<never> = { [Symbol.asyncIterator]() { return this; }, next() { return new Promise<IteratorResult<never>>(() => {}); }, return() { return new Promise<IteratorResult<never>>(() => {}); } }; return iterator; } };
  const h = harness(t, stuck, { timeoutMs: 50, abortDrainMs: 20 });
  const first = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "卡住" });
  const second = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "保持排队" });
  await until(() => !h.runs.ready);
  assert.equal(calls, 1); assert.equal(h.api.queries.run("owner-a", first.runId).status, "failed"); assert.equal(h.api.queries.run("owner-a", second.runId).status, "accepted");
  assert.equal((await h.app.inject("/health/ready")).statusCode, 503);
});
test("R06：正常关服终结活动运行但保留accepted，清理轮询和适配器", async t => {
  const gate = controlled(), h = harness(t, gate.provider), a = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "活动" });
  const b = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "待处理" });
  await until(() => gate.calls.length === 1); gate.calls[0]!.push({ type: "text_delta", text: "保存部分" });
  await until(() => h.api.queries.run("owner-a", a.runId).reply!.content === "保存部分");
  await h.app.close(); assert.equal(gate.active(), 0); assert.equal(h.runs.ready, false);
  inspect(h.f.root, db => {
    assert.deepEqual(db.prepare("SELECT status,error_code FROM runs WHERE id=?").get(a.runId), { status: "failed", error_code: "RUN_INTERRUPTED" });
    assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(b.runId) as { status: string }).status, "accepted");
  });
  await delay(40); assert.equal(gate.calls.length, 1);
});
test("R06：恢复先于worker领取，不重放旧running或completed，只处理accepted", async t => {
  const f = fixture(t), a = f.submit("中断输入"), b = f.submit("保留排队"), claim = f.store.claim(f.clock.now(), f.ids)!;
  f.store.append(claim, "旧部分", f.clock.now()); await f.reopen();
  const gate = controlled(), worker = new Worker(f.store, gate.provider, f.clock, f.ids, { pollMs: 20, abortDrainMs: 20 }); f.cleanup(() => worker.close()); worker.start();
  await until(() => gate.calls.length === 1);
  assert.deepEqual(gate.calls[0]!.request.messages.map(m => m.content), ["中断输入", "保留排队"]);
  inspect(f.root, db => {
    assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(a.runId) as { status: string }).status, "failed");
    assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(b.runId) as { status: string }).status, "running");
  });
});
test("R06：length、空回复、内部reasoning和工具调用不冒充成功", async t => {
  for (const [events, expected] of [
    [[{ type: "text_delta", text: "partial" }, { type: "finish", reason: "length" }], "OUTPUT_LIMIT"],
    [[{ type: "finish", reason: "stop" }], "EMPTY_REPLY"],
    [[{ type: "reasoning_delta", text: "synthetic-hidden-marker" }], "UPSTREAM_INCOMPLETE"],
    [[{ type: "tool_call_delta", index: 0, arguments: "synthetic-tool-marker" }], "UPSTREAM_INCOMPLETE"],
    [[{ type: "text_delta", text: "x".repeat(128 * 1024 + 1) }], "OUTPUT_LIMIT"],
  ] as const) {
    const provider: ProviderAdapter = { async *stream() { for (const event of events) yield event; } };
    const h = harness(t, provider), result = h.runs.submit("owner-a", "conversation-a", { clientMessageId: crypto.randomUUID(), text: "合成" });
    await until(() => h.api.queries.run("owner-a", result.runId).status === "failed");
    const snapshot = h.api.queries.run("owner-a", result.runId);
    assert.equal(snapshot.error!.code, expected); assert.doesNotMatch(JSON.stringify(snapshot) + h.logs(), /synthetic-hidden-marker|synthetic-tool-marker/);
  }
});
test("R09：超过最小合成上下文预算会明确失败，输入仍可恢复", async t => {
  const f = fixture(t), result = f.submit();
  // 从零造长链，不读取或复制角色资料；具体压缩编排留在07。
  inspect(f.root, db => {
    db.exec("INSERT INTO branches(id,conversation_id,reason,created_at) VALUES('long','conversation-a','synthetic',1)");
    let previous: string | null = null;
    for (let i = 0; i < 256; i++) { const id = "entry-" + i; db.prepare("INSERT INTO context_entries(id,conversation_id,branch_id,parent_id,kind,payload_json,created_at) VALUES(?,'conversation-a','long',?,'message','{\"role\":\"user\",\"content\":\"合成\"}',1)").run(id, previous); previous = id; }
    db.prepare("UPDATE branches SET head_entry_id=? WHERE id='long'").run(previous); db.exec("UPDATE conversations SET active_branch_id='long'");
  });
  let calls = 0; const provider: ProviderAdapter = { async *stream() { calls++; yield { type: "finish", reason: "stop" }; } };
  const worker = new Worker(f.store, provider, f.clock, f.ids); f.cleanup(() => worker.close()); worker.start();
  await until(() => inspect(f.root, db => (db.prepare("SELECT status FROM runs").get() as { status: string }).status) === "failed");
  assert.equal(calls, 0);
  inspect(f.root, db => { assert.equal((db.prepare("SELECT error_code FROM runs WHERE id=?").get(result.runId) as { error_code: string }).error_code, "CONTEXT_TOO_LARGE"); assert.ok((db.prepare("SELECT context_user_entry_id FROM runs").get() as { context_user_entry_id: string }).context_user_entry_id); });
});
