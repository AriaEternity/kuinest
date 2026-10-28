import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import sharp from "sharp";
import { createApp } from "../dist/app.js";
import { ApiServices } from "../dist/application/service.js";
import { ImageService, type ImageInspector } from "../dist/images/service.js";
import { ImageValidator } from "../dist/images/validate.js";
import { imageLimits, ImageFailure } from "../dist/images/types.js";
import { insertImage } from "../dist/storage/image-assets.js";
import { fixture, inspect } from "./run-fixtures.js";

let picturePromise: Promise<Buffer> | undefined;
const picture = () => picturePromise ??= sharp({ create: { width: 29, height: 11, channels: 3, background: "#ba7632" } }).withMetadata().png().toBuffer();
function harness(t: TestContext, inspector?: ImageInspector, disabled = false) {
  const f = fixture(t); let logs = "", calls = 0;
  const api = new ApiServices(f.storage.apiAccess(), f.config, f.clock, f.ids, Buffer.alloc(32, 58),
    { async hash() { return "synthetic-test-hash"; }, async verify(_password, hash) { return hash === "synthetic-test-hash"; } });
  const images = new ImageService(f.storage.imageAccess(), f.clock, inspector);
  const app = createApp(f.config, { clock: f.clock, ids: f.ids, storage: f.storage, provider: { async *stream() { calls++; throw new Error("synthetic-no-model"); } } },
    { api, ...(disabled ? {} : { images }), logStream: new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } }) });
  f.cleanup(() => app.close());
  return { f, app, api, images, logs: () => logs, calls: () => calls,
    async headers() {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: f.config.publicOrigin }, payload: { username: "synthetic-owner", password: "synthetic-password" } });
      assert.equal(res.statusCode, 200);
      return { cookie: String(res.headers["set-cookie"]).split(";")[0]!, origin: f.config.publicOrigin, "x-csrf-token": res.json().csrfToken as string, "content-type": "image/png" };
    }
  };
}
const path = (id: string, conversation = "conversation-a") => "/api/v1/conversations/" + conversation + "/images/" + id;
function headerOnly(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "PUT", headers: { ...headers, "content-length": String(imageLimits.bytes) } });
    const timer = setTimeout(() => { req.destroy(); reject(new Error("synthetic-headers-not-rejected")); }, 3000);
    req.on("error", error => { clearTimeout(timer); reject(error); });
    req.on("response", res => { res.resume(); res.once("end", () => { clearTimeout(timer); const status = res.statusCode!; req.destroy(); resolve(status); }); });
    // 不发送图片正文；服务器必须只靠请求头完成拒绝。
    req.flushHeaders();
  });
}
function heldInspector() {
  let enter!: () => void, release!: () => void, aborted!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const validator = new ImageValidator(); let first = true;
  const inspector: ImageInspector = { async inspect(bytes, mime, signal) {
    if (first) {
      first = false; enter();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { aborted(); reject(new ImageFailure("IMAGE_UNAVAILABLE")); };
        signal!.addEventListener("abort", abort, { once: true });
        if (signal!.aborted) abort();
        void gate.then(() => { signal!.removeEventListener("abort", abort); resolve(); });
      });
    }
    return validator.inspect(bytes, mime, signal);
  } };
  return { inspector, entered, release, cancelled };
}
test("IMG12：上传201/重放200/冲突409，鉴权GET原字节和安全头正确且无模型调用", { timeout: 15000 }, async t => {
  const h = harness(t), headers = await h.headers(), bytes = await picture(), id = randomUUID();
  const uploaded = await h.app.inject({ method: "PUT", url: path(id), headers, payload: bytes });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  assert.deepEqual(uploaded.json(), { id, mimeType: "image/png", width: 29, height: 11, bytes: bytes.length });
  const replay = await h.app.inject({ method: "PUT", url: path(id), headers, payload: bytes }); assert.equal(replay.statusCode, 200); assert.deepEqual(replay.json(), uploaded.json());
  const different = await sharp(bytes).jpeg().toBuffer();
  const conflict = await h.app.inject({ method: "PUT", url: path(id), headers: { ...headers, "content-type": "image/jpeg" }, payload: different });
  assert.equal(conflict.statusCode, 409);
  const fetched = await h.app.inject({ method: "GET", url: path(id), headers: { cookie: headers.cookie } });
  assert.equal(fetched.statusCode, 200); assert.ok(fetched.rawPayload.equals(bytes));
  assert.equal(fetched.headers["content-type"], "image/png"); assert.equal(fetched.headers["content-length"], String(bytes.length));
  assert.equal(fetched.headers["cache-control"], "private, no-store"); assert.equal(fetched.headers["x-content-type-options"], "nosniff");
  assert.equal(fetched.headers["content-security-policy"], "default-src 'none'; sandbox"); assert.equal(fetched.headers["referrer-policy"], "no-referrer");
  const meta = await h.app.inject({ method: "GET", url: "/api/v1/meta", headers: { cookie: headers.cookie } });
  assert.equal(meta.json().capabilities.imageAttachments, false); assert.equal(h.calls(), 0);
  assert.equal(h.logs().includes(bytes.toString("base64")), false);
});
test("IMG13：真实HTTP只发请求头，未登录/跨来源/无CSRF/跨归属即拒绝大body", { timeout: 15000 }, async t => {
  const h = harness(t), headers = await h.headers(), address = await h.app.listen({ host: "127.0.0.1", port: 0 }), url = new URL(path(randomUUID()), address);
  assert.equal(await headerOnly(url, { "content-type": "image/png" }), 401);
  assert.equal(await headerOnly(url, { ...headers, origin: "https://synthetic-untrusted.invalid" }), 403);
  assert.equal(await headerOnly(url, { ...headers, "x-csrf-token": "" }), 403);
  assert.equal(await headerOnly(new URL(path(randomUUID(), "unknown-conversation"), address), headers), 404);
  assert.equal(await headerOnly(url, { ...headers, "content-type": "image/svg+xml" }), 415);
  inspect(h.f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM image_assets").get() as { n: number }).n, 0));
});
test("IMG14：损坏/超限图片失败后释放上传槽，错误与日志不回显正文", { timeout: 15000 }, async t => {
  const h = harness(t), headers = await h.headers(), sentinel = "SYNTHETIC_IMAGE_PRIVATE_SENTINEL";
  const bad = await h.app.inject({ method: "PUT", url: path(randomUUID()), headers, payload: Buffer.from(sentinel) });
  assert.equal(bad.statusCode, 415); assert.equal(bad.json().error.code, "IMAGE_UNSUPPORTED" /* 校验器按未知魔数拒绝 */);
  const truncated = (await picture()).subarray(0, -3);
  const damaged = await h.app.inject({ method: "PUT", url: path(randomUUID()), headers, payload: truncated });
  assert.equal(damaged.statusCode, 400); assert.equal(damaged.json().error.code, "IMAGE_INVALID");
  const oversized = await h.app.inject({ method: "PUT", url: path(randomUUID()), headers, payload: Buffer.alloc(imageLimits.bytes + 1) });
  assert.equal(oversized.statusCode, 413);
  const good = await h.app.inject({ method: "PUT", url: path(randomUUID()), headers, payload: await picture() }); assert.equal(good.statusCode, 201);
  assert.equal((bad.body + oversized.body + h.logs()).includes(sentinel), false);
});
test("IMG15：上传正在解码时第二请求在body前429，撤销登录后首请求不能提交", { timeout: 15000 }, async t => {
  const held = heldInspector(), h = harness(t, held.inspector), headers = await h.headers(), bytes = await picture();
  const address = await h.app.listen({ host: "127.0.0.1", port: 0 });
  const uploading = h.app.inject({ method: "PUT", url: path(randomUUID()), headers, payload: bytes });
  await held.entered;
  assert.equal(await headerOnly(new URL(path(randomUUID()), address), headers), 429);
  const logout = await h.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { ...headers, "content-type": "application/json" }, payload: {} }); assert.equal(logout.statusCode, 204);
  held.release(); const done = await uploading; assert.equal(done.statusCode, 401);
  inspect(h.f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM image_assets").get() as { n: number }).n, 0));
});
test("IMG16：客户端断线中止解码且不保存半张图片，之后可继续上传", { timeout: 15000 }, async t => {
  const held = heldInspector(), h = harness(t, held.inspector), headers = await h.headers(), bytes = await picture();
  const address = await h.app.listen({ host: "127.0.0.1", port: 0 });
  const req = httpRequest(new URL(path(randomUUID()), address), { method: "PUT", headers: { ...headers, "content-length": String(bytes.length) } });
  req.on("error", () => {}); req.end(bytes); await held.entered; req.destroy(); await held.cancelled;
  const good = await h.app.inject({ method: "PUT", url: path(randomUUID()), headers, payload: bytes }); assert.equal(good.statusCode, 201);
  inspect(h.f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM image_assets").get() as { n: number }).n, 1));
});
test("IMG17：隐藏工具原图和跨会话读取404；未装配图片服务503", { timeout: 15000 }, async t => {
  const h = harness(t), headers = await h.headers(), bytes = await picture(), inspection = await new ImageValidator().inspect(bytes), id = randomUUID();
  inspect(h.f.root, db => db.transaction(() => insertImage(db, { id, ownerId: "owner-a", conversationId: "conversation-a", content: bytes, inspection, createdAt: h.f.clock.now() }, "import-tool", "synthetic-private-tool-image")).immediate());
  for (const conversation of ["conversation-a", "unknown"]) {
    const response = await h.app.inject({ method: "GET", url: path(id, conversation), headers: { cookie: headers.cookie } }); assert.equal(response.statusCode, 404);
  }
  const disabled = harness(t, undefined, true), login = await disabled.headers();
  assert.equal((await disabled.app.inject({ method: "PUT", url: path(randomUUID()), headers: login, payload: bytes })).statusCode, 503);
});
