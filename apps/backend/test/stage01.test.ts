import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { Ajv } from "ajv";
import { allSchemas, schemas } from "@kuinest/contracts";
import type { AcceptedSubmission, RunSnapshot } from "@kuinest/contracts";
import { createApp } from "../dist/app.js";
import { ConfigError, loadConfig, readConfigEnvironment } from "../dist/config.js";
import { sqliteSupported } from "../dist/http/health.js";
import type { BackendPorts, StorageReadiness } from "../dist/ports.js";
import { foundationPorts, projectRoot } from "../dist/server.js";

const config = () => loadConfig({ NODE_ENV: "test", APP_MODE: "synthetic" }, projectRoot);
function logs() {
  let value = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } });
  return { stream, read: () => value };
}
function ports(state?: Partial<StorageReadiness>) {
  let calls = 0, closed = 0, seq = 0;
  const dependencies: BackendPorts = {
    clock: { now: () => 1000 },
    ids: { next: () => "synthetic-request-" + ++seq },
    provider: { async *stream() { calls++; yield { type: "text_delta", text: "纯合成测试" }; } },
    storage: {
      async getReadiness() { return { connected: true, schemaCompatible: true, sqliteVersion: "3.53.1", lease: { held: true, expiresAt: 2000 }, ...state }; },
      async close() { closed++; },
    },
  };
  return { dependencies, calls: () => calls, closed: () => closed };
}
const production = () => ({
  NODE_ENV: "production", APP_MODE: "private", DATA_ROOT: resolve(projectRoot, "runtime", "synthetic-private-path-only"),
  PUBLIC_ORIGIN: "https://synthetic.invalid", CURSOR_HMAC_KEY: Buffer.alloc(32, 42).toString("base64"),
});
test("F01：真实原生驱动加载并满足 SQLite 基线，仅使用内存库", () => {
  const db = new Database(":memory:");
  try {
    const row = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    assert.ok(sqliteSupported(row.version), row.version);
    const count = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number };
    assert.equal(count.n, 0);
  } finally { db.close(); }
});
test("F01：编译全部受控 schema，5 份合成样本符合接口", () => {
  const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  for (const schema of allSchemas) ajv.addSchema(schema);
  for (const schema of allSchemas) assert.ok(ajv.getSchema(schema.$id as string));
  for (const [file, name, many] of [
    ["image-conversation.json", "historyPage", false], ["basic-conversation.json", "historyPage", false], ["message-changes.json", "messageChanges", false],
    ["run-events.json", "runEvent", true], ["heartbeat-silent-events.json", "runEvent", true],
  ] as const) {
    const value: unknown = JSON.parse(readFileSync(resolve(projectRoot, "fixtures/chat", file), "utf8"));
    const validate = ajv.getSchema("urn:kuinest:0.3:" + name)!;
    for (const item of many ? value as unknown[] : [value]) assert.ok(validate(item), JSON.stringify(validate.errors));
  }
  const accepted: AcceptedSubmission = { conversationId: "c", clientMessageId: "00000000-0000-4000-8000-000000000001", messageId: "u", replyId: "a", runId: "r", acceptedAt: "2026-09-08T00:00:00Z" };
  const snapshot: RunSnapshot = { runId: "r", origin: "user", conversationId: "c", status: "accepted", lastSequence: 1 };
  assert.ok(ajv.getSchema("urn:kuinest:0.3:acceptedSubmission")!(accepted));
  assert.ok(ajv.getSchema("urn:kuinest:0.3:runSnapshot")!(snapshot));
});
test("F01：schema 拒绝未知字段、错误类型与伪造主动接受事件", () => {
  const ajv = new Ajv({ strict: true });
  allSchemas.forEach(schema => ajv.addSchema(schema));
  const submit = ajv.getSchema("urn:kuinest:0.3:submitMessageRequest")!;
  const request = { clientMessageId: "00000000-0000-4000-8000-000000000001", text: "测试" };
  assert.ok(submit(request));
  for (const invalid of [{ ...request, role: "system" }, { ...request, allowWebSearch: "true" }, { ...request, text: "   " }, { ...request, text: "葵".repeat(32001) }, { ...request, clientMessageId: "demo-fake" }]) assert.equal(submit(invalid), false);
  const accepted = { runId: "r", sequence: 1, occurredAt: "2026-09-08T00:00:00Z", type: "run.accepted", origin: "heartbeat", conversationId: "c", replyId: "a", acceptedAt: "2026-09-08T00:00:00Z" };
  const event = ajv.getSchema("urn:kuinest:0.3:runEvent")!;
  assert.ok(event(accepted));
  assert.equal(event({ ...accepted, submission: {} }), false);
});
test("F02：生产模式必须显式配置关键项，不能退回模拟", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }, projectRoot), ConfigError);
  for (const key of ["APP_MODE", "DATA_ROOT", "PUBLIC_ORIGIN", "CURSOR_HMAC_KEY"]) {
    const input: Record<string, string> = production();
    delete input[key];
    assert.throws(() => loadConfig(input, projectRoot), ConfigError);
  }
  assert.equal(loadConfig(production(), projectRoot).mode, "private");
  assert.throws(() => loadConfig({ ...production(), APP_MODE: "synthetic" }, projectRoot), ConfigError);
});
test("F02：无效端口、地址、根目录、origin 和密钥均拒绝", () => {
  for (const invalid of [
    { PORT: "0" }, { PORT: "65536" }, { PORT: "1.5" }, { BIND_HOST: "0.0.0.0" },
    { PUBLIC_ORIGIN: "https://example.invalid" }, { DATA_ROOT: resolve(projectRoot, "runtime/private") },
    { UNKNOWN_OPTION: "value" }, { ALLOW_LIVE_MODEL: "yes" }, { ALLOW_LIVE_MODEL: "true" },
  ]) assert.throws(() => loadConfig(invalid, projectRoot), ConfigError);
  for (const invalid of [
    { PUBLIC_ORIGIN: "http://synthetic.invalid" }, { PUBLIC_ORIGIN: "https://user:pass@synthetic.invalid" },
    { PUBLIC_ORIGIN: "https://synthetic.invalid/path" }, { PUBLIC_ORIGIN: "https://synthetic.invalid?secret=x" },
    { DATA_ROOT: "relative" }, { DATA_ROOT: resolve(projectRoot, "apps/frontend/dist") },
    { CURSOR_HMAC_KEY: "short" }, { CURSOR_HMAC_KEY: "a".repeat(43) + "!" },
  ]) assert.throws(() => loadConfig({ ...production(), ...invalid }, projectRoot), ConfigError);
});
test("F02：合成配置适配器不读取凭据 getter，系统环境不误判为配置", () => {
  const env: Record<string, string | undefined> = { PATH: "synthetic-path", NODE_ENV: "test", APP_MODE: "synthetic" };
  Object.defineProperty(env, "DEEPSEEK_API_KEY", { enumerable: true, get() { throw new Error("不得读取模型密钥"); } });
  Object.defineProperty(env, "CURSOR_HMAC_KEY", { enumerable: true, get() { throw new Error("不得读取游标密钥"); } });
  assert.equal(loadConfig(readConfigEnvironment(env), projectRoot).mode, "synthetic");
  assert.throws(() => readConfigEnvironment({ APP_MDOE: "private" }), ConfigError);
});
test("F02：生产启动进程配置缺失时以非零状态结束，不输出值", () => {
  const result = spawnSync(process.execPath, ["apps/backend/dist/server.js"], {
    cwd: projectRoot, env: { NODE_ENV: "production", PUBLIC_ORIGIN: "synthetic-secret-marker" }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /START_FAILED/);
  assert.doesNotMatch(result.stderr, /synthetic-secret-marker|Error:|at |[A-Z]:\\/);
});
test("F03：创建应用不占端口、不调用模型，时钟和 ID 可注入", async () => {
  const fake = ports(), output = logs();
  const app = createApp(config(), fake.dependencies, { logStream: output.stream });
  try {
    assert.equal(app.server.listening, false);
    assert.equal(fake.calls(), 0);
    const response = await app.inject({ url: "/unknown", headers: { "x-request-id": "untrusted-id" } });
    assert.equal(response.json().requestId, "synthetic-request-1");
    assert.equal(app.server.listening, false);
    assert.equal(fake.calls(), 0);
  } finally { await app.close(); }
  assert.equal(fake.closed(), 1);
});
test("F04：健康探针仅返回安全状态，时钟推进后租约过期", async () => {
  const fake = ports(), output = logs();
  let now = 1000; fake.dependencies.clock.now = () => now;
  const app = createApp(config(), fake.dependencies, { logStream: output.stream });
  try {
    assert.deepEqual((await app.inject("/health/live")).json(), { status: "ok" });
    const ready = await app.inject("/health/ready");
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: "ok" });
    assert.equal(ready.headers["cache-control"], "no-store");
    now = 2000;
    const expired = await app.inject("/health/ready");
    assert.equal(expired.statusCode, 503);
    assert.deepEqual(expired.json(), { status: "unavailable" });
  } finally { await app.close(); }
});
test("F04：失联、旧版本、未迁移、失租约与存储异常均未就绪", async () => {
  for (const state of [{ connected: false }, { sqliteVersion: "3.40.1" }, { schemaCompatible: false }, { lease: { held: false, expiresAt: 2000 } }]) {
    const app = createApp(config(), ports(state).dependencies, { logStream: logs().stream });
    try { assert.equal((await app.inject("/health/ready")).statusCode, 503); }
    finally { await app.close(); }
  }
  const fake = ports(), output = logs();
  fake.dependencies.storage.getReadiness = async () => { throw new Error("synthetic-private-path-and-key"); };
  const app = createApp(config(), fake.dependencies, { logStream: output.stream });
  try {
    assert.deepEqual((await app.inject("/health/ready")).json(), { status: "unavailable" });
    assert.doesNotMatch(output.read(), /synthetic-private-path-and-key/);
  } finally { await app.close(); }
});
test("F04：默认基础服务不伪造存储就绪", async () => {
  const app = createApp(config(), foundationPorts(), { logStream: logs().stream });
  try {
    assert.equal((await app.inject("/health/live")).statusCode, 200);
    assert.equal((await app.inject("/health/ready")).statusCode, 503);
  } finally { await app.close(); }
});
test("F04：异常、查询串、头部与请求体不进入日志或错误响应", async () => {
  const output = logs();
  const app = createApp(config(), ports().dependencies, { logStream: output.stream });
  app.post("/synthetic-error", async () => { throw new Error("synthetic-error-secret"); });
  try {
    const response = await app.inject({
      method: "POST", url: "/synthetic-error?secret=synthetic-query-secret",
      headers: { authorization: "Bearer synthetic-auth-secret", cookie: "sid=synthetic-cookie-secret" },
      payload: { password: "synthetic-body-secret" },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, "INTERNAL_ERROR");
    const combined = response.body + output.read();
    assert.doesNotMatch(combined, /synthetic-(?:error|query|auth|cookie|body)-secret/);
    assert.doesNotMatch(combined, /stack|reasoning_content/);
  } finally { await app.close(); }
});
test("F04：HTTP 校验拒绝多余字段和类型转换，超大请求返回受控错误", async () => {
  const app = createApp(config(), ports().dependencies, { logStream: logs().stream });
  app.post("/synthetic-submit", { schema: { body: schemas.submitMessageRequest } }, async () => ({ ok: true }));
  try {
    const data = { clientMessageId: "00000000-0000-4000-8000-000000000001", text: "测试" };
    assert.equal((await app.inject({ method: "POST", url: "/synthetic-submit", payload: data })).statusCode, 200);
    for (const payload of [{ ...data, allowWebSearch: "true" }, { ...data, unexpected: true }]) {
      const response = await app.inject({ method: "POST", url: "/synthetic-submit", payload });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, "INPUT_INVALID");
    }
    const large = await app.inject({ method: "POST", url: "/synthetic-submit", payload: { text: "x".repeat(192 * 1024) } });
    assert.equal(large.statusCode, 413);
    assert.equal(large.json().error.code, "BODY_TOO_LARGE");
  } finally { await app.close(); }
});
test("F03：真实临时回环端口可请求并关闭，关闭后不再监听", async () => {
  const app = createApp(config(), ports().dependencies, { logStream: logs().stream });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const result = await fetch(url + "/health/live");
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { status: "ok" });
  } finally { await app.close(); }
  assert.equal(app.server.listening, false);
});
test("F01：测试命令拒绝不存在的阶段", () => {
  const result = spawnSync(process.execPath, ["scripts/project.mjs", "test", "--stage=11"], { cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /只支持 --stage=01/);
});

test("F04：非法 URL 与超长参数也不回显请求地址或查询串", async () => {
  const output = logs();
  const app = createApp(config(), ports().dependencies, { logStream: output.stream });
  app.get("/synthetic/:id", async () => ({ ok: true }));
  try {
    for (const url of ["/%zz?synthetic-url-secret=marker", "/synthetic/" + "x".repeat(257) + "?synthetic-url-secret=marker"]) {
      const response = await app.inject({ url });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, "INPUT_INVALID");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.doesNotMatch(response.body + output.read(), /synthetic-url-secret|%zz|marker/);
      assert.match(response.json().requestId, /^synthetic-request-/);
    }
  } finally { await app.close(); }
});
