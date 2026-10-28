import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkPassword, PasswordHasher } from "../dist/auth/password.js";
import { readTerminal } from "../dist/auth/terminal.js";
import { loadSyntheticKey } from "../dist/auth/secrets.js";
import { tokenHash } from "../dist/auth/sessions.js";
import { projectRoot } from "../dist/server.js";
import { fixture, isCode, password, fakePasswords, directory, inspect } from "./auth-fixtures.js";

test("A01：真实异步 scrypt 随机盐、固定参数、未知账号等价路径与单并发闸门", async () => {
  const hasher = new PasswordHasher();
  const pending = hasher.hash(password);
  await assert.rejects(hasher.verify(password), isCode("RATE_LIMITED"));
  const first = await pending, second = await hasher.hash(password);
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$v1\$131072\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(await hasher.verify(password, first), true);
  assert.equal(await hasher.verify(" " + password, first), false);
  assert.equal(await hasher.verify(password), false);
  assert.equal(await hasher.verify(password, first.replace("131072", "2")), false);
  for (const value of ["short", "\ud800".repeat(12), "x".repeat(257)]) assert.throws(() => checkPassword(value, true), isCode("INPUT_INVALID"));
  assert.doesNotThrow(() => checkPassword("🌻".repeat(256), true));
});
test("A01/A07：真实密码哈希贯穿 HTTP 登录，Cookie 仅持不透明令牌，数据库与日志无原文", async t => {
  const hasher = new PasswordHasher(), hash = await hasher.hash(password), f = fixture(t, hasher); f.init(hash);
  const session = await f.login(), token = session.cookie.split("=")[1]!;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(token, session.csrfToken);
  assert.match(session.raw, /HttpOnly/); assert.match(session.raw, /SameSite=Strict/);
  assert.match(session.raw, /Path=\//); assert.doesNotMatch(session.raw, /Secure|Domain=/);
  inspect(f.root, db => {
    const stored = db.prepare("SELECT token_hash,csrf_token FROM auth_sessions").get() as { token_hash: string; csrf_token: string };
    assert.equal(stored.token_hash, tokenHash(token)); assert.notEqual(stored.token_hash, token); assert.equal(stored.csrf_token, session.csrfToken);
    assert.equal((db.prepare("SELECT password_hash AS hash FROM owners").get() as { hash: string }).hash, hash);
  });
  const current = await f.app.inject({ url: "/api/v1/auth/session", headers: { cookie: session.cookie } });
  assert.equal(current.statusCode, 200);
  assert.deepEqual(Object.keys(current.json()).sort(), ["csrfToken", "expiresAt", "ownerId"]);
  for (const secret of [password, hash, token, session.csrfToken]) assert.equal(f.logs().includes(secret), false);
});
test("A01：除显式 development 回环模式外 Cookie 使用 Secure 与 __Host 前缀", async t => {
  const f = fixture(t, fakePasswords, "test"); f.init(); const session = await f.login();
  assert.match(session.raw, /^__Host-kuinest_session=/); assert.match(session.raw, /; Secure/); assert.doesNotMatch(session.raw, /Domain=/);
});
test("A02：服务器闲置 24 小时与最长 7 天到期，触达写入不频于一分钟", async t => {
  const f = fixture(t); f.init(); const session = await f.login(), token = session.cookie.split("=")[1]!;
  const original = f.clock.now();
  f.clock.value += 1000; f.api.sessions.authenticate(token);
  const lastSeen = () => inspect(f.root, db => (db.prepare("SELECT last_seen_at AS value FROM auth_sessions").get() as { value: number }).value);
  assert.equal(lastSeen(), original);
  await f.reopen(60000); f.api.sessions.authenticate(token); assert.equal(lastSeen(), original + 61000);
  await f.reopen(86400000); assert.throws(() => f.api.sessions.authenticate(token), isCode("AUTH_REQUIRED"));
  const second = await f.login(), secondToken = second.cookie.split("=")[1]!;
  for (let day = 0; day < 14; day++) {
    await f.reopen(12 * 3600000);
    if (day < 13) assert.doesNotThrow(() => f.api.sessions.authenticate(secondToken));
    else assert.throws(() => f.api.sessions.authenticate(secondToken), isCode("AUTH_REQUIRED"));
  }
});
test("A02：修改口令原子撤销所有会话，正在验证旧哈希也不能新建会话", async t => {
  const f = fixture(t); f.init();
  const first = await f.login(), second = await f.login();
  f.storage.apiAccess().changePassword("owner-a", "fake:" + password, "fake:new-synthetic-password", f.clock.now());
  for (const s of [first, second]) assert.equal((await f.app.inject({ url: "/api/v1/auth/session", headers: { cookie: s.cookie } })).statusCode, 401);
  let release!: (value: boolean) => void;
  const slow = { ...fakePasswords, verify: async () => new Promise<boolean>(resolve => { release = resolve; }) };
  const g = fixture(t, slow); g.init();
  const pending = g.api.sessions.login("synthetic-a", password, "127.0.0.1");
  g.storage.apiAccess().changePassword("owner-a", "fake:" + password, "changed-during-hash", g.clock.now());
  release(true); await assert.rejects(pending, isCode("AUTH_INVALID"));
  inspect(g.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM auth_sessions").get() as { n: number }).n, 0));
});
test("A05：来源五次限制先于哈希且跨重启，数据库只保留摘要", async t => {
  let calls = 0;
  const f = fixture(t, { ...fakePasswords, async verify(value, hash) { calls++; return fakePasswords.verify(value, hash); } }); f.init();
  for (let i = 0; i < 5; i++) await assert.rejects(f.api.sessions.login("missing", password, "192.0.2.9"), isCode("AUTH_INVALID"));
  await f.reopen();
  await assert.rejects(f.api.sessions.login("synthetic-a", password, "192.0.2.9"), isCode("RATE_LIMITED")); assert.equal(calls, 5);
  inspect(f.root, db => assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM auth_throttles").all()), /192\.0\.2\.9/));
  await f.reopen(60000); assert.ok(await f.api.sessions.login("synthetic-a", password, "192.0.2.9"));
});
test("A05：全局十次失败冷却十分钟，重启保留；到期或本地解锁可恢复", async t => {
  const f = fixture(t); f.init();
  for (let i = 0; i < 10; i++) await assert.rejects(f.api.sessions.login("missing", password, "192.0.2." + i), isCode("AUTH_INVALID"));
  await f.reopen();
  const blocked = await f.app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: "192.0.2.30", headers: { origin: f.config.publicOrigin }, payload: { username: "synthetic-a", password } });
  assert.equal(blocked.statusCode, 429); assert.equal(blocked.headers["retry-after"], "600");
  await f.reopen(600000); await f.login();
  for (let i = 0; i < 10; i++) await assert.rejects(f.api.sessions.login("missing", password, "192.0.2." + i), isCode("AUTH_INVALID"));
  f.storage.apiAccess().unlockLogin(); await f.login();
});
test("A05：每账号 API 每分钟 120 次，返回 Retry-After 并随窗口恢复", async t => {
  const f = fixture(t); f.init(); const s = await f.login();
  for (let i = 0; i < 120; i++) assert.equal((await f.app.inject({ url: "/api/v1/meta", headers: { cookie: s.cookie } })).statusCode, 200);
  const blocked = await f.app.inject({ url: "/api/v1/meta", headers: { cookie: s.cookie } });
  assert.equal(blocked.statusCode, 429); assert.equal(blocked.headers["retry-after"], "60");
  await f.reopen(60000); assert.equal((await f.app.inject({ url: "/api/v1/meta", headers: { cookie: s.cookie } })).statusCode, 200);
});
class SyntheticTerminal extends EventEmitter {
  isTTY = true; isRaw = false; text = ""; paused = false;
  setRawMode(value: boolean) { this.isRaw = value; return this; }
  resume() { this.paused = false; return this; }
  pause() { this.paused = true; return this; }
  write(value: string) { this.text += value; return true; }
}
test("A01：隐藏口令终端处理 UTF-8 分包、退格、取消与 EOF，退出恢复原模式", async () => {
  const terminal = new SyntheticTerminal(), pending = readTerminal("合成提示：", true, 256, terminal, terminal);
  const bytes = Buffer.from("葵"); terminal.emit("data", bytes.subarray(0, 1)); terminal.emit("data", bytes.subarray(1));
  terminal.emit("data", "x\b花\r"); assert.equal(await pending, "葵花");
  assert.equal(terminal.text, "合成提示：\n"); assert.equal(terminal.isRaw, false); assert.equal(terminal.paused, true);
  for (const event of ["end", "error", "data"] as const) {
    const next = readTerminal("", true, 256, terminal, terminal);
    terminal.emit(event, event === "data" ? "\u0003" : new Error("synthetic-private-marker"));
    await assert.rejects(next, isCode("INPUT_CANCELLED"));
    assert.equal(terminal.listenerCount("data"), 0); assert.equal(terminal.listenerCount("end"), 0); assert.equal(terminal.isRaw, false);
  }
  terminal.isTTY = false; assert.throws(() => readTerminal("", true, 256, terminal, terminal), isCode("INTERACTIVE_TERMINAL_REQUIRED"));
});
test("A01：签名密钥仅在当前合成目录创建并持久化，异常长度拒绝", () => {
  const root = directory(), key = loadSyntheticKey(root); assert.equal(key.length, 32); assert.deepEqual(loadSyntheticKey(root), key);
  assert.equal(readFileSync(join(root, "cursor-hmac.key")).length, 32);
  writeFileSync(join(root, "cursor-hmac.key"), "synthetic-broken");
  assert.throws(() => loadSyntheticKey(root), isCode("LOCAL_KEY_INVALID"));
});
test("A01：CLI 分发可用、拒绝命令行口令与管道输入，在线租约阻止维护", async t => {
  const f = fixture(t); f.init();
  // CLI 根目录必须是新建合成路径；不读取现有演示或私人资料。
  const root = directory(true), env: NodeJS.ProcessEnv = { NODE_ENV: "development", APP_MODE: "synthetic", DATA_ROOT: root };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: projectRoot, env, encoding: "utf8", timeout: 30000, windowsHide: true });
  const unlock = run("scripts/project.mjs", "auth-unlock"); assert.equal(unlock.status, 0, unlock.stderr); assert.match(unlock.stdout, /"operation":"auth-unlock"/);
  const nonTTY = run("apps/backend/dist/auth/cli.js", "owner-init"); assert.equal(nonTTY.status, 1); assert.match(nonTTY.stderr, /INTERACTIVE_TERMINAL_REQUIRED/);
  const bad = run("apps/backend/dist/auth/cli.js", "owner-init", "--password=synthetic-secret");
  assert.equal(bad.status, 1); assert.doesNotMatch(bad.stderr, /synthetic-secret/);
  const { SqliteStorage } = await import("../dist/storage/storage.js");
  const leased = new SqliteStorage({ dataRoot: root, instanceId: "cli-test", clock: { now: Date.now } }); t.after(() => leased.close());
  const busy = run("apps/backend/dist/auth/cli.js", "auth-unlock"); assert.equal(busy.status, 1); assert.match(busy.stderr, /LEASE_BUSY/);
});
