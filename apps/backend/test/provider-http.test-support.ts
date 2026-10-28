import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { DeepSeekProvider, requestBody, validateProfile } from "../dist/providers/deepseek.js";
import { ProviderSseParser } from "../dist/providers/sse-parser.js";
import { ProtocolAccumulator } from "../dist/providers/protocol.js";
import type { ProviderEvent, ProviderRequest } from "../dist/ports.js";
import { model, reply, chunk, done, isCode } from "./provider-fixtures.js";
const request: ProviderRequest = { system: "合成系统", messages: [{ role: "user", content: "合成输入" }], tools: [], options: { mode: "synthetic", temperature: 0, endpoint: "https://invalid.test" } };
async function collect(provider: DeepSeekProvider, signal = AbortSignal.timeout(5000)) {
  const result: ProviderEvent[] = []; for await (const event of provider.stream(request, signal)) result.push(event); return result;
}
test("P01：真实HTTP适配固定参数、完整usage、DONE及无凭据合成请求", async t => {
  const m = await model(t, (_body, response) => reply(response));
  const events = await collect(m.provider), accumulator = new ProtocolAccumulator(); events.forEach(e => accumulator.add(e));
  const archive = accumulator.close();
  assert.equal(archive.assistant.content, "合成回复"); assert.equal(archive.assistant.reasoning_content, "synthetic-private-reasoning");
  assert.equal(archive.usage!.details!.prompt_cache_hit_tokens, 2);
  assert.equal(m.requests.length, 1); assert.equal(m.headers[0]!.authorization, undefined);
  assert.deepEqual(m.requests[0]!.thinking, { type: "enabled" }); assert.equal(m.requests[0]!.max_tokens, 32768);
  assert.equal(m.requests[0]!.reasoning_effort, "high"); assert.equal(m.requests[0]!.temperature, undefined);
  assert.equal(m.requests[0]!.endpoint, undefined); assert.equal(m.requests[0]!.tools, undefined);
});

test("P02：有tools保留完整reasoning，无tools只从传输副本移除，缺失不得伪补", () => {
  const initial = { ...request, messages: [{ role: "user", content: "第一轮" }, { role: "assistant", content: "回复", reasoning_content: "合成私有字段" }, { role: "user", content: "第二轮" }] };
  const profile = { mode: "synthetic" as const, endpoint: "http://127.0.0.1/chat/completions", allowedOrigin: "http://127.0.0.1", model: "deepseek-v4-flash" };
  assert.equal((requestBody(initial, profile).messages as Record<string, unknown>[])[2]!.reasoning_content, undefined);
  const withTools = { ...initial, tools: [{ type: "function", function: { name: "synthetic_echo" } }] };
  assert.equal((requestBody(withTools, profile).messages as Record<string, unknown>[])[2]!.reasoning_content, "合成私有字段");
  assert.equal(initial.messages[1]!.reasoning_content, "合成私有字段");
  assert.throws(() => requestBody({ ...withTools, messages: [{ role: "assistant", content: "缺字段的旧记录" }] }, profile), isCode("PROTOCOL_HISTORY_INCOMPLETE"));
});

test("P04：真实逐字节CRLF流、Unicode、注释和多data行不会误分帧", async t => {
  const expected = "中文🙂";
  const m = await model(t, async (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const text = (": keepalive\n\n" + chunk({ content: expected }) + chunk({}, "stop") + done).replaceAll("\n", "\r\n");
    for (const byte of Buffer.from(text)) { if (response.destroyed) return; response.write(Uint8Array.of(byte)); await delay(1); }
    response.end();
  }, { idleMs: 100 });
  const result = await collect(m.provider); assert.deepEqual(result.flatMap(e => e.type === "text_delta" ? [e.text] : []), [expected]);
  for (const eol of ["\n", "\r", "\r\n"]) {
    const parser = new ProviderSseParser(), result: string[] = [];
    for (const byte of Buffer.from(["\ufeff:合成", "", "data: {", 'data: "a":1}', "", ""].join(eol))) result.push(...parser.push(Uint8Array.of(byte)));
    parser.end(); assert.deepEqual(result, ['{\n"a":1}']);
  }
});

test("P04：坏JSON、只有DONE、缺DONE、未知结束与多choice都明确失败", async t => {
  for (const data of ["data: {broken}\n\n", done, chunk({ content: "部分" }) + chunk({}, "stop"), chunk({}, "unknown") + done, 'data: {"choices":[{},{}]}\n\n']) {
    const m = await model(t, (_body, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(data); });
    const accumulator = new ProtocolAccumulator();
    await assert.rejects(async () => { for await (const event of m.provider.stream(request, AbortSignal.timeout(5000))) accumulator.add(event); accumulator.close(); }, isCode("UPSTREAM_INCOMPLETE"));
    assert.equal(m.requests.length, 1);
  }
});

test("P05：401/403/429/5xx安全映射Retry-After，不读取原始错误且零重试", async t => {
  for (const [status, code] of [[401, "UPSTREAM_AUTH"], [403, "UPSTREAM_AUTH"], [429, "UPSTREAM_RATE_LIMIT"], [500, "UPSTREAM_UNAVAILABLE"], [503, "UPSTREAM_UNAVAILABLE"]] as const) {
    const m = await model(t, (_body, response) => { response.writeHead(status, { "retry-after": "12" }); response.end("synthetic-upstream-secret"); });
    await assert.rejects(collect(m.provider), error => {
      assert.ok(isCode(code)(error)); assert.equal((error as { retryAfterSeconds: number }).retryAfterSeconds, 12);
      assert.doesNotMatch(String(error), /synthetic-upstream-secret/); return true;
    });
    assert.equal(m.requests.length, 1);
  }
});

test("P05：拒绝重定向与未授权live，配置URL不能绕过固定路径和origin", async t => {
  const target = await model(t, (_body, response) => reply(response));
  const source = await model(t, (_body, response) => { response.writeHead(307, { location: target.origin + "/chat/completions" }); response.end(); });
  await assert.rejects(collect(source.provider), isCode("UPSTREAM_UNAVAILABLE")); assert.equal(target.requests.length, 0);
  let credentials = 0, calls = 0;
  const live = new DeepSeekProvider({ mode: "private", endpoint: "https://api.deepseek.com/chat/completions", allowedOrigin: "https://api.deepseek.com", model: "deepseek-flash" }, () => { credentials++; return "synthetic-key"; }, async () => { calls++; throw new Error("禁止网络"); });
  await assert.rejects(collect(live), isCode("UPSTREAM_UNAVAILABLE")); assert.equal(credentials, 0); assert.equal(calls, 0);
  for (const endpoint of ["http://example.com/chat/completions", "http://127.0.0.1/other", "http://u:p@127.0.0.1/chat/completions", "http://127.0.0.1/chat/completions?q=x", "http://127.0.0.1/chat/completions#x"]) {
    assert.throws(() => validateProfile({ mode: "synthetic", endpoint, allowedOrigin: new URL(endpoint).origin, model: "synthetic" }), isCode("UPSTREAM_UNAVAILABLE"));
  }
});

test("P07：响应头、传输闲置和总时限；注释字节重置闲置但不延长总限额", async t => {
  const head = await model(t, async (_body, response) => { await delay(100); if (!response.destroyed) reply(response); }, { headersMs: 20 });
  await assert.rejects(collect(head.provider), isCode("UPSTREAM_TIMEOUT"));
  const idle = await model(t, (_body, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); }, { idleMs: 20 });
  await assert.rejects(collect(idle.provider), isCode("UPSTREAM_TIMEOUT"));
  let comments = 0;
  const thinking = await model(t, async (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    while (!response.destroyed) { response.write(": thinking\n\n"); comments++; await delay(10); }
  }, { idleMs: 40, totalMs: 120 });
  await assert.rejects(collect(thinking.provider), isCode("UPSTREAM_TIMEOUT")); assert.ok(comments >= 3);
});

test("P07/P08：单帧与总响应预算、显式取消均终止上游", async t => {
  const huge = await model(t, (_body, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(chunk({ content: "x".repeat(600) })); }, { maxFrameBytes: 300 });
  await assert.rejects(collect(huge.provider), isCode("OUTPUT_LIMIT"));
  const total = await model(t, (_body, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(": x\n\n".repeat(200)); }, { maxResponseBytes: 300 });
  await assert.rejects(collect(total.provider), isCode("OUTPUT_LIMIT"));
  const abort = new AbortController();
  const hanging = await model(t, (_body, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": ready\n\n"); setTimeout(() => abort.abort(), 20); });
  await assert.rejects(collect(hanging.provider, abort.signal)); assert.equal(hanging.requests.length, 1);
});


test("P01/P07：私有配置只在调用时读虚构凭据；凭据阻塞受总超时限制且迟到不联网", async () => {
  const profile = { mode: "private" as const, endpoint: "https://api.deepseek.com/chat/completions", allowedOrigin: "https://api.deepseek.com", model: "deepseek-flash", allowLive: true };
  let credentials = 0, network = 0;
  // 替代传输完全在内存中返回合成SSE，不能调用fetch或访问真实HTTPS。
  const transport: typeof fetch = async (url, init) => {
    network++; assert.equal(url, profile.endpoint);
    assert.equal(new Headers(init!.headers).get("authorization"), "Bearer synthetic-in-memory-only");
    assert.equal(init!.redirect, "error");
    assert.doesNotMatch(String(init!.body), /synthetic-in-memory-only|Authorization/);
    return new Response(chunk({ reasoning_content: "合成", content: "合成回复" }) + chunk({}, "stop") + done, { headers: { "content-type": "text/event-stream" } });
  };
  const provider = new DeepSeekProvider(profile, () => { credentials++; return "synthetic-in-memory-only"; }, transport);
  assert.equal(credentials, 0); assert.equal(network, 0);
  await collect(provider); assert.equal(credentials, 1); assert.equal(network, 1);
  let resolve!: (value: string) => void;
  const pending = new Promise<string>(done => { resolve = done; });
  const hanging = new DeepSeekProvider(profile, () => pending, transport, { totalMs: 25 });
  await assert.rejects(collect(hanging), isCode("UPSTREAM_TIMEOUT"));
  resolve("synthetic-in-memory-only"); await delay(10); assert.equal(network, 1);
});

test("P09：思考策略准确发送，工具历史不伪补，传输转换不修改原档", async t => {
  const tool = { id: "synthetic-call", type: "function", function: { name: "synthetic_echo", arguments: "{}" } };
  const messages = [{ role: "user", content: "合成一" }, { role: "assistant", content: null, tool_calls: [tool] },
    { role: "tool", tool_call_id: tool.id, content: "合成工具结果" }, { role: "assistant", content: "合成答复", reasoning_content: "synthetic-kept-thought" }, { role: "user", content: "合成二" }];
  const original = structuredClone(messages);
  for (const thinking of ["disabled", "provider-default", "enabled"] as const) {
    const m = await model(t, (_body, response) => reply(response));
    const provider = new DeepSeekProvider({ ...m.profile, thinking, ...(thinking === "enabled" ? { reasoning_effort: "low" as const } : {}) }, () => { throw Error("不得读取"); });
    let next: ProviderRequest = { ...request, messages, tools: [{ type: "function", function: { name: "synthetic_echo" } }] };
    const run = async () => { const events: ProviderEvent[] = []; for await (const event of provider.stream(next, AbortSignal.timeout(5000))) events.push(event); return events; };
    if (thinking === "enabled") {
      await assert.rejects(run(), isCode("PROTOCOL_HISTORY_INCOMPLETE")); assert.equal(m.requests.length, 0);
      next = { ...next, messages: messages.map(v => v.role === "assistant" ? { ...v, reasoning_content: "synthetic-complete" } : v) };
      await run(); assert.equal(m.requests[0]!.reasoning_effort, "low");
    } else {
      const events = await run(); assert.ok(events.some(e => e.type === "reasoning_delta"));
      assert.equal(Object.hasOwn(m.requests[0]!, "reasoning_effort"), false);
      if (thinking === "disabled") assert.deepEqual(m.requests[0]!.thinking, { type: "disabled" });
      else assert.equal(Object.hasOwn(m.requests[0]!, "thinking"), false);
      const sent = m.requests[0]!.messages as Record<string, unknown>[];
      assert.equal(Object.hasOwn(sent[2]!, "reasoning_content"), false);
      assert.equal(sent[4]!.reasoning_content, thinking === "disabled" ? undefined : "synthetic-kept-thought");
    }
    assert.deepEqual(messages, original);
  }
});

test("P09：固定策略与预算不受请求覆盖，冲突在凭据/网络之前失败", async () => {
  const profile = { mode: "private" as const, endpoint: "https://api.deepseek.com/chat/completions", allowedOrigin: "https://api.deepseek.com",
    model: "synthetic-policy-model", maxTokens: 12000, thinking: "disabled" as const, allowLive: true };
  let credentials = 0, network = 0;
  const provider = new DeepSeekProvider(profile, () => { credentials++; return "synthetic-key"; }, async () => { network++; throw Error("不得联网"); });
  for (const options of [{ thinking: "enabled" }, { reasoning_effort: "high" }, { maxTokens: 12001 }, { maxTokens: 0 }, { maxTokens: 1.5 }, { model: "different" }]) {
    await assert.rejects(async () => { for await (const _event of provider.stream({ ...request, options: { ...request.options, ...options } }, AbortSignal.timeout(1000))) {} }, isCode("PROFILE_INVALID"));
  }
  assert.equal(credentials, 0); assert.equal(network, 0);
  assert.equal(requestBody({ ...request, options: { maxTokens: 4000 } }, profile).max_tokens, 4000);
  assert.equal(requestBody({ ...request, options: { purpose: "compaction" } }, profile).max_tokens, 8192);
  assert.throws(() => validateProfile({ ...profile, reasoning_effort: "high" }), isCode("UPSTREAM_UNAVAILABLE"));
  assert.throws(() => validateProfile({ ...profile, thinking: "provider-default", reasoning_effort: "low" }), isCode("UPSTREAM_UNAVAILABLE"));
  for (const reasoning_effort of ["low", "high", "max"] as const) {
    const body = requestBody(request, { ...profile, thinking: "enabled", reasoning_effort });
    assert.equal(body.reasoning_effort, reasoning_effort);
  }
});
