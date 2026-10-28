import type Database from "better-sqlite3";
import { imageLimits } from "../images/types.js";
import { publicImage } from "./image-assets.js";
import type { ConversationRow, MessageRow, RunRow } from "../application/ports.js";
import { ensure } from "../application/errors.js";

const conversationColumns = "id,title,created_at AS createdAt,updated_at AS updatedAt,change_revision AS revision";
const messageColumns = "m.id,m.conversation_id AS conversationId,m.seq,m.role,m.content,m.status,m.created_at AS createdAt,m.updated_revision AS revision,(SELECT r.id FROM runs r WHERE r.conversation_id=m.conversation_id AND (r.user_message_id=m.id OR r.reply_message_id=m.id) LIMIT 1) AS runId";
const runColumns = "r.id,r.conversation_id AS conversationId,r.origin,r.status,r.request_key AS requestKey,r.user_message_id AS userMessageId,r.reply_message_id AS replyMessageId,r.created_at AS createdAt,r.last_event_seq AS lastSequence,r.error_code AS errorCode";
export function conversation(db: Database.Database, ownerId: string, id: string): ConversationRow | undefined {
  return db.prepare("SELECT " + conversationColumns + " FROM conversations WHERE owner_id=? AND id=? AND deleted_at IS NULL").get(ownerId, id) as ConversationRow | undefined;
}
export function conversations(db: Database.Database, ownerId: string, before: readonly [number, string] | undefined, limit: number): ConversationRow[] {
  if (before) return db.prepare("SELECT " + conversationColumns + " FROM conversations WHERE owner_id=? AND deleted_at IS NULL AND (created_at<? OR(created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(ownerId, before[0], before[0], before[1], limit) as ConversationRow[];
  return db.prepare("SELECT " + conversationColumns + " FROM conversations WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT ?").all(ownerId, limit) as ConversationRow[];
}
export function createConversation(db: Database.Database, ownerId: string, id: string, title: string, now: number): ConversationRow {
  const choices = db.prepare("SELECT c.id FROM characters c JOIN character_versions v ON v.id=c.active_version_id AND v.character_id=c.id JOIN provider_profiles p ON p.id=v.provider_profile_id AND p.owner_id=c.owner_id WHERE c.owner_id=? LIMIT 2").all(ownerId) as { id: string }[];
  ensure(choices.length === 1, "SERVICE_NOT_READY");
  db.prepare("INSERT INTO conversations(id,owner_id,character_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, ownerId, choices[0]!.id, title, now, now);
  return conversation(db, ownerId, id)!;
}
export function renameConversation(db: Database.Database, ownerId: string, id: string, title: string, now: number): ConversationRow {
  ensure(conversation(db, ownerId, id), "NOT_FOUND");
  // 名称变更不占用消息revision，避免干扰历史/changes的增量对账。
  db.prepare("UPDATE conversations SET title=?,updated_at=? WHERE owner_id=? AND id=? AND deleted_at IS NULL").run(title, now, ownerId, id);
  return conversation(db, ownerId, id)!;
}
export function deleteConversation(db: Database.Database, ownerId: string, id: string, now: number): void {
  const row = db.prepare("SELECT deleted_at FROM conversations WHERE owner_id=? AND id=?").get(ownerId, id) as { deleted_at: number | null } | undefined;
  ensure(row, "NOT_FOUND");
  if (row.deleted_at !== null) return;
  ensure(!db.prepare("SELECT 1 FROM runs WHERE conversation_id=? AND status IN ('accepted','running')").get(id), "CONVERSATION_BUSY");
  // 与新消息受理/调度共用持租写事务，删除和新增运行不能交错越过检查。
  db.prepare("UPDATE scheduled_tasks SET enabled=0,revision=revision+1 WHERE conversation_id=? AND enabled=1").run(id);
  db.prepare("UPDATE conversations SET deleted_at=?,updated_at=? WHERE owner_id=? AND id=?").run(now, now, ownerId, id);
}
export function history(db: Database.Database, ownerId: string, id: string, before: number | undefined, limit: number) {
  const parent = conversation(db, ownerId, id); ensure(parent, "NOT_FOUND");
  const sql = "SELECT " + messageColumns + " FROM messages m WHERE m.conversation_id=? AND m.visibility='visible'" + (before === undefined ? "" : " AND m.seq<?") + " ORDER BY m.seq DESC LIMIT ?";
  const rows = db.prepare(sql).all(...(before === undefined ? [id, limit] : [id, before, limit])) as MessageRow[];
  attachImages(db, ownerId, id, rows);
  return { rows, revision: parent.revision };
}
export function changes(db: Database.Database, ownerId: string, id: string, after: number, limit: number) {
  const parent = conversation(db, ownerId, id); ensure(parent, "NOT_FOUND");
  ensure(after <= parent.revision, "CURSOR_INVALID");
  const rows = db.prepare("SELECT " + messageColumns + " FROM messages m WHERE m.conversation_id=? AND m.visibility='visible' AND m.updated_revision>? ORDER BY m.updated_revision ASC,m.seq ASC LIMIT ?").all(id, after, limit) as MessageRow[];
  attachImages(db, ownerId, id, rows);
  return { rows, revision: parent.revision };
}
function withReply(db: Database.Database, record: RunRow | undefined): { run: RunRow; reply?: MessageRow } | undefined {
  if (!record) return undefined;
  const reply = db.prepare("SELECT " + messageColumns + " FROM messages m WHERE m.conversation_id=? AND m.id=? AND m.visibility='visible'").get(record.conversationId, record.replyMessageId) as MessageRow | undefined;
  return { run: record, ...(reply ? { reply } : {}) };
}
export function run(db: Database.Database, ownerId: string, id: string) {
  const record = db.prepare("SELECT " + runColumns + " FROM runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.owner_id=? AND c.deleted_at IS NULL AND r.id=?").get(ownerId, id) as RunRow | undefined;
  return withReply(db, record);
}
export function submission(db: Database.Database, ownerId: string, conversationId: string, clientMessageId: string) {
  const record = db.prepare("SELECT " + runColumns + " FROM runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.owner_id=? AND c.deleted_at IS NULL AND r.conversation_id=? AND r.request_key=? AND r.origin='user'").get(ownerId, conversationId, "user:" + clientMessageId) as RunRow | undefined;
  return withReply(db, record);
}

function attachImages(db: Database.Database, owner: string, conversation: string, rows: MessageRow[]): void {
  const users = rows.filter(row => row.role === "user"), byId = new Map(users.map(row => [row.id, row]));
  // 只读当前页的元数据，不为历史列表读取BLOB，也不向公开DTO传递来源或哈希。
  for (let start = 0; start < users.length; start += 100) {
    const ids = users.slice(start, start + 100).map(row => row.id);
    const images = db.prepare("SELECT mi.message_id,mi.position,a.id,a.mime_type,a.byte_length,a.width,a.height,a.origin FROM message_images mi JOIN image_assets a ON a.id=mi.image_id AND a.conversation_id=mi.conversation_id WHERE a.owner_id=? AND mi.conversation_id=? AND mi.message_id IN (" + ids.map(() => "?").join(",") + ") ORDER BY mi.message_id,mi.position")
      .all(owner, conversation, ...ids) as { message_id: string; position: number; id: string; mime_type: "image/png" | "image/jpeg"; byte_length: number; width: number; height: number; origin: string }[];
    for (const image of images) {
      const row = byId.get(image.message_id)!;
      const attachments = row.attachments ??= [];
      ensure(image.position === attachments.length && attachments.length < imageLimits.perMessage && (image.origin === "upload" || image.origin === "import-user"), "SERVICE_NOT_READY");
      attachments.push(publicImage(image));
      ensure(attachments.reduce((total, item) => total + item.bytes, 0) <= imageLimits.messageBytes, "SERVICE_NOT_READY");
    }
  }
}
