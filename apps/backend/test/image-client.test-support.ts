import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ChatClient, HttpError } from "@kuinest/chat-client";
import { imageUploadLimits, type ImageAttachment, type SubmitMessageRequest } from "@kuinest/contracts";

const csrf = "a".repeat(43);
const meta = (enabled: boolean) => ({ apiVersion: "0.3", mode: "synthetic", capabilities: { chat: true, history: true, resumableEvents: false, messageChanges: true, webSearch: false, proactiveMessages: false, imageAttachments: enabled }, imageLimits: imageUploadLimits });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const attachment = (id: string, bytes = 3): ImageAttachment => ({ id, mimeType: "image/png", bytes, width: 1, height: 1 });
const accepted = (id: string, conversation = "conversation-a") => ({ conversationId: conversation, clientMessageId: id, messageId: randomUUID(), replyId: randomUUID(), runId: randomUUID(), acceptedAt: "2026-09-14T00:00:00.000Z" });

test("IMG18：客户端先查询能力；未开放时不上传或提交图片，非法输入不发请求", async () => {
  const calls: string[] = [];
  const client = new ChatClient("/api/v1", async input => { calls.push(String(input)); return json(meta(false)); });
  const id = randomUUID(), original = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  await assert.rejects(client.uploadImage("conversation-a", id, original, csrf), /IMAGE_CAPABILITY_UNAVAILABLE/);
  await assert.rejects(client.submit("conversation-a", { clientMessageId: randomUUID(), text: "", imageIds: [id] }, csrf), /IMAGE_CAPABILITY_UNAVAILABLE/);
  assert.deepEqual(calls, ["/api/v1/meta", "/api/v1/meta"]);
  await assert.rejects(client.uploadImage("conversation-a", id, new Blob(["synthetic"], { type: "image/svg+xml" }), csrf), /IMAGE_INPUT_INVALID/);
  await assert.rejects(client.submit("conversation-a", { clientMessageId: randomUUID(), text: "", imageIds: [id, id] }, csrf));
  assert.equal(calls.length, 2);
});
test("IMG19：客户端原样上传Blob，固定ID和CSRF，禁止缓存/重定向且不发送文件名", async () => {
  const id = randomUUID(), raw = new Uint8Array([1, 2, 3]), expected = attachment(id), calls: { path: string; init?: RequestInit }[] = [];
  const original = new File([raw], "SYNTHETIC_PRIVATE_FILENAME.png", { type: "image/png" });
  const client = new ChatClient("/api/v1/", async (input, init) => {
    calls.push({ path: String(input), ...(init ? { init } : {}) });
    if (String(input).endsWith("/meta")) return json(meta(true));
    assert.ok(init?.body instanceof Blob); assert.deepEqual(new Uint8Array(await init.body.arrayBuffer()), raw);
    return json(expected, 201);
  });
  assert.deepEqual(await client.uploadImage("synthetic/one?", id, original, csrf), expected);
  const call = calls[1]!;
  assert.equal(call.path, "/api/v1/conversations/synthetic%2Fone%3F/images/" + id);
  assert.equal(call.init!.method, "PUT"); assert.equal(call.init!.credentials, "same-origin"); assert.equal(call.init!.redirect, "error"); assert.equal(call.init!.cache, "no-store");
  assert.deepEqual(call.init!.headers, { "Content-Type": "image/png", "X-CSRF-Token": csrf });
  assert.doesNotMatch(call.path + JSON.stringify(call.init!.headers), /SYNTHETIC_PRIVATE_FILENAME|multipart|base64/);
});
test("IMG20：客户端按元数据上限读取原Blob，类型/长度错配或多余字节均拒绝", async () => {
  const expected = attachment(randomUUID()), raw = new Uint8Array([7, 8, 9]);
  const client = new ChatClient("/api/v1", async () => new Response(raw, { headers: { "content-type": "image/png", "content-length": "3" } }));
  const result = await client.image("conversation-a", expected); assert.equal(result.type, "image/png"); assert.deepEqual(new Uint8Array(await result.arrayBuffer()), raw);
  for (const [type, length, bytes, code] of [
    ["text/html", "3", raw, "IMAGE_RESPONSE_INVALID"], ["image/png", "4", raw, "IMAGE_RESPONSE_INVALID"],
    ["image/png", "3", new Uint8Array([1, 2]), "IMAGE_RESPONSE_INCOMPLETE"], ["image/png", "3", new Uint8Array([1, 2, 3, 4]), "IMAGE_RESPONSE_TOO_LARGE"],
  ] as const) {
    const bad = new ChatClient("/api/v1", async () => new Response(bytes, { headers: { "content-type": type, "content-length": length } }));
    await assert.rejects(bad.image("conversation-a", expected), new RegExp(code));
  }
  const unauthorized = new ChatClient("/api/v1", async () => new Response("", { status: 401 }));
  await assert.rejects(unauthorized.image("conversation-a", expected), error => error instanceof HttpError && error.status === 401);
});
test("IMG21：等待能力期间固定图文和图片顺序，发送失败只查回执，不自动重发", async () => {
  const first = randomUUID(), second = randomUUID(), id = randomUUID(), receipt = accepted(id);
  const input: SubmitMessageRequest = { clientMessageId: id, text: " 合成输入\n ", imageIds: [first, second], allowWebSearch: false };
  let release!: () => void, entered!: () => void, posted = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), metaEntered = new Promise<void>(resolve => { entered = resolve; });
  const client = new ChatClient("/api/v1", async (url, init) => {
    if (String(url).endsWith("/meta")) { entered(); await gate; return json(meta(true)); }
    posted++;
    assert.deepEqual(JSON.parse(init!.body as string), { clientMessageId: id, text: " 合成输入\n ", imageIds: [first, second], allowWebSearch: false });
    assert.equal(init!.method, "POST");
    return json(receipt, 202);
  });
  const waiting = client.submit("conversation-a", input, csrf); await metaEntered;
  input.text = "调用者之后改动"; input.imageIds!.reverse(); release();
  assert.deepEqual(await waiting, receipt); assert.equal(posted, 1);
  let attempts = 0;
  const uncertain = new ChatClient("/api/v1", async () => { attempts++; throw new TypeError("synthetic-network-loss"); });
  await assert.rejects(uncertain.submit("conversation-a", { clientMessageId: id, text: "合成" }, csrf), /synthetic-network-loss/);
  assert.equal(attempts, 1);
});
test("IMG21：客户端拒绝其他图片/消息身份的响应，回执查询绑定原会话和提交ID", async () => {
  const id = randomUUID(), clientId = randomUUID(), original = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const wrong = new ChatClient("/api/v1", async url => String(url).endsWith("/meta") ? json(meta(true)) : json(attachment(randomUUID()), 201));
  await assert.rejects(wrong.uploadImage("conversation-a", id, original, csrf), /IMAGE_IDENTITY_INVALID/);
  const receipt = accepted(clientId), lookup = { submission: receipt, run: { runId: receipt.runId, origin: "user", conversationId: "conversation-a", status: "accepted", lastSequence: 1 } };
  const client = new ChatClient("/api/v1", async () => json(lookup));
  assert.deepEqual(await client.submission("conversation-a", clientId), lookup);
  await assert.rejects(client.submission("conversation-a", randomUUID()), /SUBMISSION_IDENTITY_INVALID/);
  const badSubmit = new ChatClient("/api/v1", async () => json(accepted(randomUUID()), 202));
  await assert.rejects(badSubmit.submit("conversation-a", { clientMessageId: clientId, text: "合成" }, csrf), /SUBMISSION_IDENTITY_INVALID/);
});
