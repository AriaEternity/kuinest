import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { fixture, inspect, isCode } from "./run-fixtures.js";
import { submission } from "../dist/conversations/submit.js";
import { ImageValidator } from "../dist/images/validate.js";
import { contentImages, contentText, type ImageReference } from "../dist/images/content.js";
import { readMessage, validateHistory } from "../dist/providers/messages.js";
import { insertImage } from "../dist/storage/image-assets.js";
import { DeepSeekProvider } from "../dist/providers/deepseek.js";
import { mockProvider } from "../dist/providers/mock.js";
import { measure } from "../dist/context/budget.js";
import { defaults } from "../dist/context/profile.js";
import { compactionRequest } from "../dist/context/compaction.js";
import type { ProviderRequest } from "../dist/ports.js";

let samples: Promise<{ bytes: Buffer; inspection: Awaited<ReturnType<ImageValidator["inspect"]>> }> | undefined;
function picture() {
  return samples ??= (async () => {
    const bytes = await sharp({ create: { width: 31, height: 9, channels: 3, background: "#716daf" } }).png().toBuffer();
    return { bytes, inspection: await new ImageValidator().inspect(bytes) };
  })();
}
async function upload(f: ReturnType<typeof fixture>, id = randomUUID(), conversationId = "conversation-a", ownerId = "owner-a") {
  const s = await picture();
  f.storage.imageAccess().putUpload({ id, ownerId, conversationId, content: s.bytes, inspection: s.inspection, createdAt: f.clock.now() });
  return id;
}
function submit(f: ReturnType<typeof fixture>, imageIds: string[], text = "", clientMessageId = randomUUID()) {
  return f.storage.runAccess({ images: true }).submit("owner-a", "conversation-a", submission({ clientMessageId, text, imageIds }), f.clock.now(), f.ids, f.config.limits);
}
test("IMG22：仅图消息与文字后图片顺序入库，协议保留引用且公开投影不含哈希", async t => {
  const f = fixture(t), a = await upload(f), b = await upload(f), receipt = submit(f, [b, a]);
  const api = f.storage.apiAccess().history("owner-a", "conversation-a", undefined, 50);
  const user = api.rows.find(row => row.id === receipt.messageId)!;
  assert.equal(user.content, ""); assert.deepEqual(user.attachments!.map(image => image.id), [b, a]); assert.doesNotMatch(JSON.stringify(user), /sha256|decoder|base64/);
  const store = f.storage.runAccess({ images: true }), claim = store.claim(f.clock.now(), f.ids)!;
  const request = store.context(claim), message = readMessage(request.messages[0]);
  assert.equal(message.role, "user"); if (message.role !== "user") throw new Error("synthetic");
  assert.equal(contentText(message.content), ""); assert.deepEqual(contentImages(message.content).map(image => image.id), [b, a]);
  assert.ok(Object.isFrozen(message.content)); assert.ok(Array.isArray(message.content) && message.content.every(Object.isFrozen));
  inspect(f.root, db => {
    const payload = (db.prepare("SELECT payload_json FROM context_entries WHERE id=?").get(claim.contextUserEntryId) as { payload_json: string }).payload_json;
    assert.doesNotMatch(payload, /data:|base64|Buffer/);
    assert.deepEqual(JSON.parse(payload).content.map((p: ImageReference) => p.sha256), contentImages(message.content).map(p => p.sha256));
  });
});
test("IMG23：有序图片参与严格幂等，重试只保留一组消息/关联/事件，纯文字旧JSON不改变", async t => {
  const f = fixture(t), a = await upload(f), b = await upload(f), id = randomUUID(), text = " 合成原文\n ";
  const input = submission({ clientMessageId: id, text, imageIds: [a, b] });
  assert.ok(Object.isFrozen(input.imageIds));
  const first = submit(f, [a, b], text, id); assert.deepEqual(submit(f, [a, b], text, id), first);
  assert.throws(() => submit(f, [b, a], text, id), isCode("IDEMPOTENCY_CONFLICT"));
  assert.throws(() => submit(f, [a], text, id), isCode("IDEMPOTENCY_CONFLICT"));
  assert.throws(() => submit(f, [a, b], text.trim(), id), isCode("IDEMPOTENCY_CONFLICT"));
  inspect(f.root, db => {
    for (const [table, expected] of [["messages", 2], ["message_images", 2], ["runs", 1], ["run_events", 1]] as const)
      assert.equal((db.prepare("SELECT count(*) AS n FROM " + table).get() as { n: number }).n, expected);
  });
  const legacy = submission({ clientMessageId: randomUUID(), text: "合成旧输入" });
  assert.equal(legacy.inputJson, '{"text":"合成旧输入","allowWebSearch":false}');
  assert.deepEqual(legacy.imageIds, []);
  const old = f.submit("合成旧输入", legacy.clientMessageId); assert.deepEqual(f.submit("合成旧输入", legacy.clientMessageId), old);
});
test("IMG24：重复/超量/空ID、跨会话/跨owner及工具图片提交失败，无半条消息", async t => {
  const f = fixture(t), valid = await upload(f); f.conversation("other-conversation");
  const foreign = await upload(f, randomUUID(), "other-conversation");
  f.storage.provisionOwner({ id: "owner-b", username: "synthetic-b", passwordHash: "synthetic", createdAt: f.clock.now() });
  f.storage.write("owner-b", repo => { repo.createCharacter("character-b", "合成", f.clock.now()); repo.createConversation("conversation-b", "character-b", "合成", f.clock.now()); });
  const other = await upload(f, randomUUID(), "conversation-b", "owner-b"), hidden = randomUUID(), s = await picture();
  inspect(f.root, db => db.transaction(() => insertImage(db, { id: hidden, ownerId: "owner-a", conversationId: "conversation-a", content: s.bytes, inspection: s.inspection, createdAt: f.clock.now() }, "import-tool", "synthetic-hidden-image")).immediate());
  for (const ids of [[valid, valid], [], Array.from({ length: 9 }, () => randomUUID()), ["not-a-uuid"]])
    assert.throws(() => submission({ clientMessageId: randomUUID(), text: "", imageIds: ids }), isCode("INPUT_INVALID"));
  for (const id of [foreign, other, hidden, randomUUID()]) assert.throws(() => submit(f, [id]), isCode("NOT_FOUND"));
  const input = submission({ clientMessageId: randomUUID(), text: "", imageIds: [valid] });
  assert.throws(() => f.store.submit("owner-a", "conversation-a", input, f.clock.now(), f.ids, f.config.limits), isCode("SERVICE_NOT_READY"));
  inspect(f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0));
});
test("IMG25：关联或受理事件故障回滚整个提交，原先上传资产保持可重试", async t => {
  for (const table of ["message_images", "run_events"]) {
    const f = fixture(t), image = await upload(f), id = randomUUID();
    inspect(f.root, db => db.exec("CREATE TRIGGER synthetic_image_submit_fault AFTER INSERT ON " + table + " BEGIN SELECT RAISE(ABORT,'synthetic-image-submit'); END"));
    assert.throws(() => submit(f, [image], "", id), /synthetic-image-submit/);
    inspect(f.root, db => {
      for (const name of ["messages", "message_images", "runs", "run_events"]) assert.equal((db.prepare("SELECT count(*) AS n FROM " + name).get() as { n: number }).n, 0);
      assert.equal((db.prepare("SELECT count(*) AS n FROM image_assets").get() as { n: number }).n, 1);
      assert.deepEqual(db.prepare("SELECT next_public_seq,change_revision FROM conversations WHERE id='conversation-a'").get(), { next_public_seq: 1, change_revision: 0 });
      db.exec("DROP TRIGGER synthetic_image_submit_fault");
    });
    assert.ok(submit(f, [image], "", id));
  }
});
test("IMG26：原图合计超过20MiB拒绝，不压缩、不保存消息", { timeout: 20000 }, async t => {
  const f = fixture(t), bytes = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#193b75" } }).png({ compressionLevel: 0 }).toBuffer();
  const inspection = await new ImageValidator().inspect(bytes), ids = Array.from({ length: 3 }, () => randomUUID());
  assert.ok(bytes.length < 10 * 1024 * 1024 && bytes.length * 3 > 20 * 1024 * 1024);
  for (const id of ids) f.storage.imageAccess().putUpload({ id, ownerId: "owner-a", conversationId: "conversation-a", content: bytes, inspection, createdAt: f.clock.now() });
  assert.throws(() => submit(f, ids), isCode("INPUT_INVALID"));
  inspect(f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0));
});
test("IMG27：含图运行重启恢复保留原输入；损坏关联不能以无图方式继续", async t => {
  const f = fixture(t), a = await upload(f), receipt = submit(f, [a], "合成图文");
  const claim = f.store.claim(f.clock.now(), f.ids)!;
  f.store.append(claim, "合成中断片段", f.clock.now()); await f.reopen();
  assert.equal(f.store.recover(f.clock.now(), f.ids), 1);
  inspect(f.root, db => assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(receipt.runId) as { status: string }).status, "failed"));
  const next = submit(f, [a], "下一轮合成"); const current = f.store.claim(f.clock.now(), f.ids)!; assert.equal(current.id, next.runId);
  const history = f.store.context(current).messages.map(readMessage).filter(m => m.role === "user");
  assert.deepEqual(history.map(m => contentText(m.content)), ["合成图文", "下一轮合成"]);
  assert.deepEqual(history.map(m => contentImages(m.content).map(p => p.id)), [[a], [a]]);
  inspect(f.root, db => db.prepare("DELETE FROM message_images WHERE message_id=?").run(next.messageId));
  await f.reopen(); assert.throws(() => f.store.recover(f.clock.now(), f.ids), isCode("SERVICE_NOT_READY"));
});
test("IMG28：内部引用拒绝URL/base64/未知字段、伪哈希和工具组插入的伪用户消息", () => {
  const image: ImageReference = { type: "image", id: randomUUID(), sha256: "b".repeat(64), mimeType: "image/png", bytes: 120, width: 3, height: 2 };
  const message = { role: "user", content: [{ type: "text", text: "合成前" }, image, { type: "text", text: "合成后" }] };
  assert.deepEqual(readMessage(message), message);
  for (const bad of [{ ...image, url: "https://synthetic.invalid/a.png" }, { ...image, data: "synthetic-base64" }, { ...image, sha256: "invalid" }, { ...image, bytes: 0 }, { type: "image_url", image_url: { url: "synthetic" } }])
    assert.throws(() => readMessage({ role: "user", content: [bad] }), isCode("PROTOCOL_HISTORY_INCOMPLETE"));
  const assistant = { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "synthetic", arguments: "{}" } }, { id: "b", type: "function", function: { name: "synthetic", arguments: "{}" } }] };
  const a = { role: "tool", tool_call_id: "a", content: [image] }, b = { role: "tool", tool_call_id: "b", content: "合成结果" };
  assert.equal(validateHistory([assistant, a, b]).length, 3);
  assert.throws(() => validateHistory([assistant, a, message, b]), isCode("PROTOCOL_HISTORY_INCOMPLETE"));
});
test("IMG29：未接视觉的供应商、预算和摘要在调用前明确拒绝，不把引用当文字或忽略图片", async () => {
  const image: ImageReference = { type: "image", id: randomUUID(), sha256: "c".repeat(64), mimeType: "image/png", bytes: 12, width: 1, height: 1 };
  const request: ProviderRequest = { system: "纯合成", messages: [{ role: "user", content: [image] }], tools: [], options: {} };
  let credentials = 0, calls = 0, counters = 0;
  const provider = new DeepSeekProvider({ mode: "private", model: "synthetic-vision", endpoint: "https://synthetic.invalid/v1/chat/completions", allowedOrigin: "https://synthetic.invalid", allowLive: true },
    () => { credentials++; return "synthetic-token"; }, async () => { calls++; throw new Error("unexpected-call"); });
  await assert.rejects(async () => { for await (const _ of provider.stream(request, new AbortController().signal)) {} }, isCode("PROFILE_INVALID"));
  await assert.rejects(async () => { for await (const _ of mockProvider.stream(request, new AbortController().signal)) {} }, isCode("PROFILE_INVALID"));
  const p = { id: "synthetic-profile", provider: "mock" as const, model: "synthetic", endpoint: null, options: {}, status: "synthetic" };
  assert.throws(() => measure(request, defaults, p, { id: "text-only", model: "synthetic", verified: true, count() { counters++; return 1; } }), isCode("PROFILE_INVALID"));
  assert.throws(() => compactionRequest(p, [{ id: "synthetic-source", message: request.messages[0] }], undefined), isCode("PROFILE_INVALID"));
  assert.equal(credentials, 0); assert.equal(calls, 0); assert.equal(counters, 0);
});
