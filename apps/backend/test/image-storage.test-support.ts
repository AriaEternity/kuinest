import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";
import { ImageValidator } from "../dist/images/validate.js";
import type { ImagePut } from "../dist/images/storage.js";
import { insertImage } from "../dist/storage/image-assets.js";
import { restoreDatabase } from "../dist/storage/backup.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { ApiServices } from "../dist/application/service.js";
import { loadMigrations } from "../dist/storage/migrations.js";
import { stateHash } from "../../../tools/import-openclaw/dist/ledger.js";
import { fixture, inspect, isCode } from "./run-fixtures.js";

let samplePromise: Promise<{ png: Buffer; jpeg: Buffer; a: ImagePut["inspection"]; b: ImagePut["inspection"] }> | undefined;
function samples() {
  return samplePromise ??= (async () => {
    const png = await sharp({ create: { width: 23, height: 17, channels: 3, background: "#246cab" } }).withMetadata().png().toBuffer();
    const jpeg = await sharp({ create: { width: 37, height: 13, channels: 3, background: "#ad6235" } }).withMetadata().jpeg({ progressive: true }).toBuffer();
    const validator = new ImageValidator();
    return { png, jpeg, a: await validator.inspect(png), b: await validator.inspect(jpeg) };
  })();
}
function put(content: Buffer, inspection: ImagePut["inspection"], now: number): ImagePut {
  return { id: randomUUID(), ownerId: "owner-a", conversationId: "conversation-a", content, inspection, createdAt: now };
}
test("IMG05：原件入库、相同ID重放、不同原件冲突与重开库保持逐字节一致", async t => {
  const f = fixture(t), s = await samples(), input = put(s.png, s.a, f.clock.now()), images = f.storage.imageAccess();
  const first = images.putUpload(input); assert.equal(first.replay, false);
  assert.deepEqual(Object.keys(first.image).sort(), ["bytes", "height", "id", "mimeType", "width"]);
  assert.deepEqual(images.putUpload(input), { image: first.image, replay: true });
  assert.throws(() => images.putUpload({ ...input, content: s.jpeg, inspection: s.b }), isCode("IDEMPOTENCY_CONFLICT"));
  const read = images.getPublic("owner-a", "conversation-a", input.id); assert.ok(read.content.equals(s.png));
  read.content.fill(0); assert.ok(images.getPublic("owner-a", "conversation-a", input.id).content.equals(s.png));
  await f.reopen();
  assert.ok(f.storage.imageAccess().getProtocol("owner-a", "conversation-a", input.id, s.a.sha256).content.equals(s.png));
  assert.deepEqual(f.storage.imageAccess().putUpload(input), { image: first.image, replay: true });
});
test("IMG06：跨owner/跨会话/未知ID拒绝，图片hash或上传原件不一致拒绝", async t => {
  const f = fixture(t), s = await samples(), input = put(s.png, s.a, f.clock.now()), images = f.storage.imageAccess();
  images.putUpload(input); f.conversation("conversation-other");
  for (const [owner, conversation] of [["owner-b", "conversation-a"], ["owner-a", "conversation-other"]]) {
    assert.throws(() => images.getPublic(owner!, conversation!, input.id), isCode("NOT_FOUND"));
    assert.throws(() => images.putUpload({ ...input, ownerId: owner!, conversationId: conversation! }), isCode("NOT_FOUND"));
  }
  assert.throws(() => images.getPublic("owner-a", "conversation-a", randomUUID()), isCode("NOT_FOUND"));
  assert.throws(() => images.getProtocol("owner-a", "conversation-a", input.id, "0".repeat(64)), isCode("IMAGE_UNAVAILABLE"));
  assert.throws(() => images.putUpload({ ...input, id: randomUUID(), content: s.jpeg }), isCode("IMAGE_INVALID"));
  assert.throws(() => images.putUpload({ ...input, id: randomUUID(), inspection: { ...s.a, width: 20000 } }), isCode("IMAGE_INVALID"));
});
test("IMG06：隐藏工具原图仅协议可读，只有可见用户消息能公开导入用户图", async t => {
  const f = fixture(t), s = await samples(), tool = put(s.png, s.a, f.clock.now()), user = put(s.jpeg, s.b, f.clock.now());
  inspect(f.root, db => db.transaction(() => {
    insertImage(db, tool, "import-tool", "synthetic-tool-source");
    insertImage(db, user, "import-user", "synthetic-user-source");
  }).immediate());
  const images = f.storage.imageAccess();
  assert.throws(() => images.getPublic("owner-a", "conversation-a", tool.id), isCode("NOT_FOUND"));
  assert.throws(() => images.getPublic("owner-a", "conversation-a", user.id), isCode("NOT_FOUND"));
  assert.ok(images.getProtocol("owner-a", "conversation-a", tool.id, s.a.sha256).content.equals(s.png));
  const receipt = f.submit();
  inspect(f.root, db => {
    const bind = db.prepare("INSERT INTO message_images(message_id,conversation_id,image_id,position) VALUES (?,?,?,?)");
    assert.throws(() => bind.run(receipt.messageId, "conversation-a", tool.id, 0), /IMAGE_BINDING_INVALID/);
    assert.throws(() => bind.run(receipt.replyId, "conversation-a", user.id, 0), /IMAGE_BINDING_INVALID/);
    bind.run(receipt.messageId, "conversation-a", user.id, 0);
    assert.throws(() => db.prepare("UPDATE message_images SET image_id=?").run(tool.id), /IMAGE_BINDING_IMMUTABLE/);
    assert.throws(() => db.prepare("UPDATE image_assets SET origin='upload',source_uid=NULL WHERE id=?").run(tool.id), /IMAGE_IMMUTABLE/);
  });
  assert.ok(images.getPublic("owner-a", "conversation-a", user.id).content.equals(s.jpeg));
  inspect(f.root, db => db.prepare("UPDATE messages SET visibility='suppressed' WHERE id=?").run(receipt.messageId));
  assert.throws(() => images.getPublic("owner-a", "conversation-a", user.id), isCode("NOT_FOUND"));
});
test("IMG07：写入失败整体回滚，失租后不能继续读写图片", async t => {
  const f = fixture(t), s = await samples(), input = put(s.png, s.a, f.clock.now()), images = f.storage.imageAccess();
  inspect(f.root, db => db.exec("CREATE TRIGGER synthetic_image_fault AFTER INSERT ON image_assets BEGIN SELECT RAISE(ABORT,'synthetic-image-fault'); END"));
  assert.throws(() => images.putUpload(input), /synthetic-image-fault/);
  inspect(f.root, db => {
    assert.equal((db.prepare("SELECT count(*) AS n FROM image_assets").get() as { n: number }).n, 0);
    db.exec("DROP TRIGGER synthetic_image_fault");
  });
  images.putUpload(input); f.clock.value += 30000;
  assert.throws(() => images.getPublic("owner-a", "conversation-a", input.id), isCode("LEASE_LOST"));
  assert.throws(() => images.putUpload(input), isCode("STORAGE_UNAVAILABLE"));
});
test("IMG07：解码后的提交重查登录撤销、绝对到期与闲置到期", async t => {
  const f = fixture(t), s = await samples(), input = { ...put(s.png, s.a, f.clock.now()), sessionTokenHash: "synthetic-session-hash" };
  const images = f.storage.imageAccess();
  inspect(f.root, db => db.prepare("INSERT INTO auth_sessions(token_hash,owner_id,csrf_token,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)")
    .run(input.sessionTokenHash, "owner-a", "synthetic-csrf", f.clock.now(), f.clock.now(), f.clock.now() + 10000));
  images.putUpload(input);
  for (const sql of ["revoked_at=1", "revoked_at=NULL,expires_at=" + f.clock.now(), "revoked_at=NULL,expires_at=" + (f.clock.now() + 10000) + ",last_seen_at=" + (f.clock.now() - 86400000)]) {
    inspect(f.root, db => db.exec("UPDATE auth_sessions SET " + sql));
    assert.throws(() => images.putUpload(input), isCode("AUTH_REQUIRED"));
  }
});
test("IMG08：owner存储上限只限制新增，重试不重复计费也不清理旧图", async t => {
  const f = fixture(t), s = await samples(), input = put(s.png, s.a, f.clock.now());
  const images = f.storage.imageAccess({ maxStoredBytes: s.png.length });
  images.putUpload(input); assert.equal(images.putUpload(input).replay, true);
  assert.throws(() => images.putUpload({ ...input, id: randomUUID() }), isCode("IMAGE_STORAGE_FULL"));
  assert.ok(images.getPublic("owner-a", "conversation-a", input.id).content.equals(s.png));
  inspect(f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM image_assets").get() as { n: number }).n, 1));
});
test("IMG09：在线备份及候选恢复包含原图与公开关联", async t => {
  const f = fixture(t), s = await samples(), input = put(s.png, s.a, f.clock.now());
  f.storage.imageAccess().putUpload(input); const receipt = f.submit();
  inspect(f.root, db => db.prepare("INSERT INTO message_images(message_id,conversation_id,image_id,position) VALUES(?,?,?,0)").run(receipt.messageId, "conversation-a", input.id));
  const backup = join(f.root, "image-backup.sqlite"), restored = join(f.root, "image-restored");
  await f.storage.backup(backup); await restoreDatabase(backup, restored, f.clock.now());
  const copy = new SqliteStorage({ dataRoot: restored, clock: f.clock, instanceId: randomUUID() }); f.cleanup(() => copy.close());
  assert.ok(copy.imageAccess().getPublic("owner-a", "conversation-a", input.id).content.equals(s.png));
  inspect(restored, db => assert.deepEqual(db.prepare("SELECT message_id,image_id,position FROM message_images").get(), { message_id: receipt.messageId, image_id: input.id, position: 0 }));
});
test("IMG09：图片原件与绑定进入候选指纹，相同ID重试保持指纹", async t => {
  const f = fixture(t), s = await samples(), input = put(s.png, s.a, f.clock.now());
  const fingerprint = () => inspect(f.root, stateHash), before = fingerprint();
  f.storage.imageAccess().putUpload(input); const added = fingerprint(); assert.notEqual(added, before);
  f.storage.imageAccess().putUpload(input); assert.equal(fingerprint(), added);
  const receipt = f.submit(), preBind = fingerprint();
  inspect(f.root, db => db.prepare("INSERT INTO message_images(message_id,conversation_id,image_id,position) VALUES(?,?,?,0)").run(receipt.messageId, "conversation-a", input.id));
  assert.notEqual(fingerprint(), preBind);
});
test("IMG09：库中原件损坏明确失败，不能把改写图片发送模型或公开读取", async t => {
  const f = fixture(t), s = await samples(), input = put(s.png, s.a, f.clock.now());
  f.storage.imageAccess().putUpload(input);
  inspect(f.root, db => { db.exec("DROP TRIGGER image_assets_immutable"); db.prepare("UPDATE image_assets SET content=zeroblob(byte_length) WHERE id=?").run(input.id); });
  assert.throws(() => f.storage.imageAccess().getPublic("owner-a", "conversation-a", input.id), isCode("IMAGE_UNAVAILABLE"));
  assert.throws(() => f.storage.imageAccess().getProtocol("owner-a", "conversation-a", input.id, s.a.sha256), isCode("IMAGE_UNAVAILABLE"));
});

test("IMG10：用户附件随分页与changes保持原顺序，公开JSON不含原件、来源或哈希", async t => {
  const f = fixture(t), s = await samples(), a = put(s.png, s.a, f.clock.now()), b = put(s.jpeg, s.b, f.clock.now());
  const images = f.storage.imageAccess(), am = images.putUpload(a).image, bm = images.putUpload(b).image, receipt = f.submit();
  inspect(f.root, db => {
    const bind = db.prepare("INSERT INTO message_images(message_id,conversation_id,image_id,position) VALUES (?,?,?,?)");
    bind.run(receipt.messageId, "conversation-a", b.id, 0); bind.run(receipt.messageId, "conversation-a", a.id, 1);
  });
  const queries = () => new ApiServices(f.storage.apiAccess(), f.config, f.clock, f.ids, Buffer.alloc(32, 41)).queries;
  const first = queries().history("owner-a", "conversation-a", undefined, 1);
  assert.equal(first.items[0]!.role, "assistant"); assert.equal(first.items[0]!.attachments, undefined);
  const second = queries().history("owner-a", "conversation-a", first.nextCursor!, 1);
  assert.deepEqual(second.items[0]!.attachments, [bm, am]);
  const changed = queries().changes("owner-a", "conversation-a", 0);
  assert.deepEqual(changed.items.find(row => row.id === receipt.messageId)!.attachments, [bm, am]);
  assert.doesNotMatch(JSON.stringify(changed), /sha256|decoder|source_uid|image\/png;base64|import-user/);
  assert.throws(() => queries().history("owner-b", "conversation-a", undefined, 1), isCode("NOT_FOUND"));
  await f.reopen(); assert.deepEqual(queries().history("owner-a", "conversation-a", undefined, 50).items[0]!.attachments, [bm, am]);
});
test("IMG11：旧001/002库升级003保留旧文字消息，图片表从空状态建立", async t => {
  const f = fixture(t), legacy = join(f.root, "pre-images"), migrations = loadMigrations();
  const old = new SqliteStorage({ dataRoot: legacy, clock: f.clock, instanceId: randomUUID(), migrations: migrations.slice(0, 2) });
  try {
    old.apiAccess().initializeOwner({ id: "owner-a", username: "synthetic-old", passwordHash: "synthetic-only", createdAt: f.clock.now(), characterId: "character-a", profileId: "profile-a", versionId: "version-a" });
    old.write("owner-a", repo => {
      repo.createConversation("conversation-a", "character-a", "合成旧会话", f.clock.now());
      repo.insertMessage({ id: "synthetic-legacy-message", conversationId: "conversation-a", seq: 1, role: "user", content: "合成旧文本逐字保留", status: "complete", revision: 1, createdAt: f.clock.now() });
    });
  } finally { await old.close(); }
  const upgraded = new SqliteStorage({ dataRoot: legacy, clock: f.clock, instanceId: randomUUID() }); f.cleanup(() => upgraded.close());
  assert.equal(upgraded.apiAccess().history("owner-a", "conversation-a", undefined, 50).rows[0]!.content, "合成旧文本逐字保留");
  inspect(legacy, db => {
    assert.equal((db.prepare("SELECT count(*) AS n FROM image_assets").get() as { n: number }).n, 0);
    assert.deepEqual((db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map(row => row.version), loadMigrations().map(m=>m.version));
  });
});
