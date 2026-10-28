import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { AuthSession } from "@kuinest/contracts";
import { createApp } from "../dist/app.js";
import { ApiServices } from "../dist/application/service.js";
import type { Passwords } from "../dist/auth/password.js";
import { Signing } from "../dist/auth/secrets.js";
import { loadConfig } from "../dist/config.js";
import { projectRoot } from "../dist/server.js";
import { SqliteStorage } from "../dist/storage/storage.js";
export { inspect, accepted, seed, count } from "./storage-fixtures.js";

export const password = "合成测试口令-abcdefgh123";
export const fakePasswords: Passwords = { async hash(value) { return "fake:" + value; }, async verify(value, encoded) { return encoded === "fake:" + value; } };
export const isCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
export function directory(runtime = false): string {
  const parent = join(projectRoot, ...(runtime ? ["runtime", "dev-synthetic"] : [".cache", "stage03-tests"]));
  mkdirSync(parent, { recursive: true }); return mkdtempSync(join(parent, "auth-"));
}
export function fixture(t: TestContext, hasher: Passwords = fakePasswords, environment: "development" | "test" = "development") {
  const root = directory(), clock = { value: Date.UTC(2026, 8, 8), now() { return this.value; } };
  const config = loadConfig({ NODE_ENV: environment, APP_MODE: "synthetic" }, projectRoot);
  const key = Buffer.alloc(32, 39), ids = { next: randomUUID };
  let storage: SqliteStorage, api: ApiServices, app: FastifyInstance, output = "";
  function open() {
    storage = new SqliteStorage({ dataRoot: root, clock, instanceId: randomUUID() });
    api = new ApiServices(storage.apiAccess(), config, clock, ids, key, hasher);
    app = createApp(config, { clock, ids, storage, provider: { async *stream() { throw new Error("测试不得调用模型"); } } }, {
      api, memoryReview: storage.memoryReviewAccess(), logStream: new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }),
    });
  }
  open();
  t.after(() => app.close());
  return {
    root, clock, config, key, get storage() { return storage; }, get api() { return api; }, get app() { return app; }, logs: () => output,
    signing: new Signing(key),
    init(hash = "fake:" + password) {
      storage.apiAccess().initializeOwner({ id: "owner-a", username: "synthetic-a", passwordHash: hash, createdAt: clock.now(), characterId: "character-a", versionId: "version-a", profileId: "profile-a" });
    },
    async reopen(elapsed = 0) { await app.close(); clock.value += elapsed; open(); },
    async login(username = "synthetic-a", supplied = password, address = "127.0.0.1") {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: address, headers: { origin: config.publicOrigin }, payload: { username, password: supplied } });
      assert.equal(response.statusCode, 200, response.body);
      const raw = response.headers["set-cookie"]; assert.equal(typeof raw, "string");
      return { cookie: (raw as string).split(";")[0]!, raw: raw as string, ...response.json<AuthSession>() };
    },
  };
}
export type Session = Awaited<ReturnType<ReturnType<typeof fixture>["login"]>>;
export const writeHeaders = (session: Session, origin = "http://127.0.0.1:4317") => ({ cookie: session.cookie, origin, "x-csrf-token": session.csrfToken });
export const clientId = "00000000-0000-4000-8000-000000000003";
