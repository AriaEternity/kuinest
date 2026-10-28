import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { ImageValidator } from "../dist/images/validate.js";
import { requestImages, contentImages, type ImageReference } from "../dist/images/content.js";
import { wireMessages, imageRequestLimits, type ImageResolver } from "../dist/images/wire.js";
import { DeepSeekProvider, requestBody } from "../dist/providers/deepseek.js";
import { readMessage } from "../dist/providers/messages.js";
import { measure } from "../dist/context/budget.js";
import { defaults } from "../dist/context/profile.js";
import { compactionRequest } from "../dist/context/compaction.js";
import { CharacterRuntime } from "../dist/context/runtime.js";
import { submission } from "../dist/conversations/submit.js";
import { insertImage } from "../dist/storage/image-assets.js";
import { fixture, inspect, model, reply, chunk, done, isCode } from "./context-fixtures.js";
import type { ProviderRequest } from "../dist/ports.js";
import type { ProtocolMessage, DeepSeekProfile, ToolExecutor } from "../dist/providers/types.js";
import type { Profile, TokenCounter } from "../dist/context/types.js";

let samples: Promise<{ bytes: Buffer; inspection: Awaited<ReturnType<ImageValidator["inspect"]>> }[]> | undefined;
function pictures() {
  return samples ??= (async () => {
    const validator = new ImageValidator(), result = [];
    for (const format of ["png", "jpeg"] as const) {
      const bytes = await sharp({ create: { width: format === "png" ? 19 : 23, height: 7, channels: 3, background: "#3e8a92" } }).toFormat(format).toBuffer();
      result.push({ bytes, inspection: await validator.inspect(bytes) });
    }
    return result;
  })();
}
function reference(s: Awaited<ReturnType<typeof pictures>>[number]): ImageReference {
  const i = s.inspection;
  return { type: "image", id: randomUUID(), mimeType: i.mimeType, bytes: i.bytes, width: i.width, height: i.height, sha256: i.sha256 };
}
const profile: DeepSeekProfile = { mode: "synthetic", endpoint: "http://127.0.0.1:1/chat/completions", allowedOrigin: "http://127.0.0.1:1", model: "synthetic-vision", thinking: "disabled", maxTokens: 1024, imageInput: true };
function resolver(refs: ImageReference[], samples: Awaited<ReturnType<typeof pictures>>): ImageResolver {
  return image => { const at = refs.findIndex(ref => ref.id === image.id); assert.ok(at >= 0); return { ...samples[at]!.inspection, content: samples[at]!.bytes }; };
}
const request = (messages: ProtocolMessage[]): ProviderRequest => ({ system: "合成资料", messages, tools: [], options: { imageInput: true } });
const pixels = (part: { image_url: { url: string } }) => Buffer.from(part.image_url.url.split(",")[1]!, "base64");
const mockCounter = (model: string): TokenCounter => ({ id: "synthetic-vision-counter", model, verified: false, supportsImages: true, count: value => 100 + requestImages(value.messages).length * 137 });

test("IMG30：用户文字/原图块顺序发送，JSON图片字节等于原件且私有引用不泄漏", async () => {
  const samples = await pictures(), a = reference(samples[0]!), b = reference(samples[1]!);
  const original = request([{ role: "user", content: [{ type: "text", text: "合成前" }, a, { type: "text", text: "合成间" }, b] }]), before = structuredClone(original);
  const body = requestBody(original, profile, resolver([a, b], samples));
  const content = (body.messages as { content: unknown }[])[1]!.content as { type: string; text?: string; image_url: { url: string } }[];
  assert.deepEqual(content.map(p => p.type), ["text", "image_url", "text", "image_url"]);
  assert.ok(pixels(content[1]!).equals(samples[0]!.bytes)); assert.ok(pixels(content[3]!).equals(samples[1]!.bytes));
  assert.equal(content[1]!.image_url.url.startsWith("data:image/png;base64,"), true);
  assert.equal(content[3]!.image_url.url.startsWith("data:image/jpeg;base64,"), true);
  assert.deepEqual(original, before);
  assert.equal(JSON.stringify(body).includes(a.id), false); assert.equal(JSON.stringify(body).includes(a.sha256), false);
});
test("IMG31：连续工具组全部配对后追加图片，空文本占位和显式text合并符合固定旧版", async () => {
  const samples = await pictures(), a = reference(samples[0]!), b = reference(samples[1]!);
  const calls = ["a", "b"].map(id => ({ id, type: "function" as const, function: { name: "synthetic", arguments: "{}" } }));
  const original: ProtocolMessage[] = [
    { role: "assistant", content: null, tool_calls: calls },
    { role: "tool", tool_call_id: "a", content: [{ type: "text", text: "" }, { type: "text", text: "合成一" }, a, { type: "text", text: "合成二" }] },
    { role: "tool", tool_call_id: "b", content: [b] }, { role: "user", content: "合成下一轮" },
  ], before = structuredClone(original);
  const projected = wireMessages(original, true, resolver([a, b], samples));
  assert.deepEqual(projected.map(m => m.role), ["assistant", "tool", "tool", "user", "user"]);
  assert.equal(projected[1]!.content, "合成一\n合成二"); assert.equal(projected[2]!.content, "(see attached image)");
  const content = projected[3]!.content as { type: string; text?: string; image_url: { url: string } }[];
  assert.equal(content[0]!.text, "Attached image(s) from tool result:"); assert.ok(pixels(content[1]!).equals(samples[0]!.bytes)); assert.ok(pixels(content[2]!).equals(samples[1]!.bytes));
  assert.deepEqual(original, before);
  assert.throws(() => wireMessages([original[0]!, original[1]!, original[3]!, original[2]!], true, resolver([a, b], samples)), isCode("PROTOCOL_HISTORY_INCOMPLETE"));
});
test("IMG32：无图片能力、未装配解析器、引用损坏或越过请求边界时零凭据/零请求", async () => {
  const samples = await pictures(), a = reference(samples[0]!); let credentials = 0, calls = 0, resolutions = 0;
  const body = request([{ role: "user", content: [a] }]);
  const good: ImageResolver = image => { resolutions++; return resolver([a], samples)(image); };
  for (const [enabled, resolve] of [
    [false, good], [true, undefined], [true, () => { throw new Error("synthetic-private-path"); }],
    [true, () => ({ ...samples[0]!.inspection, content: Buffer.alloc(samples[0]!.bytes.length) })],
    [true, () => ({ ...samples[0]!.inspection, width: 1, content: samples[0]!.bytes })],
  ] as const) {
    const provider = new DeepSeekProvider({ ...profile, mode: "private", endpoint: "https://synthetic.invalid/chat/completions", allowedOrigin: "https://synthetic.invalid", imageInput: enabled, allowLive: true },
      () => { credentials++; return "synthetic-token"; }, async () => { calls++; throw new Error("unexpected-model"); }, {}, resolve);
    await assert.rejects(async () => { for await (const _ of provider.stream(body, new AbortController().signal)) {} }, error => {
      assert.doesNotMatch(String(error), /synthetic-private-path/); return ["PROFILE_INVALID", "CONTEXT_INVALID"].includes((error as { code: string }).code);
    });
  }
  resolutions = 0;
  const huge = Array.from({ length: 7 }, () => ({ ...a, id: randomUUID(), bytes: 10 * 1024 * 1024 }));
  assert.ok(huge.reduce((n, i) => n + i.bytes, 0) > imageRequestLimits.originalBytes);
  assert.throws(() => requestBody(request([{ role: "user", content: huge }]), profile, good), isCode("CONTEXT_TOO_LARGE"));
  assert.equal(credentials, 0); assert.equal(calls, 0); assert.equal(resolutions, 0);
});
test("IMG33：图像计数器须匹配模型与图像覆盖声明，token和base64传输预算分别记账", async () => {
  const samples = await pictures(), a = reference(samples[0]!), req = request([{ role: "user", content: [a, a] }]);
  const p: Profile = { id: "synthetic", provider: "deepseek", model: profile.model, endpoint: profile.endpoint, options: { imageInput: true, maxTokens: 1024 }, status: "synthetic" };
  assert.throws(() => measure(req, defaults, p), isCode("PROFILE_INVALID"));
  assert.throws(() => measure(req, defaults, p, { ...mockCounter(profile.model), supportsImages: false }), isCode("PROFILE_INVALID"));
  assert.throws(() => measure(req, defaults, p, mockCounter("other-model")), isCode("PROFILE_INVALID"));
  const measured = measure(req, defaults, p, mockCounter(profile.model));
  assert.equal(measured.input, 374); assert.equal(measured.verified, false); assert.equal(measured.fits, true);
  assert.deepEqual(measured.images, { count: 2, originalBytes: a.bytes * 2, base64Bytes: 4 * Math.ceil(a.bytes / 3) * 2 });
  let resolved = 0;
  wireMessages([readMessage(req.messages[0])], true, image => { resolved++; return resolver([a], samples)(image); });
  assert.equal(resolved, 1);
});
test("IMG34：摘要实际携带原图和归属，300条文字来源不膨胀成超限内容块", async () => {
  const samples = await pictures(), a = reference(samples[0]!);
  const p: Profile = { id: "synthetic", provider: "deepseek", model: profile.model, endpoint: profile.endpoint, options: { imageInput: true, thinking: "disabled", maxTokens: 1024 }, status: "synthetic" };
  const sources = Array.from({ length: 300 }, (_, index) => ({ id: "synthetic-source-" + index, message: { role: "user", content: "合成历史" + index } as ProtocolMessage }));
  sources[140]!.message = { role: "user", content: [{ type: "text", text: "合成图片归属" }, a] };
  const summary = compactionRequest(p, sources, undefined), raw = readMessage(summary.messages[0]);
  assert.equal(raw.role, "user"); assert.ok(Array.isArray(raw.content) && raw.content.length <= 3);
  assert.equal(requestImages(summary.messages).length, 1);
  assert.ok(JSON.stringify(summary).includes("synthetic-source-140")); assert.ok(JSON.stringify(summary).includes("synthetic-source-299"));
  const body = requestBody(summary, profile, resolver([a], samples));
  const parts = (body.messages as { content: { type: string; image_url: { url: string } }[] }[])[1]!.content;
  assert.ok(pixels(parts.find(part => part.type === "image_url")!).equals(samples[0]!.bytes));
  assert.equal((summary.options.sourceEntryIds as string[]).length, 300);
});
test("IMG35：CharacterRuntime真实回环工具循环发送原图，私有调用/上下文只存引用", { timeout: 15000 }, async t => {
  const samples = await pictures(), f = fixture(t), a = reference(samples[0]!), b = reference(samples[1]!);
  const upstream = await model(t, (_body, response, count) => {
    if (count === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chunk({ tool_calls: [{ index: 0, id: "picture-a", type: "function", function: { name: "synthetic_picture", arguments: "{}" } }, { index: 1, id: "picture-b", type: "function", function: { name: "synthetic_picture", arguments: "{}" } }] }) + chunk({}, "tool_calls") + done);
    } else reply(response, "【合成视觉结果】协议验证完成");
  });
  const p: Profile = { id: randomUUID(), provider: "deepseek", model: upstream.profile.model, endpoint: upstream.profile.endpoint, options: { allowedOrigin: upstream.origin, maxTokens: 1024, thinking: "disabled", imageInput: true }, status: "synthetic" };
  f.publish("纯合成视觉角色", {}, p);
  f.storage.imageAccess().putUpload({ id: a.id, ownerId: "owner-a", conversationId: "conversation-a", content: samples[0]!.bytes, inspection: samples[0]!.inspection, createdAt: f.clock.now() });
  inspect(f.root, db => db.transaction(() => insertImage(db, { id: b.id, ownerId: "owner-a", conversationId: "conversation-a", content: samples[1]!.bytes, inspection: samples[1]!.inspection, createdAt: f.clock.now() }, "import-tool", "synthetic-tool-picture")).immediate());
  const store = f.storage.runAccess({ context: true, images: true }), receipt = store.submit("owner-a", "conversation-a", submission({ clientMessageId: randomUUID(), text: "合成带图问题", imageIds: [a.id] }), f.clock.now(), f.ids, f.config.limits), claim = store.claim(f.clock.now(), f.ids)!;
  const tools: ToolExecutor = { definitions: [{ type: "function", function: { name: "synthetic_picture", parameters: { type: "object", properties: {} } } }], async invoke(tool) { return { message: { role: "tool", tool_call_id: tool.id, content: [b] }, failed: false }; } };
  const runtime = new CharacterRuntime({ storage: f.storage.contextAccess(), protocol: f.storage.protocolAccess(), clock: f.clock, ids: f.ids, counter: mockCounter(p.model), tools,
    resolve(selected, _purpose, scope) {
      assert.equal(selected.id, p.id); assert.equal(scope.id, claim.id);
      return new DeepSeekProvider({ ...upstream.profile, maxTokens: 1024, thinking: "disabled", imageInput: true }, () => { throw new Error("synthetic-no-credentials"); }, fetch, {}, image => f.storage.imageAccess().getProtocol(scope.ownerId, scope.conversationId, image.id, image.sha256));
    }
  });
  let output = "";
  for await (const event of runtime.stream(claim, new AbortController().signal)) if (event.type === "text_delta") { output += event.text; store.append(claim, event.text, f.clock.now()); }
  store.finish(claim, "completed", undefined, f.clock.now(), f.ids);
  assert.equal(output, "【合成视觉结果】协议验证完成"); assert.equal(upstream.requests.length, 2);
  const first = upstream.requests[0]!.messages as { role: string; content: unknown }[];
  const firstParts = first.at(-1)!.content as { type: string; image_url: { url: string } }[];
  assert.ok(pixels(firstParts.find(part => part.type === "image_url")!).equals(samples[0]!.bytes));
  const second = upstream.requests[1]!.messages as { role: string; content: unknown }[];
  assert.deepEqual(second.slice(-4).map(m => m.role), ["assistant", "tool", "tool", "user"]);
  const toolParts = second.at(-1)!.content as { type: string; image_url: { url: string } }[];
  assert.equal(toolParts.filter(p => p.type === "image_url").length, 2);
  for (const part of toolParts.filter(p => p.type === "image_url")) assert.ok(pixels(part).equals(samples[1]!.bytes));
  inspect(f.root, db => {
    for (const [table, column] of [["context_entries", "payload_json"], ["provider_calls", "request_manifest_json"], ["tool_calls", "result_json"]] as const) {
      const all = db.prepare("SELECT " + column + " AS value FROM " + table).all() as { value: string }[];
      assert.ok(all.some(row => row.value.includes(b.id)) || table === "provider_calls");
      assert.ok(all.every(row => !/data:image|;base64,/.test(row.value)));
    }
    assert.equal((db.prepare("SELECT count(*) AS n FROM messages WHERE role='user'").get() as { n: number }).n, 1);
  });
  assert.deepEqual(f.storage.apiAccess().history("owner-a", "conversation-a", undefined, 50).rows.find(row => row.id === receipt.messageId)!.attachments!.map(image => image.id), [a.id]);
  assert.throws(() => f.storage.imageAccess().getPublic("owner-a", "conversation-a", b.id), isCode("NOT_FOUND"));
});
