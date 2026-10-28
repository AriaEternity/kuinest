import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Writable } from "node:stream";
import { SqliteStorage } from "../dist/storage/storage.js";
import { openDatabase } from "../dist/storage/database.js";
import { projectRoot } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { submission } from "../dist/conversations/submit.js";
import { defaults, hash } from "../dist/context/profile.js";
import type { CharacterConfig, Profile } from "../dist/context/types.js";
import { CharacterRuntime } from "../dist/context/runtime.js";
import { RunService } from "../dist/conversations/service.js";
import { ApiServices } from "../dist/application/service.js";
import { createApp } from "../dist/app.js";
import { EventStreams } from "../dist/http/routes/events.js";
import { mockProvider } from "../dist/providers/mock.js";
import type { ProviderAdapter } from "../dist/ports.js";
import type { ToolExecutor } from "../dist/providers/types.js";
export { inspect, until, isCode, controlled } from "./run-fixtures.js";
export { model, chunk, done, reply } from "./provider-fixtures.js";
export const doc = (name: string, text: string) => ({ name, bytes: Buffer.from(text), sha256: hash(text) });
export function fixture(t: TestContext) {
  const parent = join(projectRoot, ".cache/stage07-tests"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "context-")), clock = { value: Date.now(), now() { return this.value; } }, ids = { next: (): string => randomUUID() };
  let storage = new SqliteStorage({ dataRoot: root, instanceId: ids.next(), clock });
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => { for (const fn of cleanups.reverse()) await fn(); await storage.close(); });
  const config = loadConfig({ NODE_ENV: "development", APP_MODE: "synthetic" }, projectRoot);
  storage.apiAccess().initializeOwner({ id: "owner-a", username: "synthetic-context", passwordHash: "synthetic-only", characterId: "character-a", versionId: "version-a", profileId: "profile-a", createdAt: clock.now() });
  storage.write("owner-a", repo => repo.createConversation("conversation-a", "character-a", "合成上下文会话", clock.now()));
  return { root, clock, ids, config, get storage() { return storage; }, get store() { return storage.runAccess({ context: true }); },
    cleanup(fn: () => Promise<void>) { cleanups.push(fn); },
    submit(text = "合成当前输入") { return storage.runAccess({ context: true }).submit("owner-a", "conversation-a", submission({ clientMessageId: ids.next(), text }), clock.now(), ids, config.limits); },
    publish(text = "合成角色新版本", overrides: Partial<CharacterConfig> = {}, provider?: Profile) {
      const versionId = ids.next();
      const p = provider ?? { id: ids.next(), provider: "mock" as const, model: "synthetic", endpoint: null, options: {}, status: "synthetic" };
      storage.characterAccess().publish("owner-a", { characterId: "character-a", versionId, profile: p, config: { ...defaults, ...overrides }, documents: [doc("SOUL.md", text)] }, clock.now());
      storage.characterAccess().activate("owner-a", "character-a", versionId); return versionId;
    },
    async reopen(elapsed = 0) { await storage.close(); clock.value += elapsed; storage = new SqliteStorage({ dataRoot: root, instanceId: ids.next(), clock }); },
  };
}
export type Fixture = ReturnType<typeof fixture>;
export function mutate(f: Fixture, action: (db: Database.Database) => void) {
  // 仅制造本测试刚创建的合成事实或故障，不访问运行目录。
  if (!f.root.startsWith(join(projectRoot, ".cache/stage07-tests"))) throw new Error("测试根越界");
  const db = openDatabase(f.root); try { db.transaction(() => action(db))(); } finally { db.close(); }
}
export function history(f: Fixture, count = 16, units = 1500) {
  mutate(f, db => {
    db.prepare("INSERT INTO branches(id,conversation_id,reason,created_at) VALUES('history-branch','conversation-a','synthetic',?)").run(f.clock.now());
    let parent: string | null = null;
    for (let i = 0; i < count; i++) for (const role of ["user", "assistant"]) {
      const id = role + "-" + i, payload = role === "user" ? { role, content: "合成事实" + i + "x".repeat(units) } : { role, content: "合成答复" + i + "y".repeat(units), reasoning_content: "synthetic-reasoning-" + i };
      db.prepare("INSERT INTO context_entries(id,conversation_id,branch_id,parent_id,kind,payload_json,created_at) VALUES(?,'conversation-a','history-branch',?,'message',?,?)").run(id, parent, JSON.stringify(payload), f.clock.now()); parent = id;
    }
    db.prepare("UPDATE branches SET head_entry_id=? WHERE id='history-branch'").run(parent);
    db.prepare("UPDATE conversations SET active_branch_id='history-branch',last_context_user_at=? WHERE id='conversation-a'").run(f.clock.now());
  });
}
export function harness(t: TestContext, f = fixture(t), provider: ProviderAdapter = mockProvider, tools?: ToolExecutor, limits: { timeoutMs?: number; abortDrainMs?: number } = {}) {
  let logs = "";
  const api = new ApiServices(f.storage.apiAccess(), f.config, f.clock, f.ids, Buffer.alloc(32, 7), { async hash() { return "synthetic-only"; }, async verify() { return true; } });
  const context = new CharacterRuntime({ storage: f.storage.contextAccess(), protocol: f.storage.protocolAccess(), ...(tools ? { tools } : {}), clock: f.clock, ids: f.ids, resolve: () => provider });
  const runs = new RunService(f.store, api.queries, f.clock, f.ids, f.config, provider, { context, flushMs: 5, pollMs: 10, timeoutMs: 5000, abortDrainMs: 50, ...limits });
  const events = new EventStreams(f.storage.eventAccess(), wake => f.storage.subscribeCommits(wake), api.sessions, f.clock);
  const app = createApp(f.config, { clock: f.clock, ids: f.ids, provider, storage: f.storage }, { api, runs, events, logStream: new Writable({ write(chunk, _encoding, cb) { logs += chunk.toString(); cb(); } }) });
  f.cleanup(() => app.close()); runs.start();
  return { f, api, runs, app, logs: () => logs, submit: (text = "合成当前输入") => runs.submit("owner-a", "conversation-a", { clientMessageId: f.ids.next(), text }) };
}
