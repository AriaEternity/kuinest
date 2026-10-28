import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { apply, verify } from "../../../tools/import-openclaw/dist/apply.js";
import { loadBundle } from "../../../tools/import-openclaw/dist/capture.js";
import { analyze } from "../../../tools/import-openclaw/dist/validate.js";
import { imageIdentity } from "../../../tools/import-openclaw/dist/images.js";
import { uid } from "../../../tools/import-openclaw/dist/safe.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { restoreDatabase } from "../dist/storage/backup.js";
import { wireMessages } from "../dist/images/wire.js";
import { readMessage } from "../dist/providers/messages.js";
import { contentImages } from "../dist/images/content.js";
import { fixture, entry, next, put, sessionBytes, inspect, key } from "./import-fixtures.js";

const isCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
let originals: Promise<Buffer[]> | undefined;
function pictures() {
  return originals ??= Promise.all(["png", "jpeg"].map(async format => {
    const input = sharp({ create: { width: 19, height: 11, channels: 3, background: "#7b598a" } });
    return format === "png" ? input.png().toBuffer() : input.jpeg().toBuffer();
  }));
}
const block = (bytes: Buffer, mimeType = "image/png") => ({ type: "image", mimeType, data: bytes.toString("base64") });
function records(png: Buffer, jpeg: Buffer) { return [
  entry("u1", null, { role: "user", content: [{ type: "text", text: "合成前" }, block(png), { type: "text", text: "合成后" }] }),
  entry("a1", "u1", { role: "assistant", api: "openai-completions", stopReason: "toolUse", content: [{ type: "thinking", thinking: "合成思考" },
    { type: "toolCall", id: "synthetic-picture-tool", name: "synthetic_picture", arguments: {} }] }),
  entry("t1", "a1", { role: "toolResult", toolCallId: "synthetic-picture-tool", content: [block(jpeg, "image/jpeg")] }),
  entry("a2", "t1", { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "合成后续思考" }, { type: "text", text: "合成图片结束" }] })
]; }
async function imageFixture() {
  const [png, jpeg] = await pictures(), f = fixture(), source = records(png!, jpeg!);
  put(f.input, "sessions/" + f.sessionId + ".jsonl", sessionBytes(f.sessionId, source));
  f.definition.conversations[0]!.history[0]!.leafId = "a2";
  return { ...f, png: png!, jpeg: jpeg!, source };
}
const assetId = (f: Awaited<ReturnType<typeof imageFixture>>, entryId: string, position: number) => imageIdentity(f.definition, f.sessionId, entryId, position).id;
const counts = (target: string) => inspect(target, db => Object.fromEntries(["image_assets", "message_images", "messages", "context_entries", "import_batches"].map(table => [table, (db.prepare("SELECT count(*) AS n FROM " + table).get() as { n: number }).n])));
test("IMG39：图片UUIDv8由来源/会话/条目/块位置决定，字节版本或批次不参与身份", async () => {
  const f = await imageFixture(), a = imageIdentity(f.definition, f.sessionId, "u1", 1);
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const later = { ...f.definition, batchId: randomUUID() };
  assert.deepEqual(imageIdentity(later, f.sessionId, "u1", 1), a);
  for (const different of [imageIdentity(f.definition, f.sessionId, "u1", 2), imageIdentity(f.definition, "other-session", "u1", 1),
    imageIdentity(f.definition, f.sessionId, "other-entry", 1), imageIdentity({ ...f.definition, sourceId: randomUUID() }, f.sessionId, "u1", 1)]) assert.notEqual(different.id, a.id);
});
test("IMG40：用户/工具原图进入离线候选，原块序/隐私投影和备份恢复逐字节一致", { timeout: 15000 }, async () => {
  const f = await imageFixture(); f.build();
  const a = analyze(loadBundle(f.batch)); assert.deepEqual(a.gaps, []);
  const mapped = a.sessions.get(f.sessionId)!, user = readMessage(mapped.entries[0]!.payload);
  assert.ok(Array.isArray(user.content)); assert.deepEqual(user.content.map(part => part.type), ["text", "image", "text"]);
  const result = apply(f.batch, f.target, "owner"); assert.equal(result.applied, true); assert.equal(result.activated, false);
  assert.equal(result.continuity, "user_acceptance_pending");
  const conversation = uid(f.definition.sourceId, key), clock = { now: () => Date.now() };
  const storage = new SqliteStorage({ dataRoot: f.target, clock, instanceId: randomUUID() });
  const backup = join(f.directory, "image-backup.sqlite"), restored = join(f.directory, "restored");
  try {
    assert.ok(storage.imageAccess().getPublic("owner", conversation, assetId(f, "u1", 1)).content.equals(f.png));
    assert.throws(() => storage.imageAccess().getPublic("owner", conversation, assetId(f, "t1", 0)), isCode("NOT_FOUND"));
    const projected = wireMessages(mapped.entries.map(e => readMessage(e.payload)), true, image => storage.imageAccess().getProtocol("owner", conversation, image.id, image.sha256));
    const imageParts = projected.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === "image_url");
    assert.equal(imageParts.length, 2);
    assert.ok(Buffer.from(imageParts[0]!.image_url.url.split(",")[1], "base64").equals(f.png));
    assert.ok(Buffer.from(imageParts[1]!.image_url.url.split(",")[1], "base64").equals(f.jpeg));
    const history = storage.apiAccess().history("owner", conversation, undefined, 50).rows;
    assert.equal(history.filter(row => row.role === "user")[0]!.content, "合成前合成后");
    assert.deepEqual(history.filter(row => row.role === "user")[0]!.attachments!.map(image => image.id), [assetId(f, "u1", 1)]);
    assert.doesNotMatch(JSON.stringify(history), /sha256|reasoning_content|data:image/);
    await storage.backup(backup);
  } finally { await storage.close(); }
  assert.deepEqual(counts(f.target), { image_assets: 2, message_images: 1, messages: 2, context_entries: 4, import_batches: 1 });
  inspect(f.target, db => {
    assert.equal((db.prepare("SELECT active_version_id AS v FROM characters").get() as { v: null }).v, null);
    const payloads = db.prepare("SELECT payload_json AS p FROM context_entries").all() as { p: string }[];
    assert.ok(payloads.every(row => !/data:image|;base64,/.test(row.p) && !row.p.includes(f.png.toString("base64"))));
    assert.ok((db.prepare("SELECT content FROM import_objects WHERE path=?").get("sessions/" + f.sessionId + ".jsonl") as { content: Buffer }).content.equals(Buffer.from(sessionBytes(f.sessionId, f.source))));
  });
  await restoreDatabase(backup, restored, Date.now());
  const copy = new SqliteStorage({ dataRoot: restored, clock, instanceId: randomUUID() });
  try {
    assert.ok(copy.imageAccess().getPublic("owner", conversation, assetId(f, "u1", 1)).content.equals(f.png));
    const tool = mapped.images.find(image => image.origin === "import-tool")!;
    assert.ok(copy.imageAccess().getProtocol("owner", conversation, tool.reference.id, tool.reference.sha256).content.equals(f.jpeg));
  } finally { await copy.close(); }
  assert.equal(verify(restored).records, 4);
});
test("IMG41：JSONL追加新图不改变旧图片ID，重复批次不复制BLOB/关联/原档", { timeout: 15000 }, async () => {
  const f = await imageFixture(); f.build(); const first = apply(f.batch, f.target, "owner"), before = counts(f.target);
  assert.equal(apply(f.batch, f.target, "owner").replay, true); assert.deepEqual(counts(f.target), before);
  const added = [...f.source, entry("u2", "a2", { role: "user", content: [block(f.jpeg, "image/jpeg")] }),
    entry("a3", "u2", { role: "assistant", content: [{ type: "thinking", thinking: "合成新增思考" }, { type: "text", text: "合成新增回复" }], stopReason: "stop" })];
  const second = next(f, first.manifestSha256, added); second.definition.conversations[0]!.history[0]!.leafId = "a3"; second.build();
  apply(second.batch, f.target, "owner");
  assert.deepEqual(counts(f.target), { image_assets: 3, message_images: 2, messages: 4, context_entries: 6, import_batches: 2 });
  inspect(f.target, db => {
    assert.ok((db.prepare("SELECT content FROM image_assets WHERE id=?").get(assetId(f, "u1", 1)) as { content: Buffer }).content.equals(f.png));
    const user = db.prepare("SELECT content FROM messages WHERE id=?").get(uid(uid(f.definition.sourceId, "main", f.sessionId, "u2"), "public")) as { content: string };
    assert.equal(user.content, "");
  });
  assert.equal(apply(second.batch, f.target, "owner").replay, true);
  assert.equal(counts(f.target).image_assets, 3); assert.equal(verify(f.target).records, 6);
});
test("IMG42：全树图片保留，重选分支只改变用户附件可见性，隐藏工具图不公开", { timeout: 15000 }, async () => {
  const f = await imageFixture(), side = entry("side", "a2", { role: "user", content: [block(f.png)] }), all = [...f.source, side];
  put(f.input, "sessions/" + f.sessionId + ".jsonl", sessionBytes(f.sessionId, all)); f.build();
  const first = apply(f.batch, f.target, "owner"), conversation = uid(f.definition.sourceId, key);
  const visible = async () => {
    const storage = new SqliteStorage({ dataRoot: f.target, clock: { now: () => Date.now() }, instanceId: randomUUID() });
    try { try { return storage.imageAccess().getPublic("owner", conversation, assetId(f, "side", 0)).content.equals(f.png); } catch (error) { assert.equal((error as { code: string }).code, "NOT_FOUND"); return false; } } finally { await storage.close(); }
  };
  assert.equal(counts(f.target).image_assets, 3); assert.equal(await visible(), false);
  const second = next(f, first.manifestSha256, all); second.definition.conversations[0]!.history[0]!.leafId = "side"; second.build();
  const applied = apply(second.batch, f.target, "owner"); assert.equal(await visible(), true);
  const third = next(f, applied.manifestSha256, all); third.definition.revision = 3; third.definition.conversations[0]!.history[0]!.leafId = "a2";
  // next的目录固定为batch2；第三批使用新的显式目录，不能覆盖旧批次。
  const { capture } = await import("../../../tools/import-openclaw/dist/capture.js");
  const batch3 = join(f.directory, "batch3"); capture(f.input, batch3, third.definition);
  apply(batch3, f.target, "owner"); assert.equal(await visible(), false); assert.equal(counts(f.target).image_assets, 3);
  assert.equal(verify(f.target).revision, 3);
});
test("IMG43：同身份原件改写与候选图片损坏都会阻止增量，不覆盖旧图", { timeout: 15000 }, async () => {
  const f = await imageFixture(); f.build(); const first = apply(f.batch, f.target, "owner");
  const changed = records(f.jpeg, f.jpeg);
  (changed[0]!.message as { content: unknown[] }).content[1] = block(f.jpeg, "image/jpeg");
  const second = next(f, first.manifestSha256, changed); second.definition.conversations[0]!.history[0]!.leafId = "a2"; second.build();
  assert.throws(() => apply(second.batch, f.target, "owner"), isCode("SOURCE_REWRITTEN"));
  inspect(f.target, db => {
    assert.ok((db.prepare("SELECT content FROM image_assets WHERE id=?").get(assetId(f, "u1", 1)) as { content: Buffer }).content.equals(f.png));
    db.prepare("DELETE FROM message_images").run();
  });
  assert.throws(() => verify(f.target), isCode("TARGET_DIVERGED"));
  assert.throws(() => apply(f.batch, f.target, "owner"), isCode("TARGET_DIVERGED"));
});
test("IMG44：坏原件/非规范base64/未知图片字段在打开目标前失败，不以文字代替", { timeout: 15000 }, async () => {
  const [png] = await pictures();
  for (const image of [block(png!.subarray(0, -2)), { ...block(png!), data: png!.toString("base64") + "\n" }, { ...block(png!), source: "SYNTHETIC_PRIVATE_SENTINEL" },
    { type: "image", mimeType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") }]) {
    const f = fixture();
    put(f.input, "sessions/" + f.sessionId + ".jsonl", sessionBytes(f.sessionId, [entry("u1", null, { role: "user", content: [image] })]));
    f.definition.conversations[0]!.history[0]!.leafId = "u1"; f.build();
    const diagnostic = analyze(loadBundle(f.batch)); assert.ok(diagnostic.gaps.length);
    assert.doesNotMatch(JSON.stringify(diagnostic.gaps), /SYNTHETIC_PRIVATE_SENTINEL|<svg|base64,/);
    const unopened = join(f.directory, "unopened");
    assert.throws(() => apply(f.batch, unopened, "owner"), isCode("COMPATIBILITY_GAPS")); assert.equal(existsSync(unopened), false);
    assert.equal(counts(f.target).image_assets, 0);
  }
});
test("IMG45：附件绑定故障使原件、协议、角色和导入账本整批回滚", { timeout: 15000 }, async () => {
  const f = await imageFixture(); f.build();
  inspect(f.target, db => db.exec("CREATE TRIGGER synthetic_image_fail BEFORE INSERT ON message_images BEGIN SELECT RAISE(ABORT,'synthetic-image-failure'); END;"));
  assert.throws(() => apply(f.batch, f.target, "owner"));
  assert.deepEqual(counts(f.target), { image_assets: 0, message_images: 0, messages: 0, context_entries: 0, import_batches: 0 });
  inspect(f.target, db => { assert.equal((db.prepare("SELECT count(*) AS n FROM characters").get() as { n: number }).n, 0); db.exec("DROP TRIGGER synthetic_image_fail"); });
  assert.equal(apply(f.batch, f.target, "owner").applied, true);
});
