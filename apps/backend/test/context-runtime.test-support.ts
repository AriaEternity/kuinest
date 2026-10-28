import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderAdapter, ProviderRequest } from "../dist/ports.js";
import { DeepSeekProvider } from "../dist/providers/deepseek.js";
import { SyntheticTools } from "../dist/providers/synthetic-tools.js";
import { fixture, harness, history, inspect, until, model, reply, chunk, done, mutate } from "./context-fixtures.js";
function snapshot(root: string, id: string) { return inspect(root, db => JSON.parse((db.prepare("SELECT manifest_json AS m FROM context_snapshots WHERE run_id=?").get(id) as { m: string }).m)); }
function calls(root: string, id: string) { return inspect(root, db => db.prepare("SELECT id,purpose,status,request_manifest_json AS request,response_json AS response FROM provider_calls WHERE run_id=? ORDER BY ordinal").all(id)) as { id: string; purpose: string; status: string; request: string; response: string }[]; }
function profileFor(f: ReturnType<typeof fixture>, m: Awaited<ReturnType<typeof model>>) {
  return { id: f.ids.next(), provider: "deepseek" as const, model: m.provider.profile.model, endpoint: m.provider.profile.endpoint, options: { allowedOrigin: m.origin }, status: "synthetic" };
}

test("C01：实际worker先固定manifest再调用模型，公开HTTP与日志没有角色/记忆资料", async t => {
  const f = fixture(t), requests: ProviderRequest[] = [];
  f.publish("synthetic-private-role-marker");
  f.storage.memoryAccess().write("owner-a", { characterId: "character-a", key: "MEMORY.md", expectedVersion: null, content: "synthetic-private-memory-marker", provenance: { source: "synthetic", reference: "test" } }, f.ids.next(), f.clock.now());
  const provider: ProviderAdapter = { description: { provider: "mock", model: "synthetic", maxTokens: 32768 }, async *stream(request) {
    assert.equal(inspect(f.root, db => (db.prepare("SELECT count(*) AS n FROM context_snapshots WHERE json_extract(manifest_json,'$.state')='ready'").get() as { n: number }).n), 1);
    requests.push(request); yield { type: "reasoning_delta", text: "synthetic-private-thought" }; yield { type: "text_delta", text: "公开合成回复" }; yield { type: "finish", reason: "stop" };
  } };
  const h = harness(t, f, provider), run = h.submit();
  await until(() => h.api.queries.run("owner-a", run.runId).status === "completed");
  assert.match(requests[0]!.system, /synthetic-private-role-marker/); assert.match(requests[0]!.system, /synthetic-private-memory-marker/);
  const origin = await h.app.listen({ host: "127.0.0.1", port: 0 });
  const login = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: f.config.publicOrigin }, payload: { username: "synthetic-context", password: "synthetic" } });
  const response = await fetch(origin + "/api/v1/runs/" + run.runId + "/events", { headers: { cookie: String(login.headers["set-cookie"]).split(";")[0]! } });
  const publicData = await response.text() + JSON.stringify(h.api.queries.history("owner-a", "conversation-a", undefined, 50)) + h.logs();
  assert.match(publicData, /公开合成回复/); assert.doesNotMatch(publicData, /synthetic-private-|context_snapshots|selectedEntryIds/);
});

test("C01/C04：工具回合间激活新角色和记忆，后续模型调用仍使用同一固定system", async t => {
  const f = fixture(t), requests: ProviderRequest[] = [], tools = new SyntheticTools(); f.publish("最初角色标记");
  const provider: ProviderAdapter = { description: { provider: "mock", model: "synthetic", maxTokens: 32768 }, async *stream(request) {
    requests.push(request); yield { type: "reasoning_delta", text: "合成" };
    if (requests.length === 1) {
      f.publish("后来角色标记"); tools.definitions[0]!.function.name = "unavailable-new-tool";
      f.storage.memoryAccess().write("owner-a", { characterId: "character-a", key: "MEMORY.md", expectedVersion: null, content: "后来记忆标记", provenance: { source: "synthetic", reference: "switch" } }, f.ids.next(), f.clock.now());
      yield { type: "tool_call_delta", index: 0, id: "fixed-tool", name: "synthetic_echo", arguments: '{"text":"合成"}' }; yield { type: "finish", reason: "tool_calls" };
    } else { yield { type: "text_delta", text: "完成合成" }; yield { type: "finish", reason: "stop" }; }
  } };
  const h = harness(t, f, provider, tools), run = h.submit();
  await until(() => h.api.queries.run("owner-a", run.runId).status === "completed");
  assert.equal(requests.length, 2); assert.equal(requests[0]!.system, requests[1]!.system);
  assert.equal((requests[1]!.tools[0]!.function as { name: string }).name, "synthetic_echo");
  assert.match(requests[1]!.system, /最初角色标记/); assert.doesNotMatch(requests[1]!.system, /后来角色标记|后来记忆标记/);
});

test("C02/C04：真实回环HTTP压缩一次，保留最近8完整回合/当前输入，重开库可重建", async t => {
  const f = fixture(t); history(f, 16, 1500);
  const m = await model(t, (body, response, count) => {
    if (count === 1) {
      assert.equal(body.max_tokens, 8192); assert.equal(body.tools, undefined);
      const input = JSON.parse((body.messages as { content: string }[])[1]!.content);
      assert.equal(input.history[0].id, "user-0"); assert.equal(input.history.at(-1).id, "assistant-7");
      assert.doesNotMatch(JSON.stringify(input), /当前待发送的输入/);
      reply(response, JSON.stringify({ text: "历史包含合成事实0至7，来源保留。", sourceIds: input.sourceIds }));
    } else reply(response, "压缩后公开合成回复");
  });
  f.publish("合成角色", { windowTokens: 68000, reserveTokens: 1000 }, profileFor(f, m));
  const h = harness(t, f, m.provider), run = h.submit("当前待发送的输入");
  await until(() => h.api.queries.run("owner-a", run.runId).status === "completed", 5000);
  const saved = calls(f.root, run.runId); assert.deepEqual(saved.map(c => c.purpose), ["compaction", "reply"]);
  const request = JSON.parse(saved[1]!.request);
  assert.equal(request.messages[0].content.startsWith("合成事实8"), true);
  assert.equal(request.messages.at(-1).content, "当前待发送的输入");
  assert.equal(request.messages.filter((x: { role: string }) => x.role === "user").length, 9);
  assert.match(request.system, /历史包含合成事实0至7/);
  assert.doesNotMatch(h.api.queries.run("owner-a", run.runId).reply!.content, /sourceIds|历史包含/);
  const before = snapshot(f.root, run.runId);
  await h.app.close(); await f.reopen(); assert.deepEqual(snapshot(f.root, run.runId), before);
  f.submit("重开后的输入"); const claim = f.store.claim(f.clock.now(), f.ids)!;
  const { compile } = await import("../dist/context/compiler.js");
  const reconstructed = compile(f.storage.contextAccess().load(claim), []);
  assert.match(reconstructed.request.system, /历史包含合成事实0至7/);
  assert.doesNotMatch(JSON.stringify(reconstructed.request.messages), /合成事实0x/);
  assert.equal(reconstructed.request.messages.at(-1)!.content, "重开后的输入");
});

test("C02/C04：摘要坏JSON、错来源、length与断流受控失败，原链和用户输入保留", async t => {
  for (const mode of ["bad-json", "wrong-source", "length", "disconnect"]) {
    const f = fixture(t); history(f, 16, 1500);
    const m = await model(t, (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chunk({ content: mode === "bad-json" ? "非JSON" : '{"text":"合成","sourceIds":["fake"]}' }) + (mode === "disconnect" ? "" : chunk({}, mode === "length" ? "length" : "stop") + done));
    });
    f.publish("合成角色", { windowTokens: 68000, reserveTokens: 1000 }, profileFor(f, m));
    const h = harness(t, f, m.provider), run = h.submit();
    await until(() => h.api.queries.run("owner-a", run.runId).status === "failed");
    assert.equal(h.api.queries.run("owner-a", run.runId).error!.code, "COMPACTION_FAILED"); assert.equal(m.requests.length, 1);
    inspect(f.root, db => {
      assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries WHERE kind='compaction'").get() as { n: number }).n, 0);
      const row = db.prepare("SELECT b.head_entry_id AS head,r.context_user_entry_id AS user FROM runs r JOIN conversations c ON c.id=r.conversation_id JOIN branches b ON b.id=c.active_branch_id WHERE r.id=?").get(run.runId) as { head: string; user: string };
      assert.equal(row.head, row.user); assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries").get() as { n: number }).n, 33);
    });
  }
});

test("C04：无可压缩前缀或压缩后仍超预算，不截人格/工具，也不多次请求", async t => {
  const small = fixture(t); small.publish("角色必须保留", { windowTokens: 34000, reserveTokens: 1000 });
  let called = 0;
  const provider: ProviderAdapter = { description: { provider: "mock", model: "synthetic", maxTokens: 32768 }, async *stream() { called++; yield { type: "text_delta", text: "不应被调用" }; yield { type: "finish", reason: "stop" }; } };
  const h = harness(t, small, provider), first = h.submit("x".repeat(1500));
  await until(() => h.api.queries.run("owner-a", first.runId).status === "failed");
  assert.equal(called, 0); assert.equal(h.api.queries.run("owner-a", first.runId).error!.code, "CONTEXT_TOO_LARGE");
  const f = fixture(t); history(f, 16, 1500);
  const m = await model(t, (body, response) => {
    const input = JSON.parse((body.messages as { content: string }[])[1]!.content);
    reply(response, JSON.stringify({ text: "x".repeat(28000), sourceIds: input.sourceIds }));
  });
  f.publish("角色必须保留", { windowTokens: 68000, reserveTokens: 1000 }, profileFor(f, m));
  const h2 = harness(t, f, m.provider), second = h2.submit();
  await until(() => h2.api.queries.run("owner-a", second.runId).status === "failed");
  assert.equal(m.requests.length, 1); assert.equal(h2.api.queries.run("owner-a", second.runId).error!.code, "CONTEXT_TOO_LARGE");
  assert.equal(calls(f.root, second.runId)[0]!.status, "completed");
  inspect(f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries WHERE kind='compaction'").get() as { n: number }).n, 0));
});

test("C04/C08：压缩中取消不公开草稿、不追加压缩节点，不重放迟到内容", async t => {
  const f = fixture(t); history(f, 16, 1500);
  const m = await model(t, async (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.write(chunk({ content: "摘要尚未结束" })); await delay(150);
    if (!response.destroyed) response.end(chunk({}, "stop") + done);
  });
  f.publish("合成角色", { windowTokens: 68000, reserveTokens: 1000 }, profileFor(f, m));
  const h = harness(t, f, m.provider), run = h.submit();
  await until(() => m.requests.length === 1); h.runs.cancel("owner-a", run.runId);
  await until(() => h.api.queries.run("owner-a", run.runId).status === "cancelled"); await delay(180);
  assert.equal(m.requests.length, 1); assert.doesNotMatch(JSON.stringify(h.api.queries.run("owner-a", run.runId)), /摘要尚未结束/);
  inspect(f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries WHERE kind='compaction'").get() as { n: number }).n, 0));
});

test("C03/C08：未知记录阻止编排，模型不被调用，原始记录仍在", async t => {
  const f = fixture(t); history(f, 1, 1);
  mutate(f, db => db.prepare("UPDATE context_entries SET kind='unknown',payload_json=? WHERE id='user-0'").run('{"futureType":"保留原始格式"}'));
  let count = 0;
  const provider: ProviderAdapter = { description: { provider: "mock", model: "synthetic", maxTokens: 32768 }, async *stream() { count++; yield { type: "finish", reason: "stop" }; } };
  const h = harness(t, f, provider), run = h.submit();
  await until(() => h.api.queries.run("owner-a", run.runId).status === "failed");
  assert.equal(h.api.queries.run("owner-a", run.runId).error!.code, "CONTEXT_UNVERIFIED"); assert.equal(count, 0);
  inspect(f.root, db => assert.equal((db.prepare("SELECT payload_json AS p FROM context_entries WHERE id='user-0'").get() as { p: string }).p, '{"futureType":"保留原始格式"}'));
});

test("C09：角色固定策略用于压缩和回复，私有调用manifest与HTTP参数一致", async t => {
  for (const thinking of ["disabled", "provider-default"] as const) {
    const f = fixture(t); history(f, 16, 1500);
    const m = await model(t, (body, response, count) => {
      if (count === 1) {
        const input = JSON.parse((body.messages as { content: string }[])[1]!.content);
        reply(response, JSON.stringify({ text: "合成压缩摘要", sourceIds: input.sourceIds }));
      } else reply(response, "合成完成");
    });
    const provider = new DeepSeekProvider({ ...m.profile, thinking, maxTokens: 12000 }, () => { throw Error("合成不读凭据"); });
    const p = profileFor(f, m); p.options = { ...p.options, thinking, maxTokens: 12000 } as typeof p.options;
    f.publish("合成角色", { windowTokens: 50000, reserveTokens: 1000 }, p);
    const h = harness(t, f, provider), run = h.submit();
    await until(() => h.api.queries.run("owner-a", run.runId).status === "completed", 5000);
    const saved = calls(f.root, run.runId); assert.deepEqual(saved.map(s => s.purpose), ["compaction", "reply"]);
    assert.deepEqual(m.requests.map(r => r.max_tokens), [8192, 12000]);
    for (const [index, record] of saved.entries()) {
      const options = JSON.parse(record.request).options;
      assert.equal(options.thinking, thinking); assert.equal(Object.hasOwn(options, "reasoning_effort"), false);
      assert.equal(options.maxTokens, m.requests[index]!.max_tokens);
      assert.equal(Object.hasOwn(m.requests[index]!, "reasoning_effort"), false);
      if (thinking === "disabled") assert.deepEqual(m.requests[index]!.thinking, { type: "disabled" });
      else assert.equal(Object.hasOwn(m.requests[index]!, "thinking"), false);
    }
  }
});

test("C09：角色与适配器策略不一致时，压缩/回复均不调用，不能留下成功manifest", async t => {
  const f = fixture(t); history(f, 16, 1500);
  const m = await model(t, (_body, response) => reply(response));
  const p = profileFor(f, m); p.options = { ...p.options, thinking: "disabled" } as typeof p.options;
  f.publish("合成冲突角色", { windowTokens: 68000, reserveTokens: 1000 }, p);
  const h = harness(t, f, m.provider), run = h.submit();
  await until(() => h.api.queries.run("owner-a", run.runId).status === "failed");
  assert.equal(h.api.queries.run("owner-a", run.runId).error!.code, "PROFILE_INVALID");
  assert.equal(m.requests.length, 0); assert.equal(calls(f.root, run.runId).length, 0);
});
