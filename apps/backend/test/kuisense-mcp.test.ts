import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { kuisenseMcp, type KuiSenseContextPacket } from "@kuinest/contracts";
import { createApp } from "../dist/app.js";
import { KuiSenseService } from "../dist/application/kuisense.js";
import { loadConfig, readConfigEnvironment } from "../dist/config.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { projectRoot } from "../dist/server.js";

const deviceToken = "synthetic-device-token-0123456789abcdef";
const readToken = "synthetic-mcp-read-token-0123456789abcdef";
const path = kuisenseMcp.path;
const headers = { authorization: "Bearer " + readToken, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-11-25" };
// 只用仓库中明确合成的 Android 样本，所有测试库独占并在结束时清理。
const packet = JSON.parse(readFileSync(new URL("../../../fixtures/kuisense/context-v1.json", import.meta.url), "utf8")) as KuiSenseContextPacket;

function fixture(t: TestContext, enabled = true, reader = true) {
  const dataRoot = mkdtempSync(join(tmpdir(), "kuisense-mcp-test-"));
  const clock = { now: () => Date.UTC(2026, 9, 15) };
  const input = { NODE_ENV: "test", APP_MODE: "private", DATA_ROOT: dataRoot, PUBLIC_ORIGIN: "https://synthetic.example", CURSOR_HMAC_KEY: randomBytes(32).toString("base64"), KUISENSE_DEVICE_TOKEN: deviceToken, ...(enabled ? { KUISENSE_MCP_READ_TOKEN: readToken } : {}) };
  const config = loadConfig(input, projectRoot);
  const storage = new SqliteStorage({ dataRoot, instanceId: randomUUID(), clock });
  const service = new KuiSenseService(storage.kuisenseContextAccess(), deviceToken, clock);
  let reads = 0, logs = "";
  const originalLatest = service.latest.bind(service);
  service.latest = () => { reads++; return originalLatest(); };
  const app = createApp(config, { clock, ids: { next: randomUUID }, storage, provider: { async *stream() { throw new Error("禁止模型调用"); } } }, {
    ...(reader ? { kuisense: service } : {}),
    logStream: new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } }),
  });
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(dataRoot)), resolve(tmpdir()));
    assert.ok(dataRoot.startsWith(join(tmpdir(), "kuisense-mcp-test-")));
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const rpc = (method: string, params?: unknown, extraHeaders = {}) => app.inject({ method: "POST", url: path, headers: { ...headers, ...extraHeaders }, payload: { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) } });
  return { app, service, storage, input, rpc, reads: () => reads, logs: () => logs };
}

test("MCP 配置独立、默认关闭，拒绝短令牌、空白、过长及与设备令牌复用", async t => {
  const h = fixture(t, false);
  assert.equal((await h.app.inject({ method: "POST", url: path, payload: {} })).statusCode, 404);
  assert.equal(readConfigEnvironment({ ...h.input, KUISENSE_MCP_READ_TOKEN: readToken }).KUISENSE_MCP_READ_TOKEN, readToken);
  for (const token of ["short", "x".repeat(513), "x".repeat(32) + " ", deviceToken, h.input.CURSOR_HMAC_KEY])
    assert.throws(() => loadConfig({ ...h.input, KUISENSE_MCP_READ_TOKEN: token }, projectRoot));
  assert.throws(() => readConfigEnvironment({ ...h.input, KUISENSE_MCP_REED_TOKEN: readToken }));
});

test("initialize/initialized/ping 正常，只公布唯一无参数只读工具", async t => {
  const h = fixture(t);
  const init = await h.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } });
  assert.equal(init.statusCode, 200, init.body);
  assert.equal(init.json().result.protocolVersion, "2025-11-25");
  assert.deepEqual(init.json().result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.headers["mcp-session-id"], undefined);
  const notification = await h.app.inject({ method: "POST", url: path, headers, payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(notification.statusCode, 202); assert.equal(notification.body, "");
  assert.deepEqual((await h.rpc("ping")).json().result, {});
  const tools = (await h.rpc("tools/list")).json().result.tools;
  assert.equal(tools.length, 1); assert.deepEqual(tools[0], kuisenseMcp.tool);
  assert.equal(h.reads(), 0);
});

test("无数据使用 MCP 工具错误；成功时原样返回同一最新包，读取不改写存储", async t => {
  const h = fixture(t);
  const empty = await h.rpc("tools/call", { name: "get_latest_context", arguments: {} });
  assert.equal(empty.statusCode, 200); assert.equal(empty.json().result.isError, true);
  assert.equal(JSON.parse(empty.json().result.content[0].text).code, "KUISENSE_CONTEXT_NOT_FOUND");
  h.service.upload(packet);
  const before = h.storage.kuisenseContextAccess().latest();
  for (const args of [{ name: "get_latest_context" }, { name: "get_latest_context", arguments: {} }]) {
    const result = (await h.rpc("tools/call", args)).json().result;
    assert.equal(result.isError, false); assert.deepEqual(result.structuredContent, packet);
    assert.deepEqual(JSON.parse(result.content[0].text), packet);
  }
  assert.deepEqual(h.storage.kuisenseContextAccess().latest(), before);
  const newer = { ...packet, recent_summary: "SYNTHETIC-MCP-NEW-LATEST" };
  h.service.upload(newer);
  assert.deepEqual((await h.rpc("tools/call", { name: "get_latest_context" })).json().result.structuredContent, newer);
});

test("只读/上传鉴权双向隔离，不接受 Cookie、查询令牌或错误令牌", async t => {
  const h = fixture(t); h.service.upload(packet);
  for (const authorization of ["", "Bearer wrong", "Bearer " + deviceToken]) {
    const denied = await h.rpc("tools/list", undefined, { authorization });
    assert.equal(denied.statusCode, 401); assert.ok(denied.headers["www-authenticate"]);
  }
  assert.equal((await h.rpc("tools/list", undefined, { authorization: "", cookie: "owner=synthetic" })).statusCode, 401);
  assert.equal((await h.app.inject({ method: "POST", url: path + "?token=synthetic", headers, payload: {} })).statusCode, 400);
  for (const method of ["POST", "GET"] as const) {
    const url = method === "POST" ? "/api/kuisense/context" : "/api/kuisense/context/latest";
    assert.equal((await h.app.inject({ method, url, headers, ...(method === "POST" ? { payload: packet } : {}) })).statusCode, 401);
  }
  const latest = await h.app.inject({ url: "/api/kuisense/context/latest", headers: { authorization: "Bearer " + deviceToken } });
  assert.equal(latest.statusCode, 200); assert.deepEqual(latest.json(), packet);
  assert.equal(h.reads(), 1);
});

test("拒绝越权工具/参数/批量，不读取数据、不开放资源或记忆能力", async t => {
  const h = fixture(t);
  for (const params of [
    { name: "upload_context", arguments: {} },
    { name: "get_latest_context", arguments: { path: "/etc/passwd" } },
    { name: "get_latest_context", arguments: { refresh: true } },
    { name: "get_latest_context", arguments: null },
    { name: "get_latest_context", arguments: [] },
  ]) assert.equal((await h.rpc("tools/call", params)).json().error.code, -32602);
  for (const method of ["resources/list", "resources/read", "prompts/list", "memory/write"])
    assert.equal((await h.rpc(method)).json().error.code, -32601);
  const batch = await h.app.inject({ method: "POST", url: path, headers, payload: [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_latest_context" } }] });
  assert.equal(batch.statusCode, 400); assert.equal(h.reads(), 0);
});

test("Origin、HTTP 方法、协议版本、Accept、JSON 和请求上限受限", async t => {
  const h = fixture(t);
  assert.equal((await h.rpc("tools/list", undefined, { origin: "https://untrusted.invalid" })).statusCode, 403);
  assert.equal((await h.rpc("tools/list", undefined, { origin: "null" })).statusCode, 403);
  assert.equal((await h.rpc("tools/list", undefined, { origin: h.input.PUBLIC_ORIGIN })).statusCode, 200);
  for (const method of ["GET", "DELETE", "PUT", "PATCH", "OPTIONS", "HEAD"] as const)
    assert.equal((await h.app.inject({ method, url: path, headers })).statusCode, 405);
  assert.equal((await h.rpc("ping", undefined, { "mcp-protocol-version": "unsupported" })).statusCode, 400);
  assert.equal((await h.rpc("ping", undefined, { accept: "application/json" })).statusCode, 406);
  const malformed = await h.app.inject({ method: "POST", url: path, headers, payload: '{"SYNTHETIC-SECRET-INVALID"' });
  assert.equal(malformed.statusCode, 400); assert.equal(malformed.json().error.code, -32700);
  assert.ok(!malformed.body.includes("SYNTHETIC-SECRET-INVALID"));
  const huge = await h.app.inject({ method: "POST", url: path, headers, payload: { padding: "x".repeat(8192) } });
  assert.equal(huge.statusCode, 413);
  assert.equal((await h.rpc("ping", undefined, { "content-type": "text/plain" })).statusCode, 415);
  assert.equal(h.reads(), 0);
});

test("未装配读取器返回 503；内部异常不泄露正文、路径或凭据", async t => {
  const noReader = fixture(t, true, false);
  assert.equal((await noReader.rpc("tools/list")).statusCode, 503);
  const h = fixture(t);
  h.service.latest = () => { throw new Error("SYNTHETIC-PRIVATE-ERROR /synthetic/private.db"); };
  const result = await h.rpc("tools/call", { name: "get_latest_context" });
  assert.equal(result.json().result.isError, true);
  assert.equal(JSON.parse(result.json().result.content[0].text).code, "KUISENSE_CONTEXT_UNAVAILABLE");
  assert.ok(!result.body.includes("SYNTHETIC-PRIVATE-ERROR"));
  assert.ok(!result.body.includes("private.db"));
});

test("读取响应禁止缓存；正文和两类凭据不进入日志", async t => {
  const h = fixture(t);
  h.service.upload({ ...packet, recent_summary: "SYNTHETIC-MCP-PRIVATE-MARKER" });
  const result = await h.rpc("tools/call", { name: "get_latest_context" });
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["x-content-type-options"], "nosniff");
  for (const secret of [readToken, deviceToken, "SYNTHETIC-MCP-PRIVATE-MARKER"])
    assert.ok(!h.logs().includes(secret));
});

test("MCP 全局独立限流，不占用既有设备读取通道", async t => {
  const h = fixture(t);
  for (let i = 0; i < 120; i++) assert.equal((await h.rpc("ping")).statusCode, 200);
  const limited = await h.rpc("ping");
  assert.equal(limited.statusCode, 429); assert.ok(limited.headers["retry-after"]);
  assert.equal((await h.app.inject({ url: "/api/kuisense/context/latest", headers: { authorization: "Bearer " + deviceToken } })).statusCode, 404);
});
