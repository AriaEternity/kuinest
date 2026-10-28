import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createApp } from "../dist/app.js";
import { KuiSenseService } from "../dist/application/kuisense.js";
import { loadConfig, readConfigEnvironment } from "../dist/config.js";
import { projectRoot } from "../dist/server.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { readContract, type KuiSenseContextPacket } from "@kuinest/contracts";

const token = "synthetic-kuisense-device-token-0123456789abcdef";
const authorization = { authorization: "Bearer " + token };

function root(): string {
  const parent = join(projectRoot, "runtime", "dev-synthetic", "kuisense-tests");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "context-"));
}
function fixture(t: TestContext, configured = true) {
  const dataRoot = root();
  const clock = { value: Date.UTC(2026, 8, 30, 10, 30), now() { return this.value; } };
  const config = loadConfig({ NODE_ENV: "development", APP_MODE: "synthetic", DATA_ROOT: dataRoot, ...(configured ? { KUISENSE_DEVICE_TOKEN: token } : {}) }, projectRoot);
  const storage = new SqliteStorage({ dataRoot, instanceId: randomUUID(), clock });
  const kuisense = configured ? new KuiSenseService(storage.kuisenseContextAccess(), token, clock) : undefined;
  let logs = "";
  const app = createApp(config, { clock, ids: { next: randomUUID }, storage, provider: { async *stream() { throw new Error("测试不得调用模型"); } } }, {
    ...(kuisense ? { kuisense } : {}),
    logStream: new Writable({ write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); } }),
  });
  t.after(() => app.close());
  return { dataRoot, clock, config, storage, app, logs: () => logs };
}
// 人工合成Android v1样例，时间为毫秒、nullable字段显式为null。
const androidPacket = JSON.parse(readFileSync(new URL("../../../fixtures/kuisense/context-v1.json", import.meta.url), "utf8")) as KuiSenseContextPacket;
const packet = (title: string): KuiSenseContextPacket => ({ ...structuredClone(androidPacket), recent_summary: title });

test("KuiSense 配置仅接受显式且足够长的设备 token", () => {
  const env = readConfigEnvironment({ NODE_ENV: "development", APP_MODE: "synthetic", KUISENSE_DEVICE_TOKEN: token });
  assert.equal(env.KUISENSE_DEVICE_TOKEN, token);
  assert.equal(loadConfig(env, projectRoot).kuisenseDeviceToken, token);
  assert.throws(() => loadConfig({ NODE_ENV: "development", APP_MODE: "synthetic", KUISENSE_DEVICE_TOKEN: "too-short" }, projectRoot));
  assert.throws(() => readConfigEnvironment({ NODE_ENV: "development", APP_MODE: "synthetic", KUISENSE_DEVICE_TOKNE: token }));
});

test("未配置 KuiSense token 时设备入口保持 503，不影响其他服务启动", async t => {
  const h = fixture(t, false);
  const response = await h.app.inject({ method: "GET", url: "/api/kuisense/context/latest" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "SERVICE_NOT_READY");
});

test("设备入口拒绝缺失或错误 Bearer token，且日志不泄露 token", async t => {
  const h = fixture(t);
  const missing = await h.app.inject({ method: "GET", url: "/api/kuisense/context/latest" });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().error.code, "DEVICE_AUTH_INVALID");
  const badToken = "wrong-kuisense-device-token-0123456789abcdef";
  const wrong = await h.app.inject({ method: "GET", url: "/api/kuisense/context/latest", headers: { authorization: "Bearer " + badToken } });
  assert.equal(wrong.statusCode, 401);
  const lowercaseScheme = await h.app.inject({ method: "GET", url: "/api/kuisense/context/latest", headers: { authorization: "bearer " + token } });
  assert.equal(lowercaseScheme.statusCode, 404);
  assert.doesNotMatch(h.logs(), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(h.logs(), new RegExp(badToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("GET latest 在尚未上传时返回 404", async t => {
  const h = fixture(t);
  const response = await h.app.inject({ method: "GET", url: "/api/kuisense/context/latest", headers: authorization });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "NOT_FOUND");
});

test("POST 接收 schema v1 ContextPacket，并由 GET latest 原样读回", async t => {
  const h = fixture(t), body = packet("愿戴荣光坠入天渊");
  const upload = await h.app.inject({ method: "POST", url: "/api/kuisense/context", headers: authorization, payload: body });
  assert.equal(upload.statusCode, 200, upload.body);
  assert.deepEqual(readContract("kuisenseUploadReceipt", upload.json()), { status: "ok", received_at: "2026-09-30T10:30:00.000Z" });
  const latest = await h.app.inject({ method: "GET", url: "/api/kuisense/context/latest", headers: authorization });
  assert.equal(latest.statusCode, 200, latest.body);
  assert.deepEqual(readContract("kuisenseContextPacket", latest.json()), body);
});

test("新的 ContextPacket 原子替换 latest，而不是在后端积累手机事件历史", async t => {
  const h = fixture(t), first = packet("第一首"), second = packet("第二首");
  assert.equal((await h.app.inject({ method: "POST", url: "/api/kuisense/context", headers: authorization, payload: first })).statusCode, 200);
  h.clock.value += 1000;
  assert.equal((await h.app.inject({ method: "POST", url: "/api/kuisense/context", headers: authorization, payload: second })).statusCode, 200);
  const latest = await h.app.inject({ method: "GET", url: "/api/kuisense/context/latest", headers: authorization });
  assert.deepEqual(latest.json(), second);
});

test("ContextPacket 在服务重开后仍保存在 SQLite", async t => {
  const dataRoot = root(), clock = { value: Date.UTC(2026, 8, 30, 10, 30), now() { return this.value; } };
  const config = loadConfig({ NODE_ENV: "development", APP_MODE: "synthetic", DATA_ROOT: dataRoot, KUISENSE_DEVICE_TOKEN: token }, projectRoot);
  const open = () => {
    const storage = new SqliteStorage({ dataRoot, instanceId: randomUUID(), clock });
    const service = new KuiSenseService(storage.kuisenseContextAccess(), token, clock);
    return { storage, app: createApp(config, { clock, ids: { next: randomUUID }, storage, provider: { async *stream() { throw new Error("测试不得调用模型"); } } }, { kuisense: service }) };
  };
  let current = open();
  const body = packet("持久化测试");
  assert.equal((await current.app.inject({ method: "POST", url: "/api/kuisense/context", headers: authorization, payload: body })).statusCode, 200);
  await current.app.close();
  current = open();
  t.after(() => current.app.close());
  const latest = await current.app.inject({ method: "GET", url: "/api/kuisense/context/latest", headers: authorization });
  assert.equal(latest.statusCode, 200);
  assert.deepEqual(latest.json(), body);
});

test("设备入口拒绝错误 schema、查询参数与非 JSON 请求", async t => {
  const h = fixture(t);
  const missingVersion = await h.app.inject({ method: "POST", url: "/api/kuisense/context", headers: authorization, payload: { generated_at: "x" } });
  assert.equal(missingVersion.statusCode, 400);
  const wrongVersion = await h.app.inject({ method: "POST", url: "/api/kuisense/context", headers: authorization, payload: { schema_version: 2 } });
  assert.equal(wrongVersion.statusCode, 400);
  const wrongType = await h.app.inject({ method: "POST", url: "/api/kuisense/context", headers: { ...authorization, "content-type": "text/plain" }, payload: JSON.stringify(packet("x")) });
  assert.equal(wrongType.statusCode, 400);
  const query = await h.app.inject({ method: "GET", url: "/api/kuisense/context/latest?extra=1", headers: authorization });
  assert.equal(query.statusCode, 400);
});

import "./kuisense-migrations.test-support.js";

test("Android v1完整Header与null/毫秒结构往返，失败上传不覆盖latest且日志无正文", async t => {
  const h = fixture(t), body = packet("纯合成隐私标记-KS-ANDROID");
  const headers = { ...authorization, "content-type": "application/json; charset=utf-8", accept: "application/json", "user-agent": "KuiSense/0.5", "x-kuisense-schema": "1" };
  const ok = await h.app.inject({ method: "POST", url: "/api/kuisense/context", headers, payload: JSON.stringify(body) });
  assert.equal(ok.statusCode, 200);
  for (const payload of [null, [], { schema_version: "1" }, { schema_version: 2, recent_summary: body.recent_summary }]) {
    const denied = await h.app.inject({ method: "POST", url: "/api/kuisense/context", headers, payload: JSON.stringify(payload) });
    assert.equal(denied.statusCode, 400);
  }
  const huge = await h.app.inject({ method: "POST", url: "/api/kuisense/context", headers, payload: JSON.stringify({ schema_version: 1, padding: "x".repeat(192 * 1024) }) });
  assert.equal(huge.statusCode, 413);
  const latest = await h.app.inject({ url: "/api/kuisense/context/latest", headers: authorization });
  assert.deepEqual(latest.json(), body); assert.equal(latest.headers["cache-control"], "no-store");
  assert.ok(!h.logs().includes(String(body.recent_summary))); assert.ok(!h.logs().includes(token));
});
