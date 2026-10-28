import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ImageAttachment } from "@kuinest/contracts";
import { ensure } from "../application/errors.js";
import { ImageFailure, imageHashPattern, imageLimits, type ImageInspection } from "../images/types.js";
import type { ImageOrigin, ImagePut, ImageStorage, StoredImage } from "../images/storage.js";
import { requireCondition } from "./errors.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const defaultImageStorageBytes = 1024 * 1024 * 1024;
type Row = { id: string; owner_id: string; conversation_id: string; origin: ImageOrigin; mime_type: ImageInspection["mimeType"]; byte_length: number; width: number; height: number; sha256: string; decoder: ImageInspection["decoder"]; source_uid: string | null; content: Buffer };
const fields = "id,owner_id,conversation_id,origin,mime_type,byte_length,width,height,sha256,decoder,source_uid,content";
function scoped(db: Database.Database, owner: string, conversation: string): void {
  ensure(db.prepare("SELECT 1 FROM conversations WHERE id=? AND owner_id=? AND deleted_at IS NULL").get(conversation, owner), "NOT_FOUND");
}
function validInspection(i: ImageInspection, bytes: Uint8Array): boolean {
  return (i.mimeType === "image/png" || i.mimeType === "image/jpeg") && i.decoder === "sharp-0.35.4"
    && Number.isSafeInteger(i.width) && i.width > 0 && i.width <= imageLimits.edge
    && Number.isSafeInteger(i.height) && i.height > 0 && i.height <= imageLimits.edge && i.width * i.height <= imageLimits.pixels
    && i.bytes === bytes.byteLength && i.bytes > 0 && i.bytes <= imageLimits.bytes
    && imageHashPattern.test(i.sha256) && createHash("sha256").update(bytes).digest("hex") === i.sha256;
}
export function publicImage(row: Pick<Row, "id" | "mime_type" | "byte_length" | "width" | "height">): ImageAttachment {
  return { id: row.id, mimeType: row.mime_type, bytes: row.byte_length, width: row.width, height: row.height };
}
function inspection(row: Row): ImageInspection {
  return { mimeType: row.mime_type, bytes: row.byte_length, width: row.width, height: row.height, sha256: row.sha256, decoder: row.decoder };
}
function original(row: Row): StoredImage {
  const i = inspection(row);
  if (!Buffer.isBuffer(row.content) || !validInspection(i, row.content)) throw new ImageFailure("IMAGE_UNAVAILABLE");
  return { ...i, id: row.id, ownerId: row.owner_id, conversationId: row.conversation_id, origin: row.origin, content: Buffer.from(row.content) };
}
// 只供可信仓储/离线导入使用。调用前必须完整解码；事务内再次核对原件哈希和元数据边界。
export function insertImage(db: Database.Database, input: ImagePut, origin: ImageOrigin = "upload", sourceUid?: string, maxStoredBytes = defaultImageStorageBytes): { image: ImageAttachment; replay: boolean } {
  requireCondition(db.inTransaction, "TRANSACTION_REQUIRED");
  scoped(db, input.ownerId, input.conversationId);
  ensure(uuid.test(input.id) && Number.isSafeInteger(input.createdAt) && input.createdAt >= 0, "INPUT_INVALID");
  ensure(Number.isSafeInteger(maxStoredBytes) && maxStoredBytes > 0, "INPUT_INVALID");
  ensure(origin === "upload" ? sourceUid === undefined : (origin === "import-user" || origin === "import-tool") && typeof sourceUid === "string" && sourceUid.length > 0, "INPUT_INVALID");
  const bytes = Buffer.from(input.content), i = input.inspection;
  if (!validInspection(i, bytes)) throw new ImageFailure("IMAGE_INVALID");
  if (input.sessionTokenHash !== undefined) {
    ensure(db.prepare("SELECT 1 FROM auth_sessions WHERE token_hash=? AND owner_id=? AND revoked_at IS NULL AND expires_at>? AND last_seen_at>?")
      .get(input.sessionTokenHash, input.ownerId, input.createdAt, input.createdAt - 86400000), "AUTH_REQUIRED");
  }
  const old = db.prepare("SELECT " + fields + " FROM image_assets WHERE id=?").get(input.id) as Row | undefined;
  if (old) {
    ensure(old.owner_id === input.ownerId && old.conversation_id === input.conversationId, "NOT_FOUND");
    ensure(old.origin === origin && old.source_uid === (sourceUid ?? null) && old.mime_type === i.mimeType
      && old.sha256 === i.sha256 && old.width === i.width && old.height === i.height
      && old.byte_length === bytes.length && old.decoder === i.decoder && old.content.equals(bytes), "IDEMPOTENCY_CONFLICT");
    return { image: publicImage(old), replay: true };
  }
  const used = db.prepare("SELECT coalesce(sum(byte_length),0) AS bytes FROM image_assets WHERE owner_id=?").get(input.ownerId) as { bytes: number };
  if (used.bytes + bytes.length > maxStoredBytes) throw new ImageFailure("IMAGE_STORAGE_FULL");
  db.prepare("INSERT INTO image_assets(id,owner_id,conversation_id,origin,mime_type,byte_length,width,height,sha256,decoder,content,source_uid,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(input.id, input.ownerId, input.conversationId, origin, i.mimeType, bytes.length, i.width, i.height, i.sha256, i.decoder, bytes, sourceUid ?? null, input.createdAt);
  return { image: { id: input.id, mimeType: i.mimeType, bytes: bytes.length, width: i.width, height: i.height }, replay: false };
}
export function imageAccess(db: Database.Database, transaction: <T>(fn: () => T) => T, guard: () => void, maxStoredBytes = defaultImageStorageBytes): ImageStorage {
  ensure(Number.isSafeInteger(maxStoredBytes) && maxStoredBytes > 0, "INPUT_INVALID");
  return {
    requireConversation(owner, conversation) { guard(); scoped(db, owner, conversation); },
    putUpload(input) { return transaction(() => insertImage(db, input, "upload", undefined, maxStoredBytes)); },
    getPublic(owner, conversation, id) {
      guard(); scoped(db, owner, conversation);
      const row = db.prepare("SELECT " + fields + " FROM image_assets WHERE id=? AND owner_id=? AND conversation_id=? AND (origin='upload' OR (origin='import-user' AND EXISTS (SELECT 1 FROM message_images mi JOIN messages m ON m.id=mi.message_id AND m.conversation_id=mi.conversation_id WHERE mi.image_id=image_assets.id AND m.role='user' AND m.visibility='visible')))").get(id, owner, conversation) as Row | undefined;
      ensure(row, "NOT_FOUND"); return original(row);
    },
    getProtocol(owner, conversation, id, expectedHash) {
      guard(); scoped(db, owner, conversation);
      const row = db.prepare("SELECT " + fields + " FROM image_assets WHERE id=? AND owner_id=? AND conversation_id=?").get(id, owner, conversation) as Row | undefined;
      if (!row || !imageHashPattern.test(expectedHash) || row.sha256 !== expectedHash) throw new ImageFailure("IMAGE_UNAVAILABLE");
      return original(row);
    }
  };
}
