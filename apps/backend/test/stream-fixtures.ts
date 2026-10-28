import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { request as httpRequest } from "node:http";
import { createApp } from "../dist/app.js";
import { projectRoot } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { ApiServices } from "../dist/application/service.js";
import { RunService } from "../dist/conversations/service.js";
import { EventStreams, type StreamOptions } from "../dist/http/routes/events.js";
import type { EventStorage } from "../dist/conversations/events.js";
import { ChatClient } from "../../../packages/chat-client/dist/index.js";
import { controlled, until, inspect } from "./run-fixtures.js";
export { controlled, until, inspect };

export async function network(t: TestContext, options: StreamOptions = {}, decorate?: (store: EventStorage) => EventStorage) {
  const parent = join(projectRoot, ".cache/stage05-tests"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "network-")), clock = { now: Date.now }, ids = { next: (): string => randomUUID() };
  const storage = new SqliteStorage({ dataRoot: root, clock, instanceId: randomUUID() });
  const config = loadConfig({ NODE_ENV: "development", APP_MODE: "synthetic" }, projectRoot);
  const credentials = { id: "owner-a", username: "synthetic-stream-owner", passwordHash: "synthetic-stream-hash", characterId: "character-a", versionId: "version-a", profileId: "profile-a", createdAt: clock.now() };
  storage.apiAccess().initializeOwner(credentials);
  storage.write("owner-a", repo => repo.createConversation("conversation-a", "character-a", "合成流", clock.now()));
  const api = new ApiServices(storage.apiAccess(), config, clock, ids, Buffer.alloc(32, 5), {
    async hash() { return credentials.passwordHash; }, async verify(_password, hash) { return hash === credentials.passwordHash; },
  });
  const gate = controlled(), runs = new RunService(storage.runAccess(), api.queries, clock, ids, config, gate.provider, { pollMs: 10, flushMs: 5, timeoutMs: 20000, abortDrainMs: 30 });
  const eventStore = storage.eventAccess();
  const events = new EventStreams(decorate ? decorate(eventStore) : eventStore, wake => storage.subscribeCommits(wake), api.sessions, clock, { heartbeatMs: 80, sessionMs: 30, pollMs: 20, backpressureMs: 100, ...options });
  let logs = "";
  const app = createApp(config, { clock, ids, provider: gate.provider, storage }, { api, runs, events, logStream: new Writable({ write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); } }) });
  t.after(async () => { await app.close(); });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 }); runs.start();
  const login = await fetch(origin + "/api/v1/auth/login", { method: "POST", headers: { origin: config.publicOrigin, "content-type": "application/json" }, body: JSON.stringify({ username: credentials.username, password: "synthetic-only" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!, session = await login.json() as { csrfToken: string };
  const headers = { cookie, origin: config.publicOrigin, "x-csrf-token": session.csrfToken, "content-type": "application/json" };
  const request: typeof fetch = (input, init = {}) => fetch(input, { ...init, headers: { cookie, ...Object.fromEntries(new Headers(init.headers)) } });
  const client = new ChatClient(origin + "/api/v1", request);
  return {
    root, clock, ids, storage, config, app, api, gate, runs, events, origin, headers, client, logs: () => logs,
    async submit() {
      const previous = gate.calls.length;
      const receipt = runs.submit("owner-a", "conversation-a", { clientMessageId: randomUUID(), text: "纯合成输入" });
      await until(() => gate.calls.length > previous); return receipt;
    },
    get(id: string, query = "", extra: Record<string, string> = {}) { return fetch(origin + "/api/v1/runs/" + id + "/events" + query, { headers: { cookie, ...extra }, signal: AbortSignal.timeout(6000) }); },
    async finish(text = "合成完成") { const call = gate.calls.at(-1)!; call.push({ type: "text_delta", text }); call.push({ type: "finish", reason: "stop" }); call.end(); await until(() => gate.active() === 0); },
  };
}
export function rawStream(url: string, headers: Record<string, string>) {
  return new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpRequest(url, { headers, agent: false }, response => { response.on("error", () => {}); resolve(response); });
    request.once("error", reject); request.end();
  });
}
