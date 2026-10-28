import type Database from "better-sqlite3";
import { ensure } from "../application/errors.js";
import { readImageReference, type ImageReference } from "../images/content.js";
import { imageLimits } from "../images/types.js";
import { requireCondition } from "./errors.js";
type Row = { id: string; mimeType: string; bytes: number; width: number; height: number; sha256: string };
const columns = "a.id,a.mime_type AS mimeType,a.byte_length AS bytes,a.width,a.height,a.sha256";
function references(rows: Row[]): ImageReference[] {
  ensure(rows.length <= imageLimits.perMessage && rows.reduce((sum, row) => sum + row.bytes, 0) <= imageLimits.messageBytes, "INPUT_INVALID");
  return rows.map(row => readImageReference({ type: "image", ...row }));
}
export function submissionImages(db: Database.Database, owner: string, conversation: string, ids: readonly string[]): ImageReference[] {
  const query = db.prepare("SELECT " + columns + " FROM image_assets a WHERE a.id=? AND a.owner_id=? AND a.conversation_id=? AND (a.origin='upload' OR (a.origin='import-user' AND EXISTS(SELECT 1 FROM message_images mi JOIN messages m ON m.id=mi.message_id AND m.conversation_id=mi.conversation_id WHERE mi.image_id=a.id AND m.role='user' AND m.visibility='visible')))");
  const rows = ids.map(id => { const row = query.get(id, owner, conversation) as Row | undefined; ensure(row, "NOT_FOUND"); return row; });
  ensure(new Set(ids).size === ids.length, "INPUT_INVALID");
  return references(rows);
}
export function bindImages(db: Database.Database, message: string, conversation: string, images: readonly ImageReference[]): void {
  requireCondition(db.inTransaction, "TRANSACTION_REQUIRED");
  const insert = db.prepare("INSERT INTO message_images(message_id,conversation_id,image_id,position) VALUES (?,?,?,?)");
  images.forEach((image, position) => insert.run(message, conversation, image.id, position));
}
export function messageImages(db: Database.Database, message: string, conversation: string): ImageReference[] {
  const rows = db.prepare("SELECT " + columns + ",mi.position,a.origin,a.owner_id AS ownerId,c.owner_id AS conversationOwner FROM message_images mi JOIN messages m ON m.id=mi.message_id AND m.conversation_id=mi.conversation_id JOIN conversations c ON c.id=m.conversation_id LEFT JOIN image_assets a ON a.id=mi.image_id AND a.conversation_id=mi.conversation_id WHERE mi.message_id=? AND mi.conversation_id=? AND m.role='user' AND m.visibility='visible' ORDER BY mi.position")
    .all(message, conversation) as (Row & { position: number; origin: string; ownerId: string; conversationOwner: string })[];
  rows.forEach((row, index) => ensure(row.position === index && row.ownerId === row.conversationOwner && (row.origin === "upload" || row.origin === "import-user"), "SERVICE_NOT_READY"));
  return references(rows.map(row => ({ id: row.id, mimeType: row.mimeType, bytes: row.bytes, width: row.width, height: row.height, sha256: row.sha256 })));
}
