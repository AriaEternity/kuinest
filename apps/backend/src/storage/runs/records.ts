import type Database from "better-sqlite3";
import type { AcceptedSubmission, ConversationMessage, RunStatus } from "@kuinest/contracts";
import { ensure } from "../../application/errors.js";
export interface Record {
  id: string; conversation_id: string; origin: "user" | "heartbeat"; request_key: string;
  input_json: string; input_hash: string; user_message_id: string | null; reply_message_id: string;
  status: RunStatus; created_at: number; cancel_requested_at: number | null;
  claim_owner: string | null; fence: number | null; last_event_seq: number;
  context_head_at_start: string | null; context_user_entry_id: string | null;
}
export const read = (db: Database.Database, id: string) => db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Record | undefined;
export function owned(db: Database.Database, owner: string, id: string): Record {
  const run = db.prepare("SELECT r.* FROM runs r JOIN conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.owner_id=? AND c.deleted_at IS NULL").get(id, owner) as Record | undefined;
  ensure(run, "NOT_FOUND"); return run;
}
export function accepted(run: Record, client: string): AcceptedSubmission {
  ensure(run.origin === "user" && run.user_message_id, "SERVICE_NOT_READY");
  return { conversationId: run.conversation_id, clientMessageId: client, messageId: run.user_message_id, replyId: run.reply_message_id, runId: run.id, acceptedAt: new Date(run.created_at).toISOString() };
}
export function bump(db: Database.Database, conversation: string, count: number, now: number): number {
  const row = db.prepare("SELECT change_revision AS revision FROM conversations WHERE id=?").get(conversation) as { revision: number } | undefined;
  ensure(row && Number.isSafeInteger(row.revision + count), "SERVICE_NOT_READY");
  db.prepare("UPDATE conversations SET change_revision=?,updated_at=? WHERE id=?").run(row.revision + count, now, conversation);
  return row.revision;
}
export function event(db: Database.Database, run: Record, type: string, fields: object, now: number): void {
  const sequence = run.last_event_seq + 1; ensure(Number.isSafeInteger(sequence), "SERVICE_NOT_READY");
  const payload = { runId: run.id, sequence, occurredAt: new Date(now).toISOString(), type, ...fields };
  db.prepare("INSERT INTO run_events(run_id,seq,type,payload_json,created_at) VALUES(?,?,?,?,?)").run(run.id, sequence, type, JSON.stringify(payload), now);
  db.prepare("UPDATE runs SET last_event_seq=? WHERE id=?").run(sequence, run.id); run.last_event_seq = sequence;
}
export function reply(db: Database.Database, run: Record): ConversationMessage {
  const row = db.prepare("SELECT id,role,content,status,created_at AS createdAt,updated_revision AS revision,visibility FROM messages WHERE conversation_id=? AND id=?").get(run.conversation_id, run.reply_message_id) as { id: string; role: string; content: string; status: "complete" | "partial"; createdAt: number; revision: number; visibility: string } | undefined;
  ensure(row && row.role === "assistant" && row.visibility === "visible", "SERVICE_NOT_READY");
  return { id: row.id, conversationId: run.conversation_id, runId: run.id, role: "assistant", content: row.content, status: row.status, createdAt: new Date(row.createdAt).toISOString(), revision: row.revision };
}
