import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createServer, type ServerResponse } from "node:http";
import { SqliteStorage } from "../dist/storage/storage.js";
import { loadConfig } from "../dist/config.js";
import { projectRoot } from "../dist/server.js";
import { RunService } from "../dist/conversations/service.js";
import { ApiServices } from "../dist/application/service.js";
import { createApp } from "../dist/app.js";
import { EventStreams } from "../dist/http/routes/events.js";
import { DeepSeekProvider, type TransportOptions } from "../dist/providers/deepseek.js";
import type { ProviderAdapter } from "../dist/ports.js";
import type { ToolExecutor } from "../dist/providers/types.js";
import type { WorkerOptions } from "../dist/conversations/worker.js";
import { submission } from "../dist/conversations/submit.js";
export { until, inspect, controlled, isCode } from "./run-fixtures.js";

export function fixture(t: TestContext) {
  const parent = join(projectRoot, ".cache/stage06-tests"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "protocol-")), clock = { value: Date.now(), now() { return this.value; } }, ids = { next: (): string => randomUUID() };
  let storage = new SqliteStorage({ dataRoot: root, instanceId: randomUUID(), clock });
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => { for (const fn of cleanups.reverse()) await fn(); await storage.close(); });
  const config = loadConfig({ NODE_ENV: "development", APP_MODE: "synthetic" }, projectRoot);
  storage.apiAccess().initializeOwner({ id: "owner-a", username: "synthetic-protocol", passwordHash: "synthetic-protocol-hash", characterId: "character-a", versionId: "version-a", profileId: "profile-a", createdAt: clock.now() });
  storage.write("owner-a", repo => repo.createConversation("conversation-a", "character-a", "合成协议会话", clock.now()));
  return {
    root, clock, ids, config, get storage() { return storage; }, get store() { return storage.runAccess(); },
    cleanup(fn: () => Promise<void>) { cleanups.push(fn); },
    submit(text = "纯合成请求") { return storage.runAccess().submit("owner-a", "conversation-a", submission({ clientMessageId: randomUUID(), text }), clock.now(), ids, config.limits); },
    async reopen(elapsed = 0) { await storage.close(); clock.value += elapsed; storage = new SqliteStorage({ dataRoot: root, instanceId: randomUUID(), clock }); },
  };
}
export function harness(t: TestContext, provider: ProviderAdapter, options: WorkerOptions = {}) {
  const f = fixture(t); let logs = "";
  const api = new ApiServices(f.storage.apiAccess(), f.config, f.clock, f.ids, Buffer.alloc(32, 6), { async hash() { return "synthetic-protocol-hash"; }, async verify() { return true; } });
  const runs = new RunService(f.store, api.queries, f.clock, f.ids, f.config, provider, { protocol: f.storage.protocolAccess(), pollMs: 10, flushMs: 5, abortDrainMs: 50, timeoutMs: 5000, ...options });
  const events = new EventStreams(f.storage.eventAccess(), wake => f.storage.subscribeCommits(wake), api.sessions, f.clock);
  const app = createApp(f.config, { clock: f.clock, ids: f.ids, provider, storage: f.storage }, { api, runs, events, logStream: new Writable({ write(chunk, _encoding, cb) { logs += chunk.toString(); cb(); } }) });
  f.cleanup(() => app.close()); runs.start();
  return { f, api, runs, app, logs: () => logs, submit(text = "合成协议输入") { return runs.submit("owner-a", "conversation-a", { clientMessageId: randomUUID(), text }); },
    async headers() {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: f.config.publicOrigin }, payload: { username: "synthetic-protocol", password: "synthetic-only" } });
      assert.equal(response.statusCode, 200);
      return { cookie: String(response.headers["set-cookie"]).split(";")[0]!, origin: f.config.publicOrigin, "x-csrf-token": response.json().csrfToken as string, "content-type": "application/json" };
    },
  };
}
export function chunk(delta: object = {}, finish: string | null = null, usage?: object): string {
  return "data: " + JSON.stringify({ id: "synthetic-completion", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + "\n\n";
}
export const done = "data: [DONE]\n\n";
export function reply(response: ServerResponse, text = "合成回复", reasoning = "synthetic-private-reasoning") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk({ reasoning_content: reasoning }) + chunk({ content: text }) + chunk({}, "stop", { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16, prompt_cache_hit_tokens: 2 }) + done);
}
export async function model(t: TestContext, handler: (body: Record<string, unknown>, response: ServerResponse, count: number) => void | Promise<void>, options: TransportOptions = {}) {
  const requests: Record<string, unknown>[] = [], headers: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = ""; request.on("data", data => { body += data; });
    request.on("end", () => {
      requests.push(JSON.parse(body)); headers.push({ ...request.headers });
      void Promise.resolve(handler(requests.at(-1)!, response, requests.length)).catch(() => response.destroy());
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = "http://127.0.0.1:" + address.port;
  const profile = { mode: "synthetic" as const, endpoint: origin + "/chat/completions", allowedOrigin: origin, model: "deepseek-v4-flash" };
  const provider = new DeepSeekProvider(profile, () => { throw new Error("合成服务不得读取凭据"); }, fetch, { headersMs: 1000, idleMs: 1000, totalMs: 5000, ...options });
  return { provider, profile, requests, headers, origin };
}
