import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, password, writeHeaders, isCode, inspect, accepted, seed, clientId, count } from "./auth-fixtures.js";

test("A01：错误口令与未知账号返回同形安全错误，不回显任何输入", async t => {
  const f = fixture(t); f.init();
  const replies = [];
  for (const username of ["synthetic-a", "synthetic-unknown-marker"]) {
    const reply = await f.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: f.config.publicOrigin }, payload: { username, password: "synthetic-wrong-marker" } });
    assert.equal(reply.statusCode, 401); replies.push(reply.json().error);
    assert.doesNotMatch(reply.body + f.logs(), /synthetic-unknown-marker|synthetic-wrong-marker/);
    assert.equal(reply.headers["cache-control"], "no-store"); assert.equal(reply.headers["set-cookie"], undefined);
  }
  assert.deepEqual(replies[0], replies[1]); assert.equal(replies[0].code, "AUTH_INVALID");
});
test("A03：登录拒绝缺失/null/跨站 Origin、表单和非 JSON，不信任伪造转发来源", async t => {
  const f = fixture(t); f.init();
  for (const origin of [undefined, "null", "https://synthetic.invalid", f.config.publicOrigin + "/"]) {
    const response = await f.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: origin ? { origin } : {}, payload: { username: "synthetic-a", password } });
    assert.equal(response.statusCode, 403); assert.equal(response.json().error.code, "ORIGIN_FORBIDDEN"); assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
  const form = await f.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: f.config.publicOrigin, "content-type": "application/x-www-form-urlencoded" }, payload: "username=synthetic-a" });
  assert.equal(form.statusCode, 400);
  for (let i = 0; i < 5; i++) assert.equal((await f.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: f.config.publicOrigin, "x-forwarded-for": "192.0.2." + i }, payload: { username: "missing", password } })).statusCode, 401);
  const blocked = await f.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: f.config.publicOrigin, "x-forwarded-for": "192.0.2.99" }, payload: { username: "synthetic-a", password } });
  assert.equal(blocked.statusCode, 429);
});
test("A03：写请求需要有效 Cookie、精确 Origin 与独立 CSRF；退出撤销并清 Cookie", async t => {
  const f = fixture(t); f.init(); const s = await f.login(), base = writeHeaders(s);
  const create = (headers: Record<string, string>) => f.app.inject({ method: "POST", url: "/api/v1/conversations", headers, payload: { title: "合成标题" } });
  for (const headers of [{}, { origin: base.origin, "x-csrf-token": s.csrfToken }]) assert.equal((await create(headers)).statusCode, 401);
  for (const headers of [{ cookie: s.cookie }, { ...base, origin: "null" }]) assert.equal((await create(headers)).statusCode, 403);
  for (const token of ["", "a".repeat(43), s.cookie.split("=")[1]!]) assert.equal((await create({ ...base, "x-csrf-token": token })).statusCode, 403);
  assert.equal((await create(base)).statusCode, 201);
  const logout = await f.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: base });
  assert.equal(logout.statusCode, 204); assert.equal(logout.body, ""); assert.match(String(logout.headers["set-cookie"]), /Max-Age=0|Expires=Thu, 01 Jan 1970/);
  assert.equal((await f.app.inject({ url: "/api/v1/auth/session", headers: { cookie: s.cookie } })).statusCode, 401);
});
test("A02：缺失、伪造、重复 Cookie 都不能建立认证身份", async t => {
  const f = fixture(t); f.init(); const s = await f.login();
  for (const cookie of ["", "kuinest_dev_session=not-a-token", s.cookie + "; " + s.cookie, "kuinest_dev_session=" + "a".repeat(43), "csrfToken=" + s.csrfToken]) {
    const response = await f.app.inject({ url: "/api/v1/auth/session", headers: { cookie } }); assert.equal(response.statusCode, 401);
  }
});
test("A01：初始化仅单 owner，演示角色原子绑定，事务失败与重复初始化无残留", t => {
  const f = fixture(t);
  const record = { id: "owner-a", username: "synthetic-a", passwordHash: "fake", createdAt: f.clock.now(), characterId: "character-a", versionId: "version-a", profileId: "profile-a" };
  assert.throws(() => f.storage.apiAccess().initializeOwner({ ...record, profileId: null as unknown as string }));
  inspect(f.root, db => assert.equal(count(db, "owners"), 0));
  f.init(); assert.throws(() => f.storage.apiAccess().initializeOwner(record), isCode("SERVICE_NOT_READY"));
  const c = f.api.queries.createConversation("owner-a", undefined); assert.equal(c.title, "新会话");
  inspect(f.root, db => {
    assert.equal(count(db, "owners"), 1);
    const character = db.prepare("SELECT name,active_version_id FROM characters").get() as { name: string; active_version_id: string };
    assert.equal(character.name, "合成演示角色"); assert.equal(character.active_version_id, "version-a");
    db.prepare("UPDATE characters SET active_version_id=NULL WHERE id='character-a'").run();
  });
  assert.throws(() => f.api.queries.createConversation("owner-a", undefined), isCode("SERVICE_NOT_READY"));
});
test("A04：所有会话/运行入口将跨 owner 和不存在对象统一返回 404", async t => {
  const f = fixture(t); seed(f.storage);
  // 两个账号与运行均完全合成；CLI 实际仍只允许首个 owner。
  f.storage.apiAccess().changePassword("owner-a", "synthetic-not-a-password-hash", "fake:" + password, f.clock.now());
  for (const suffix of ["a", "b"]) f.storage.write("owner-" + suffix, repo => accepted(repo, suffix));
  const s = await f.login("合成主人-a"), headers = writeHeaders(s);
  const urls = [
    ["GET", "/api/v1/conversations/conversation-b/messages"],
    ["GET", "/api/v1/conversations/conversation-b/changes?afterRevision=0"],
    ["GET", "/api/v1/conversations/conversation-b/submissions/" + clientId],
    ["GET", "/api/v1/runs/run-b"], ["GET", "/api/v1/runs/run-b/events"],
    ["POST", "/api/v1/runs/run-b/cancel"], ["POST", "/api/v1/conversations/conversation-b/messages"],
  ] as const;
  for (const [method, url] of urls) {
    const payload = url.endsWith("/messages") && method === "POST" ? { text: "合成", clientMessageId: clientId } : undefined;
    const response = await f.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 404, url + ": " + response.body); assert.equal(response.json().error.code, "NOT_FOUND");
    const absent = await f.app.inject({ method, url: url.replace("conversation-b", "absent").replace("run-b", "absent"), headers, ...(payload ? { payload } : {}) });
    assert.deepEqual(absent.json().error, response.json().error);
  }
});
test("阶段边界：未开放的写任务和 SSE 保持 503，不创建消息/运行或误返回 202", async t => {
  const f = fixture(t); seed(f.storage); f.storage.apiAccess().changePassword("owner-a", "synthetic-not-a-password-hash", "fake:" + password, f.clock.now());
  f.storage.write("owner-a", repo => accepted(repo)); const s = await f.login("合成主人-a"), headers = writeHeaders(s);
  const before = inspect(f.root, db => [count(db, "messages"), count(db, "runs"), count(db, "run_events")]);
  for (const [method, url, payload] of [
    ["POST", "/api/v1/conversations/conversation-a/messages", { text: "合成", clientMessageId: clientId }],
    ["POST", "/api/v1/runs/run-a/cancel", undefined],
    ["GET", "/api/v1/runs/run-a/events?afterSequence=0", undefined],
  ] as const) {
    const response = await f.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, "SERVICE_NOT_READY"); assert.doesNotMatch(String(response.headers["content-type"]), /text\/event-stream/);
  }
  inspect(f.root, db => assert.deepEqual([count(db, "messages"), count(db, "runs"), count(db, "run_events")], before));
  const meta = await f.app.inject({ url: "/api/v1/meta", headers }); assert.equal(meta.statusCode, 200);
  assert.deepEqual(meta.json().capabilities, { chat: false, history: true, resumableEvents: false, messageChanges: true, webSearch: false, proactiveMessages: false, imageAttachments: false });
});
test("A06/A07：严格请求字段、类型、Unicode 长度和安全错误响应", async t => {
  const f = fixture(t); f.init(); const s = await f.login(), headers = writeHeaders(s);
  for (const payload of [{ title: "x", characterId: "forbidden" }, { title: 42 }, { title: "葵".repeat(101) }, { title: null }]) {
    const response = await f.app.inject({ method: "POST", url: "/api/v1/conversations", headers, payload }); assert.equal(response.statusCode, 400);
  }
  const created = await f.app.inject({ method: "POST", url: "/api/v1/conversations", headers, payload: { title: "🌻".repeat(100) } }); assert.equal(created.statusCode, 201);
  const id = created.json().id as string;
  const input = { text: " 合成原文 ", clientMessageId: clientId };
  for (const payload of [{ ...input, role: "system" }, { ...input, allowWebSearch: "true" }, { ...input, text: "   " }, { ...input, text: "葵".repeat(32001) }]) {
    const response = await f.app.inject({ method: "POST", url: "/api/v1/conversations/" + id + "/messages", headers, payload }); assert.equal(response.statusCode, 400);
  }
  for (const url of ["/api/v1/meta?unknown=synthetic-query-marker", "/api/v1/conversations?limit=01", "/api/v1/conversations?limit=101", "/api/v1/conversations?limit=1&limit=2", "/api/v1/conversations/" + id + "/changes?afterRevision=9007199254740992"]) {
    const response = await f.app.inject({ url, headers }); assert.equal(response.statusCode, 400); assert.doesNotMatch(response.body + f.logs(), /synthetic-query-marker|stack|reasoning_content/);
  }
  const extra = await f.app.inject({ method: "POST", url: "/api/v1/auth/login", headers, payload: { username: "synthetic-a", password, extra: true } }); assert.equal(extra.statusCode, 400);
  const large = await f.app.inject({ method: "POST", url: "/api/v1/conversations", headers, payload: { title: "x".repeat(192 * 1024) } }); assert.equal(large.statusCode, 413);
  const logout = await f.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers, payload: { extra: true } }); assert.equal(logout.statusCode, 400);
});

test("A07：公开接口遇到存储异常或失租只返回安全错误", async t => {
  const f = fixture(t); f.init(); const s = await f.login();
  f.api.queries.conversations = () => { throw new Error("synthetic-database-path-and-password-marker"); };
  const broken = await f.app.inject({ url: "/api/v1/conversations", headers: { cookie: s.cookie } });
  assert.equal(broken.statusCode, 500); assert.equal(broken.json().error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(broken.body + f.logs(), /synthetic-database-path-and-password-marker|stack/);
  f.clock.value += 30000;
  const lost = await f.app.inject({ url: "/api/v1/meta", headers: { cookie: s.cookie } });
  assert.equal(lost.statusCode, 503); assert.equal(lost.json().error.code, "SERVICE_NOT_READY");
});
