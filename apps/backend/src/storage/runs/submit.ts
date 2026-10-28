import { submissionImages, bindImages, messageImages } from "../image-bindings.js";
import type Database from "better-sqlite3";
import type { IdFactory } from "../../ports.js";
import type { Submission } from "../../conversations/types.js";
import { ApplicationError, ensure } from "../../application/errors.js";
import { accepted, bump, event, read, type Record } from "./records.js";
export function submit(db: Database.Database, owner: string, conversation: string, input: Submission, now: number, ids: IdFactory, limits: { perConversationQueue: number; globalQueue: number }, webSearch = false, imagesEnabled = false) {
  const parent = db.prepare("SELECT next_public_seq AS seq FROM conversations WHERE id=? AND owner_id=? AND deleted_at IS NULL").get(conversation, owner) as { seq: number } | undefined;
  ensure(parent, "NOT_FOUND");
  const existing = db.prepare("SELECT * FROM runs WHERE conversation_id=? AND request_key=?").get(conversation, "user:" + input.clientMessageId) as Record | undefined;
  if (existing) {
    ensure(existing.input_hash === input.inputHash && existing.input_json === input.inputJson, "IDEMPOTENCY_CONFLICT");
    ensure(JSON.stringify(messageImages(db, existing.user_message_id!, conversation).map(image => image.id)) === JSON.stringify(input.imageIds), "SERVICE_NOT_READY");
    return accepted(existing, input.clientMessageId);
  }
  // 先对账已有事实；联网能力必须由后端实例启用。
  ensure(!input.allowWebSearch || webSearch, "SERVICE_NOT_READY");
  ensure(!input.imageIds.length || imagesEnabled, "SERVICE_NOT_READY");
  const images = submissionImages(db, owner, conversation, input.imageIds);
  const per = (db.prepare("SELECT count(*) AS n FROM runs WHERE conversation_id=? AND origin='user' AND status IN ('accepted','running')").get(conversation) as { n: number }).n;
  const global = (db.prepare("SELECT count(*) AS n FROM runs WHERE status IN ('accepted','running')").get() as { n: number }).n;
  if (per >= limits.perConversationQueue || global >= limits.globalQueue) throw new ApplicationError("QUEUE_FULL", 1);
  ensure(Number.isSafeInteger(parent.seq + 2), "SERVICE_NOT_READY");
  const user = ids.next(), answer = ids.next(), id = ids.next(), revision = bump(db, conversation, 2, now);
  db.prepare("UPDATE conversations SET next_public_seq=? WHERE id=?").run(parent.seq + 2, conversation);
  const insert = db.prepare("INSERT INTO messages(id,conversation_id,seq,role,content,status,updated_revision,created_at) VALUES(?,?,?,?,?,?,?,?)");
  insert.run(user, conversation, parent.seq, "user", input.text, "complete", revision + 1, now);
  bindImages(db, user, conversation, images);
  insert.run(answer, conversation, parent.seq + 1, "assistant", "", "partial", revision + 2, now);
  db.prepare("INSERT INTO runs(id,conversation_id,origin,request_key,input_hash,user_message_id,reply_message_id,input_json,status,created_at) VALUES(?,?,'user',?,?,?,?,?,'accepted',?)").run(id, conversation, "user:" + input.clientMessageId, input.inputHash, user, answer, input.inputJson, now);
  const run = read(db, id)!; const receipt = accepted(run, input.clientMessageId);
  event(db, run, "run.accepted", { origin: "user", submission: receipt }, now);
  return receipt;
}
