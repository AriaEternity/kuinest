import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Writable } from "node:stream";
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from "../dist/ports.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { projectRoot } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { createApp } from "../dist/app.js";
import { ApiServices } from "../dist/application/service.js";
import { RunService } from "../dist/conversations/service.js";
import { submission } from "../dist/conversations/submit.js";
import type { WorkerOptions } from "../dist/conversations/worker.js";
import { syntheticProvider } from "../dist/conversations/synthetic-provider.js";
export { inspect } from "./storage-fixtures.js";
export const isCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
export async function until(check: () => boolean, milliseconds = 3000) {
  const end = Date.now() + milliseconds;
  while (!check()) { assert.ok(Date.now() < end, "合成测试条件未在期限内满足"); await delay(5); }
}
export function fixture(t: TestContext) {
  const parent = join(projectRoot, ".cache", "stage04-tests"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "runs-")), clock = { value: Date.UTC(2026, 8, 9), now() { return this.value; } }, ids = { next: (): string => randomUUID() };
  let storage = new SqliteStorage({ dataRoot: root, clock, instanceId: randomUUID() });
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of cleanups.reverse()) await close(); await storage.close(); });
  const config = loadConfig({ NODE_ENV: "development", APP_MODE: "synthetic" }, projectRoot);
  storage.apiAccess().initializeOwner({ id: "owner-a", username: "synthetic-owner", passwordHash: "synthetic-test-hash", createdAt: clock.now(), characterId: "character-a", profileId: "profile-a", versionId: "version-a" });
  storage.write("owner-a", repo => repo.createConversation("conversation-a", "character-a", "合成会话", clock.now()));
  return {
    root, clock, ids, config, get storage() { return storage; }, get store() { return storage.runAccess(); },
    cleanup(fn: () => Promise<void>) { cleanups.push(fn); },
    submit(text = "合成输入", clientMessageId: string = randomUUID(), conversation = "conversation-a", allowWebSearch = false) {
      return storage.runAccess().submit("owner-a", conversation, submission({ text, clientMessageId, allowWebSearch }), clock.now(), ids, config.limits);
    },
    conversation(id: string) { storage.write("owner-a", repo => repo.createConversation(id, "character-a", "合成会话", clock.now())); },
    async reopen(elapsed = 0) { await storage.close(); clock.value += elapsed; storage = new SqliteStorage({ dataRoot: root, clock, instanceId: randomUUID() }); },
  };
}
export function harness(t: TestContext, provider: ProviderAdapter = syntheticProvider, options: WorkerOptions = {}) {
  const f = fixture(t);
  let logs = "";
  const api = new ApiServices(f.storage.apiAccess(), f.config, f.clock, f.ids, Buffer.alloc(32, 24), { async hash() { return "synthetic-test-hash"; }, async verify(_value, hash) { return hash === "synthetic-test-hash"; } });
  const runs = new RunService(f.store, api.queries, f.clock, f.ids, f.config, provider, { pollMs: 20, flushMs: 10, timeoutMs: 2000, abortDrainMs: 30, ...options });
  const storage = { async getReadiness() { return { ...await f.storage.getReadiness(), runtimeReady: runs.ready }; }, close: () => f.storage.close() };
  const app = createApp(f.config, { clock: f.clock, ids: f.ids, provider, storage }, { api, runs, logStream: new Writable({ write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); } }) });
  f.cleanup(() => app.close()); runs.start();
  return {
    f, app, api, runs, logs: () => logs,
    async headers() {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: f.config.publicOrigin }, payload: { username: "synthetic-owner", password: "synthetic-test-password" } });
      assert.equal(response.statusCode, 200, response.body);
      return { cookie: String(response.headers["set-cookie"]).split(";")[0]!, origin: f.config.publicOrigin, "x-csrf-token": response.json().csrfToken as string };
    },
  };
}
export function controlled() {
  type Step = IteratorResult<ProviderEvent>;
  const calls: { request: ProviderRequest; signal: AbortSignal; push(event: ProviderEvent): void; end(): void }[] = [];
  let active = 0, maximum = 0;
  const provider: ProviderAdapter = {
    stream(request, signal) {
      let ended = false, waiting: ((step: Step) => void) | undefined;
      const queue: Step[] = [];
      active++; maximum = Math.max(maximum, active);
      const deliver = (step: Step) => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(step); } else queue.push(step); };
      const end = () => { if (!ended) { ended = true; active--; deliver({ done: true, value: undefined }); } };
      const call = { request, signal, push(event: ProviderEvent) { if (!ended) deliver({ done: false, value: event }); }, end };
      calls.push(call); signal.addEventListener("abort", end, { once: true });
      const iterator: AsyncIterableIterator<ProviderEvent> = {
        [Symbol.asyncIterator]() { return this; },
        next() { if (queue.length) return Promise.resolve(queue.shift()!); if (ended) return Promise.resolve({ done: true, value: undefined }); return new Promise(resolve => { waiting = resolve; }); },
        return() { signal.removeEventListener("abort", end); end(); return Promise.resolve({ done: true, value: undefined }); },
      };
      return iterator;
    },
  };
  return { provider, calls, active: () => active, maximum: () => maximum };
}
