import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import type { ProviderAdapter } from "../dist/ports.js";
import type { ToolExecutor } from "../dist/providers/types.js";
import { DeepSeekProvider } from "../dist/providers/deepseek.js";
import { SyntheticTools } from "../dist/providers/synthetic-tools.js";
import { mockProvider } from "../dist/providers/mock.js";
import { projectRoot } from "../dist/server.js";
import { fixture, harness, model, reply, chunk, done, until, inspect, isCode } from "./provider-fixtures.js";
function calls(root: string, runId: string) {
  return inspect(root, db => db.prepare("SELECT id,status,response_json AS response,request_manifest_json AS request FROM provider_calls WHERE run_id=? ORDER BY ordinal").all(runId)) as { id: string; status: string; response: string; request: string }[];
}
function toolPacket(index: number, id: string, name: string, args: string) { return { index, id, type: "function", function: { name, arguments: args } }; }
function toolsReply(response: import("node:http").ServerResponse, tools: object[], content = "") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk({ reasoning_content: "synthetic-tool-reasoning", content, tool_calls: tools }) + chunk({}, "tool_calls") + done);
}

test("P01：worker完整归档，公开消息/SSE/日志不含私有协议；默认mock也归档", async t => {
  const m = await model(t, (_body, response) => reply(response, "公开合成回复", "synthetic-never-public"));
  const h = harness(t, m.provider), receipt = h.submit();
  await until(() => h.api.queries.run("owner-a", receipt.runId).status === "completed");
  const saved = calls(h.f.root, receipt.runId); assert.equal(saved.length, 1); assert.equal(saved[0]!.status, "completed");
  const archive = JSON.parse(saved[0]!.response); assert.equal(archive.assistant.reasoning_content, "synthetic-never-public"); assert.equal(archive.finish_reason, "stop");
  const origin = await h.app.listen({ host: "127.0.0.1", port: 0 }), headers = await h.headers();
  const stream = await fetch(origin + "/api/v1/runs/" + receipt.runId + "/events", { headers });
  const publicText = await stream.text() + JSON.stringify(h.api.queries.history("owner-a", "conversation-a", undefined, 50));
  assert.match(publicText, /公开合成回复/); assert.doesNotMatch(publicText + h.logs(), /synthetic-never-public|reasoning_content|tool_calls|request_manifest/);
  const other = harness(t, mockProvider, { tools: new SyntheticTools() }), synthetic = other.submit();
  await until(() => other.api.queries.run("owner-a", synthetic.runId).status === "completed");
  assert.equal(calls(other.f.root, synthetic.runId)[0]!.status, "completed");
});

test("P02/P03：交错工具分片按index配对，跨调用/跨用户轮完整reasoning回传，重开库可恢复", async t => {
  const m = await model(t, (_body, response, count) => {
    if (count === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chunk({ reasoning_content: "synthetic-r1", content: "前言", tool_calls: [
        toolPacket(1, "call-b", "synthetic_echo", '{"text":"'),
        toolPacket(0, "call-a", "synthetic_", '{"a":2,'),
      ] }) + chunk({ tool_calls: [
        { index: 0, function: { name: "add", arguments: '"b":3}' } },
        { index: 1, function: { arguments: '合成"}' } },
      ] }) + chunk({}, "tool_calls") + done);
    } else reply(response, count === 2 ? "结尾" : "下一轮", "synthetic-r" + count);
  });
  const h = harness(t, m.provider, { tools: new SyntheticTools() }), a = h.submit();
  await until(() => h.api.queries.run("owner-a", a.runId).status === "completed");
  assert.equal(h.api.queries.run("owner-a", a.runId).reply!.content, "前言结尾");
  const messages = m.requests[1]!.messages as Record<string, unknown>[];
  const assistant = messages.find(message => message.role === "assistant")!;
  assert.equal(assistant.reasoning_content, "synthetic-r1");
  assert.deepEqual(messages.filter(message => message.role === "tool").map(message => message.tool_call_id), ["call-a", "call-b"]);
  assert.equal(JSON.parse(messages.find(message => message.tool_call_id === "call-a")!.content as string).value, 5);
  const b = h.submit("另一次用户输入");
  await until(() => h.api.queries.run("owner-a", b.runId).status === "completed");
  assert.deepEqual((m.requests[2]!.messages as Record<string, unknown>[]).filter(message => message.role === "assistant").map(message => message.reasoning_content), ["synthetic-r1", "synthetic-r2"]);
  const before = calls(h.f.root, a.runId);
  await h.app.close(); await h.f.reopen();
  assert.deepEqual(calls(h.f.root, a.runId), before);
  h.f.submit("重启后输入"); const claim = h.f.store.claim(h.f.clock.now(), h.f.ids)!;
  const resumed = h.f.store.context(claim).messages;
  assert.deepEqual(resumed.filter(message => message.role === "assistant").map(message => message.reasoning_content), ["synthetic-r1", "synthetic-r2", "synthetic-r3"]);
  assert.equal(resumed.filter(message => message.role === "tool").length, 2);
  assert.ok(Object.isFrozen(resumed) && resumed.every(Object.isFrozen));
  const archivedTools = resumed.find(message => message.role === "assistant" && message.tool_calls)!.tool_calls as { function: object }[];
  assert.ok(Object.isFrozen(archivedTools) && archivedTools.every(tool => Object.isFrozen(tool) && Object.isFrozen(tool.function)));
});

test("P03：未知、非法参数和策略拒绝均形成配对错误结果，不执行外部操作", async t => {
  for (const [name, args, allowed, code] of [
    ["shell", '{"command":"synthetic-only"}', true, "TOOL_UNKNOWN"],
    ["synthetic_add", "{broken", true, "TOOL_ARGUMENTS_INVALID"],
    ["synthetic_add", '{"a":"2","b":3}', true, "TOOL_ARGUMENTS_INVALID"],
    ["synthetic_echo", '{"text":"合成"}', false, "TOOL_DENIED"],
  ] as const) {
    const m = await model(t, (_body, response, n) => n === 1 ? toolsReply(response, [toolPacket(0, "error-call", name, args)]) : reply(response));
    const h = harness(t, m.provider, { tools: new SyntheticTools(allowed) }), run = h.submit();
    await until(() => h.api.queries.run("owner-a", run.runId).status === "completed");
    const result = (m.requests[1]!.messages as Record<string, unknown>[]).find(message => message.role === "tool")!;
    assert.equal(result.tool_call_id, "error-call"); assert.equal(JSON.parse(result.content as string).error.code, code);
    inspect(h.f.root, db => assert.deepEqual(db.prepare("SELECT status FROM tool_calls WHERE run_id=?").get(run.runId), { status: "failed" }));
  }
});

test("P04/P06：length、缺DONE、坏JSON保留partial；reasoning-only记EMPTY_REPLY", async t => {
  for (const [body, expected, text] of [
    [chunk({ content: "部分" }) + chunk({}, "length") + done, "OUTPUT_LIMIT", "部分"],
    [chunk({ content: "部分" }) + chunk({}, "stop"), "UPSTREAM_INCOMPLETE", "部分"],
    [chunk({ content: "部分" }) + "data: {bad}\n\n", "UPSTREAM_INCOMPLETE", "部分"],
    [chunk({ reasoning_content: "synthetic-only-reasoning" }) + chunk({}, "stop") + done, "EMPTY_REPLY", ""],
  ] as const) {
    const m = await model(t, (_body, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(body); });
    const h = harness(t, m.provider), run = h.submit();
    await until(() => h.api.queries.run("owner-a", run.runId).status === "failed");
    const state = h.api.queries.run("owner-a", run.runId);
    assert.equal(state.error!.code, expected); assert.equal(state.reply!.content, text); assert.equal(state.reply!.status, "partial");
    assert.ok(calls(h.f.root, run.runId)[0]!.response);
  }
});

test("P05：HTTP失败归档安全代码及Retry-After，运行保持可查询且不重试", async t => {
  const m = await model(t, (_body, response) => { response.writeHead(429, { "retry-after": "9" }); response.end("synthetic-private-http-error"); });
  const h = harness(t, m.provider), run = h.submit(); await until(() => h.api.queries.run("owner-a", run.runId).status === "failed");
  const archive = calls(h.f.root, run.runId)[0]!; assert.equal(archive.status, "failed");
  assert.deepEqual(JSON.parse(archive.response).error, { code: "UPSTREAM_RATE_LIMIT", retryAfterSeconds: 9 });
  assert.equal(h.api.queries.run("owner-a", run.runId).error!.code, "UPSTREAM_RATE_LIMIT"); assert.equal(m.requests.length, 1);
  assert.doesNotMatch(archive.response + h.logs(), /synthetic-private-http-error/);
});

test("P07：最多8次模型调用，不执行无法继续的第8批工具", async t => {
  const m = await model(t, (_body, response, n) => toolsReply(response, [toolPacket(0, "loop-" + n, "synthetic_echo", '{"text":"合成"}')], "前言"));
  const h = harness(t, m.provider, { tools: new SyntheticTools() }), run = h.submit();
  await until(() => h.api.queries.run("owner-a", run.runId).status === "failed");
  assert.equal(h.api.queries.run("owner-a", run.runId).error!.code, "TOOL_LIMIT"); assert.equal(m.requests.length, 8);
  inspect(h.f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM tool_calls WHERE run_id=?").get(run.runId) as { n: number }).n, 7));
});

test("P07：每轮8个、全run16个工具上限均由持久事实限制", async t => {
  for (const scenario of ["per-call", "per-run"] as const) {
    const m = await model(t, (_body, response, n) => toolsReply(response, Array.from({ length: scenario === "per-call" ? 9 : n <= 2 ? 8 : 1 }, (_, index) => toolPacket(index, "limit-" + n + "-" + index, "synthetic_add", '{"a":1,"b":2}'))));
    const h = harness(t, m.provider, { tools: new SyntheticTools() }), run = h.submit();
    await until(() => h.api.queries.run("owner-a", run.runId).status === "failed");
    assert.equal(h.api.queries.run("owner-a", run.runId).error!.code, "TOOL_LIMIT");
    inspect(h.f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM tool_calls WHERE run_id=?").get(run.runId) as { n: number }).n, scenario === "per-call" ? 0 : 16));
  }
});

test("P07：16MiB归档总预算回滚超限检查点，manifest不保存未知配置字段", t => {
  const f = fixture(t), run = f.submit(), claim = f.store.claim(f.clock.now(), f.ids)!, store = f.storage.protocolAccess();
  const call = store.begin(claim, f.ids.next(), { ...f.store.context(claim), options: { mode: "synthetic", apiKey: "synthetic-secret-option" } }, f.clock.now());
  const partial = { assistant: { role: "assistant" as const, content: "", reasoning_content: "合成检查点" } };
  store.checkpoint(claim, call, partial, "started", f.clock.now());
  assert.throws(() => store.checkpoint(claim, call, { assistant: { role: "assistant", content: "", reasoning_content: "x".repeat(16 * 1024 * 1024) } }, "started", f.clock.now()), isCode("OUTPUT_LIMIT"));
  const row = calls(f.root, run.runId)[0]!; assert.deepEqual(JSON.parse(row.response), partial); assert.doesNotMatch(row.request, /synthetic-secret-option|apiKey/);
  store.checkpoint(claim, call, { ...partial, finish_reason: "stop", usage: { inputTokens: 1, outputTokens: 1, details: { synthetic: "x".repeat(16 * 1024 * 1024) } } }, "failed", f.clock.now());
  assert.deepEqual(JSON.parse(calls(f.root, run.runId)[0]!.response), { ...partial, error: { code: "OUTPUT_LIMIT" } });
  inspect(f.root, db => assert.deepEqual(db.prepare("SELECT status,finish_reason,usage_json FROM provider_calls WHERE id=?").get(call.id), { status: "failed", finish_reason: null, usage_json: null }));
});

test("P08：取消中断HTTP，迟到正文不提交，后续队列仍能运行", async t => {
  const m = await model(t, async (_body, response, n) => {
    if (n > 1) { reply(response, "后一请求"); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk({ reasoning_content: "synthetic-before-cancel", content: "取消前" }));
    await delay(150); if (!response.destroyed) response.end(chunk({ content: "synthetic-late" }) + chunk({}, "stop") + done);
  });
  const h = harness(t, m.provider), a = h.submit(), b = h.submit("排队消息");
  await until(() => h.api.queries.run("owner-a", a.runId).reply!.content === "取消前");
  h.runs.cancel("owner-a", a.runId);
  await until(() => h.api.queries.run("owner-a", b.runId).status === "completed");
  await delay(160);
  assert.equal(h.api.queries.run("owner-a", a.runId).status, "cancelled");
  assert.equal(h.api.queries.run("owner-a", a.runId).reply!.content, "取消前");
  assert.equal(calls(h.f.root, a.runId)[0]!.status, "unknown"); assert.doesNotMatch(calls(h.f.root, a.runId)[0]!.response, /synthetic-late/);
  assert.equal(h.runs.ready, true);
});

test("P08：不退出的合成工具使worker停止，取消后的结果不落盘", async t => {
  let finish: ((value: Awaited<ReturnType<ToolExecutor["invoke"]>>) => void) | undefined;
  const tools: ToolExecutor = { definitions: new SyntheticTools().definitions, invoke() { return new Promise(resolve => { finish = resolve; }); } };
  const m = await model(t, (_body, response) => toolsReply(response, [toolPacket(0, "held", "synthetic_echo", '{"text":"合成"}')]));
  const h = harness(t, m.provider, { tools, abortDrainMs: 15 }), run = h.submit();
  await until(() => !!finish); h.runs.cancel("owner-a", run.runId);
  await until(() => !h.runs.ready);
  finish!({ message: { role: "tool", tool_call_id: "held", content: "synthetic-late-result" }, failed: false });
  await delay(30);
  inspect(h.f.root, db => assert.deepEqual(db.prepare("SELECT status,result_json FROM tool_calls WHERE run_id=?").get(run.runId), { status: "unknown", result_json: null }));
  assert.equal(m.requests.length, 1);
});

test("P07：整个worker总时限独立于上游字节活动", async t => {
  const m = await model(t, async (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    while (!response.destroyed) { response.write(": active\n\n"); await delay(10); }
  });
  const h = harness(t, m.provider, { timeoutMs: 70 }), run = h.submit();
  await until(() => h.api.queries.run("owner-a", run.runId).status === "failed");
  assert.equal(h.api.queries.run("owner-a", run.runId).error!.code, "RUN_TIMEOUT");
});

test("P03/P08：重复工具结果不再执行，取消与错误owner阻止归档写入", t => {
  const f = fixture(t), run = f.submit(), claim = f.store.claim(f.clock.now(), f.ids)!, store = f.storage.protocolAccess();
  const call = store.begin(claim, f.ids.next(), f.store.context(claim), f.clock.now());
  const tool = { id: "synthetic-tool", type: "function" as const, function: { name: "synthetic_add", arguments: '{"a":1,"b":2}' } };
  store.checkpoint(claim, call, { assistant: { role: "assistant", content: "", reasoning_content: "合成", tool_calls: [tool] }, finish_reason: "tool_calls" }, "completed", f.clock.now());
  const entry = store.beginTool(claim, call, f.ids.next(), tool, f.clock.now());
  const result = { role: "tool" as const, tool_call_id: tool.id, content: '{"ok":true,"value":3}' };
  store.finishTool(claim, entry.id, result, false, f.clock.now());
  assert.deepEqual(store.beginTool(claim, call, f.ids.next(), tool, f.clock.now()), { id: entry.id, result });
  assert.throws(() => store.begin({ ...claim, ownerId: "other" }, f.ids.next(), f.store.context(claim), f.clock.now()), isCode("NOT_FOUND"));
  f.store.cancel("owner-a", run.runId, f.clock.now(), f.ids);
  assert.throws(() => store.beginTool(claim, call, f.ids.next(), tool, f.clock.now()), isCode("SERVICE_NOT_READY"));
});

test("P02/P08：真实子进程中断保留provider/tool档案，重启标未知且不重跑旧请求", async t => {
  for (const mode of ["provider", "tool"]) {
    const f = fixture(t), run = f.submit(); await f.storage.close();
    const child = fork(join(projectRoot, "apps/backend/dist-test/provider-crash-child.js"), [f.root, String(f.clock.now()), mode], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { if (child.exitCode === null && !child.killed) child.kill(); });
    const message = await once(child, "message", { signal: AbortSignal.timeout(5000) }); assert.deepEqual(message[0], { status: "persisted" });
    const exited = once(child, "exit"); child.kill(); await exited;
    await f.reopen(30000); assert.equal(f.store.recover(f.clock.now(), f.ids), 1);
    inspect(f.root, db => {
      assert.deepEqual(db.prepare("SELECT status,error_code FROM runs WHERE id=?").get(run.runId), { status: "failed", error_code: "RUN_INTERRUPTED" });
      const archived = calls(f.root, run.runId)[0]!; assert.equal(archived.status, mode === "provider" ? "unknown" : "completed");
      assert.match(archived.response, /synthetic-crash-reasoning/);
      if (mode === "tool") assert.deepEqual(db.prepare("SELECT status,result_json FROM tool_calls WHERE run_id=?").get(run.runId), { status: "unknown", result_json: null });
    });
    assert.equal(f.store.claim(f.clock.now(), f.ids), undefined);
  }
});


test("P07：超32KiB工具结果不落盘，不继续模型循环，运行保持可查询失败", async t => {
  const m = await model(t, (_body, response) => toolsReply(response, [toolPacket(0, "large-result", "synthetic_echo", '{"text":"合成"}')]));
  const tools: ToolExecutor = { definitions: new SyntheticTools().definitions, async invoke(tool) {
    return { message: { role: "tool", tool_call_id: tool.id, content: "x".repeat(32 * 1024) }, failed: false };
  } };
  const h = harness(t, m.provider, { tools }), receipt = h.submit();
  await until(() => h.api.queries.run("owner-a", receipt.runId).status === "failed");
  assert.equal(h.api.queries.run("owner-a", receipt.runId).error!.code, "OUTPUT_LIMIT"); assert.equal(m.requests.length, 1);
  inspect(h.f.root, db => assert.deepEqual(db.prepare("SELECT status,result_json FROM tool_calls WHERE run_id=?").get(receipt.runId), { status: "unknown", result_json: null }));
});

test("P09：关闭及服务商默认策略跨工具轮固定，重开库保留准确manifest与实际收到的思考", async t => {
  for (const thinking of ["disabled", "provider-default"] as const) {
    const m = await model(t, (_body, response, count) => {
      if (count === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(chunk({ tool_calls: [toolPacket(0, "policy-tool", "synthetic_echo", '{"text":"合成"}')] }) + chunk({}, "tool_calls") + done);
      } else reply(response, "合成策略答复", "synthetic-archive-even-if-disabled");
    });
    const provider = new DeepSeekProvider({ ...m.profile, thinking, maxTokens: 8192 }, () => { throw Error("不得读取凭据"); });
    const h = harness(t, provider, { tools: new SyntheticTools() }), a = h.submit();
    await until(() => h.api.queries.run("owner-a", a.runId).status === "completed");
    const b = h.submit("下一轮合成输入"); await until(() => h.api.queries.run("owner-a", b.runId).status === "completed");
    for (const wire of m.requests) {
      assert.equal(wire.max_tokens, 8192); assert.equal(Object.hasOwn(wire, "reasoning_effort"), false);
      if (thinking === "disabled") assert.deepEqual(wire.thinking, { type: "disabled" });
      else assert.equal(Object.hasOwn(wire, "thinking"), false);
    }
    const saved = calls(h.f.root, a.runId); assert.equal(saved.length, 2);
    for (const record of saved) {
      const options = JSON.parse(record.request).options;
      assert.equal(options.thinking, thinking); assert.equal(Object.hasOwn(options, "reasoning_effort"), false);
      assert.equal(options.maxTokens, 8192);
    }
    assert.equal(Object.hasOwn(JSON.parse(saved[0]!.response).assistant, "reasoning_content"), false);
    assert.equal(JSON.parse(saved[1]!.response).assistant.reasoning_content, "synthetic-archive-even-if-disabled");
    assert.doesNotMatch(JSON.stringify(h.api.queries.history("owner-a", "conversation-a", undefined, 50)) + h.logs(), /synthetic-archive-even-if-disabled|reasoning_content/);
    await h.app.close(); await h.f.reopen(); assert.deepEqual(calls(h.f.root, a.runId), saved);
  }
});
