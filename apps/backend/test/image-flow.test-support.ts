import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import sharp from "sharp";
import { ChatClient } from "../../../packages/chat-client/dist/index.js";
import { createApp } from "../dist/app.js";
import { ApiServices } from "../dist/application/service.js";
import { ImageService } from "../dist/images/service.js";
import { CharacterRuntime } from "../dist/context/runtime.js";
import { RunService } from "../dist/conversations/service.js";
import { EventStreams } from "../dist/http/routes/events.js";
import { DeepSeekProvider } from "../dist/providers/deepseek.js";
import { mockProvider } from "../dist/providers/mock.js";
import { requestImages } from "../dist/images/content.js";
import type { Profile, TokenCounter } from "../dist/context/types.js";
import { fixture, model, reply, inspect, isCode } from "./context-fixtures.js";

async function harness(t: TestContext, options: { images?: boolean; imageService?: boolean; selectedImages?: boolean } = {}) {
  const f = fixture(t), upstream = await model(t, (_body, response) => reply(response, "【合成图片回复】已完成协议验证"));
  const profile: Profile = { id: randomUUID(), provider: "deepseek", model: upstream.profile.model, endpoint: upstream.profile.endpoint,
    options: { allowedOrigin: upstream.origin, thinking: "disabled", maxTokens: 1024, imageInput: options.selectedImages ?? true }, status: "synthetic" };
  f.publish("纯合成图片角色", {}, profile);
  const api = new ApiServices(f.storage.apiAccess(), f.config, f.clock, f.ids, Buffer.alloc(32, 57),
    { async hash() { return "synthetic-only"; }, async verify() { return true; } });
  const store = f.storage.runAccess({ context: true, images: true });
  const counter: TokenCounter = { id: "synthetic-flow-counter", model: profile.model, verified: false, supportsImages: true,
    count: request => 200 + requestImages(request.messages).length * 139 };
  const context = new CharacterRuntime({ storage: f.storage.contextAccess(), protocol: f.storage.protocolAccess(), clock: f.clock, ids: f.ids, counter,
    resolve(selected, _purpose, claim) {
      assert.equal(selected.id, profile.id);
      return new DeepSeekProvider({ ...upstream.profile, maxTokens: 1024, thinking: "disabled", imageInput: selected.options.imageInput === true },
        () => { throw new Error("synthetic-no-credentials"); }, fetch, {},
        image => f.storage.imageAccess().getProtocol(claim.ownerId, claim.conversationId, image.id, image.sha256));
    } });
  const runs = new RunService(store, api.queries, f.clock, f.ids, f.config, mockProvider,
    { context, imageAttachments: options.images ?? true, flushMs: 5, pollMs: 10, timeoutMs: 5000 });
  const events = new EventStreams(f.storage.eventAccess(), wake => f.storage.subscribeCommits(wake), api.sessions, f.clock);
  const images = new ImageService(f.storage.imageAccess(), f.clock); let logs = "";
  const app = createApp(f.config, { clock: f.clock, ids: f.ids, storage: f.storage, provider: mockProvider }, {
    api, runs, events, ...(options.imageService === false ? {} : { images }),
    logStream: new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } })
  });
  f.cleanup(async () => { await images.close(); await app.close(); });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const login = await fetch(address + "/api/v1/auth/login", { method: "POST", headers: { Origin: f.config.publicOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "synthetic-context", password: "synthetic-password" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!, session = await login.json() as { csrfToken: string };
  // Node没有浏览器Cookie容器；测试桥只向本机同源地址补齐合成登录Cookie/Origin，实际HTTP字节仍由fetch发送。
  const request: typeof fetch = (input, init) => {
    assert.equal(new URL(String(input)).origin, address);
    const headers = new Headers(init?.headers); headers.set("Cookie", cookie);
    if (init?.method === "POST" || init?.method === "PUT") headers.set("Origin", f.config.publicOrigin);
    return fetch(input, { ...init, headers });
  };
  const client = new ChatClient(address + "/api/v1", request);
  return { f, upstream, profile, api, context, store, runs, images, client, csrf: session.csrfToken, logs: () => logs };
}
async function terminal(client: ChatClient, runId: string) {
  let last;
  for await (const snapshot of client.watch(runId, { signal: AbortSignal.timeout(8000), retryMs: 5 })) last = snapshot;
  assert.ok(last); return last;
}
const uriBytes = (part: { image_url: { url: string } }) => Buffer.from(part.image_url.url.split(",")[1]!, "base64");

test("IMG36：能力仅在完整装配并启动后公开；缺少仓储/计数器或关闭组件不能误报", { timeout: 15000 }, async t => {
  const h = await harness(t);
  assert.equal((await h.client.meta()).capabilities.imageAttachments, false);
  const make = (store = h.store, context = h.context) => new RunService(store, h.api.queries, h.f.clock, h.f.ids, h.f.config, mockProvider, { context, imageAttachments: true });
  assert.throws(() => make(h.f.storage.runAccess({ images: true })), isCode("SERVICE_NOT_READY"));
  const { counter: _counter, ...withoutCounter } = h.context.deps;
  const noCounter = new CharacterRuntime(withoutCounter);
  assert.throws(() => make(h.store, noCounter), isCode("SERVICE_NOT_READY"));
  h.runs.start();
  assert.equal((await h.client.meta()).capabilities.imageAttachments, true);
  await h.images.close();
  assert.equal((await h.client.meta()).capabilities.imageAttachments, false);
  const missing = await harness(t, { imageService: false }); missing.runs.start();
  assert.equal((await missing.client.meta()).capabilities.imageAttachments, false);
  const disabled = await harness(t, { images: false }); disabled.runs.start();
  assert.equal((await disabled.client.meta()).capabilities.imageAttachments, false);
  assert.equal(h.upstream.requests.length + missing.upstream.requests.length + disabled.upstream.requests.length, 0);
});
test("IMG37：真实HTTP客户端上传/仅图与图文/SSE/历史/读取及重放，模型收到两轮原图", { timeout: 20000 }, async t => {
  const h = await harness(t); h.runs.start();
  const png = await sharp({ create: { width: 31, height: 13, channels: 3, background: "#2376a9" } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 17, height: 9, channels: 3, background: "#a57239" } }).jpeg().toBuffer();
  const a = await h.client.uploadImage("conversation-a", randomUUID(), new Blob([new Uint8Array(png)], { type: "image/png" }), h.csrf);
  const b = await h.client.uploadImage("conversation-a", randomUUID(), new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), h.csrf);
  assert.ok(Buffer.from(await (await h.client.image("conversation-a", a)).arrayBuffer()).equals(png));
  const firstInput = { clientMessageId: randomUUID(), text: "", imageIds: [a.id] };
  const first = await h.client.submit("conversation-a", firstInput, h.csrf);
  assert.equal((await terminal(h.client, first.runId)).status, "completed");
  const replay = await h.client.submit("conversation-a", firstInput, h.csrf);
  assert.deepEqual(replay, first);
  assert.equal((await h.client.submission("conversation-a", firstInput.clientMessageId)).submission.runId, first.runId);
  const second = await h.client.submit("conversation-a", { clientMessageId: randomUUID(), text: "合成第二轮文字", imageIds: [b.id] }, h.csrf);
  assert.equal((await terminal(h.client, second.runId)).status, "completed");
  assert.equal(h.upstream.requests.length, 2);
  const firstMessages = h.upstream.requests[0]!.messages as { role: string; content: unknown }[];
  const firstParts = firstMessages.at(-1)!.content as { type: string; image_url: { url: string } }[];
  assert.deepEqual(firstParts.map(p => p.type), ["image_url"]); assert.ok(uriBytes(firstParts[0]!).equals(png));
  const secondMessages = h.upstream.requests[1]!.messages as { role: string; content: unknown }[];
  const retained = secondMessages.filter(m => m.role === "user").flatMap(m => Array.isArray(m.content) ? m.content : []);
  const images = retained.filter(p => p.type === "image_url");
  assert.equal(images.length, 2); assert.ok(uriBytes(images[0]!).equals(png)); assert.ok(uriBytes(images[1]!).equals(jpeg));
  const last = secondMessages.at(-1)!.content as { type: string; text?: string }[];
  assert.deepEqual(last.map(p => p.type), ["text", "image_url"]); assert.equal(last[0]!.text, "合成第二轮文字");
  const history = await h.client.history("conversation-a"), changes = await h.client.changes("conversation-a", 0);
  const serialized = JSON.stringify({ history, changes });
  assert.doesNotMatch(serialized, /sha256|reasoning_content|image_url|data:image/);
  assert.ok(serialized.includes(a.id) && serialized.includes(b.id));
  inspect(h.f.root, db => {
    assert.equal((db.prepare("SELECT count(*) AS n FROM messages WHERE role='user'").get() as { n: number }).n, 2);
    assert.equal((db.prepare("SELECT count(*) AS n FROM message_images").get() as { n: number }).n, 2);
    const calls = db.prepare("SELECT request_manifest_json AS value FROM provider_calls").all() as { value: string }[];
    assert.equal(calls.length, 2);
    assert.ok(calls.every(row => JSON.parse(row.value).options.imageInput === true));
    assert.ok(calls.every(row => !/data:image|;base64,/.test(row.value)));
  });
  assert.equal(h.logs().includes(png.toString("base64")), false);
  await h.runs.close();
  assert.equal((await h.client.meta()).capabilities.imageAttachments, false);
});
test("IMG38：合成链路收到不支持图片的角色profile时运行明确失败，用户附件仍可恢复", { timeout: 15000 }, async t => {
  const h = await harness(t, { selectedImages: false }); h.runs.start();
  const png = await sharp({ create: { width: 7, height: 5, channels: 3, background: "#598743" } }).png().toBuffer();
  const image = await h.client.uploadImage("conversation-a", randomUUID(), new Blob([new Uint8Array(png)], { type: "image/png" }), h.csrf);
  const accepted = await h.client.submit("conversation-a", { clientMessageId: randomUUID(), text: "", imageIds: [image.id] }, h.csrf);
  const state = await terminal(h.client, accepted.runId);
  assert.equal(state.status, "failed"); assert.equal(state.error?.code, "PROFILE_INVALID"); assert.equal(h.upstream.requests.length, 0);
  assert.ok(Buffer.from(await (await h.client.image("conversation-a", image)).arrayBuffer()).equals(png));
  inspect(h.f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM message_images").get() as { n: number }).n, 1));
});
