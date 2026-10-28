import type Database from "better-sqlite3";
import { requireCondition } from "../errors.js";

export interface ConversationRecord { id: string; ownerId: string; characterId: string; title: string; }
export function findConversation(db: Database.Database, ownerId: string, conversationId: string): ConversationRecord | undefined {
  return db.prepare("SELECT id,owner_id AS ownerId,character_id AS characterId,title FROM conversations WHERE id=? AND owner_id=?").get(conversationId, ownerId) as ConversationRecord | undefined;
}
export function scopedRepositories(db: Database.Database, ownerId: string, guard: () => void) {
  const conversation = (id: string) => { guard(); requireCondition(findConversation(db, ownerId, id), "NOT_FOUND"); };
  return Object.freeze({
    createCharacter(id: string, name: string, now: number): void {
      guard(); db.prepare("INSERT INTO characters(id,owner_id,name,created_at) VALUES (?,?,?,?)").run(id, ownerId, name, now);
    },
    createConversation(id: string, characterId: string, title: string, now: number): void {
      guard();
      requireCondition(db.prepare("SELECT 1 FROM characters WHERE id=? AND owner_id=?").get(characterId, ownerId), "NOT_FOUND");
      db.prepare("INSERT INTO conversations(id,owner_id,character_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, ownerId, characterId, title, now, now);
    },
    renameConversation(id: string, title: string, now: number): void {
      conversation(id); db.prepare("UPDATE conversations SET title=?,updated_at=? WHERE id=? AND owner_id=?").run(title, now, id, ownerId);
    },
    // 只保存上层已分配的记录；接收去重、seq 分配和任务调度在第 04 阶段实现。
    insertMessage(record: { id: string; conversationId: string; seq: number; role: "user" | "assistant"; content: string; status: "complete" | "partial"; revision: number; createdAt: number }): void {
      conversation(record.conversationId);
      db.prepare("INSERT INTO messages(id,conversation_id,seq,role,content,status,updated_revision,created_at) VALUES (?,?,?,?,?,?,?,?)").run(record.id, record.conversationId, record.seq, record.role, record.content, record.status, record.revision, record.createdAt);
    },
    insertAcceptedRun(record: { id: string; conversationId: string; requestKey: string; inputHash: string; userMessageId: string; replyId: string; createdAt: number }): void {
      conversation(record.conversationId);
      requireCondition(db.prepare("SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND role='user'").get(record.userMessageId, record.conversationId), "RUN_LINK_INVALID");
      requireCondition(db.prepare("SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND role='assistant'").get(record.replyId, record.conversationId), "RUN_LINK_INVALID");
      db.prepare("INSERT INTO runs(id,conversation_id,origin,request_key,input_hash,user_message_id,reply_message_id,input_json,status,created_at,last_event_seq) VALUES (?,?,'user',?,?,?,?,'{}','accepted',?,1)").run(record.id, record.conversationId, record.requestKey, record.inputHash, record.userMessageId, record.replyId, record.createdAt);
    },
    insertAcceptedEvent(runId: string, payload: Readonly<Record<string, unknown>>, now: number): void {
      guard();
      requireCondition(db.prepare("SELECT 1 FROM runs r JOIN conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.owner_id=? AND r.status='accepted'").get(runId, ownerId), "NOT_FOUND");
      db.prepare("INSERT INTO run_events(run_id,seq,type,payload_json,created_at) VALUES (?,1,'run.accepted',?,?)").run(runId, JSON.stringify(payload), now);
    },
  });
}
export type ScopedRepositories = ReturnType<typeof scopedRepositories>;
