import { silent } from "../../scheduler/silence.js";
import { heartbeatInput } from "../../scheduler/types.js";
import { settleHeartbeat } from "./heartbeat.js";
import { interruptedArchives } from "../protocol.js";
import type Database from "better-sqlite3";
import type { IdFactory } from "../../ports.js";
import type { Claim, FailureCode } from "../../conversations/types.js";
import { ensure } from "../../application/errors.js";
import { bump, event, read, reply, type Record } from "./records.js";
import { settleContext } from "./context.js";
export function matches(run: Record | undefined, claim: Claim): run is Record {
  return !!run && run.id === claim.id && run.conversation_id === claim.conversationId && run.status === "running" && run.fence === claim.fence && run.claim_owner === claim.claimOwner && run.context_user_entry_id === claim.contextUserEntryId && (claim.origin ?? "user") === run.origin;
}
export function append(db: Database.Database, claim: Claim, text: string, now: number): boolean {
  const run = read(db, claim.id);
  if (!matches(run, claim) || run.cancel_requested_at !== null || run.origin === "heartbeat") return false;
  const previous = reply(db, run);
  ensure(Buffer.byteLength(previous.content) + Buffer.byteLength(text) <= 128 * 1024, "SERVICE_NOT_READY");
  if (!text) return true;
  const revision = bump(db, run.conversation_id, 1, now) + 1;
  db.prepare("UPDATE messages SET content=content||?,updated_revision=? WHERE id=? AND conversation_id=?").run(text, revision, run.reply_message_id, run.conversation_id);
  event(db, run, "reply.delta", { replyId: run.reply_message_id, text, revision }, now);
  return true;
}
export function terminal(db: Database.Database, run: Record, requested: "completed" | "failed" | "cancelled", code: FailureCode | undefined, now: number, ids: IdFactory, candidate?: string): void {
  ensure(run.status === "accepted" || run.status === "running", "SERVICE_NOT_READY");
  if (run.origin === "heartbeat") { terminalHeartbeat(db, run, requested, code, now, ids, candidate); return; }
  const state = run.cancel_requested_at !== null ? "cancelled" : requested, old = reply(db, run);
  ensure(state !== "completed" || old.content.trim().length > 0, "SERVICE_NOT_READY");
  interruptedArchives(db, run.id, now);
  settleContext(db, run, state === "completed", old.content, now, ids);
  const revision = bump(db, run.conversation_id, 1, now) + 1;
  db.prepare("UPDATE messages SET status=?,updated_revision=? WHERE id=? AND conversation_id=?").run(state === "completed" ? "complete" : "partial", revision, run.reply_message_id, run.conversation_id);
  db.prepare("UPDATE runs SET status=?,finished_at=?,error_code=? WHERE id=?").run(state, now, state === "failed" ? code ?? "UPSTREAM_UNAVAILABLE" : null, run.id);
  const final = reply(db, run);
  const fields = state === "completed" ? { reply: final } : state === "cancelled" ? { partialReply: final } : { code: code ?? "UPSTREAM_UNAVAILABLE", message: "本次生成未能完成。", partialReply: final };
  event(db, run, "run." + state, fields, now);
}
export function finish(db: Database.Database, claim: Claim, state: "completed" | "failed" | "cancelled", code: FailureCode | undefined, now: number, ids: IdFactory, candidate?: string): boolean {
  const run = read(db, claim.id); if (!matches(run, claim)) return false;
  terminal(db, run, state, code, now, ids, candidate); return true;
}

function terminalHeartbeat(db: Database.Database, run: Record, requested: "completed" | "failed" | "cancelled", code: FailureCode | undefined, now: number, ids: IdFactory, candidate?: string): void {
  let state = run.cancel_requested_at !== null ? "cancelled" : requested;
  if (state === "completed" && !candidate?.trim()) { state = "failed"; code = "EMPTY_REPLY"; }
  const row = db.prepare("SELECT content,visibility FROM messages WHERE id=? AND conversation_id=? AND role='assistant'").get(run.reply_message_id,run.conversation_id) as { content: string; visibility: string } | undefined;
  ensure(row && row.content === "" && row.visibility === "suppressed", "SERVICE_NOT_READY");
  const visible = state === "completed" && !silent(candidate!, heartbeatInput(run.input_json).definition.silenceMarkers);
  if (visible) {
    ensure(Buffer.byteLength(candidate!) <= 128 * 1024, "SERVICE_NOT_READY");
    settleHeartbeat(db,run,candidate!,now,ids);
    const revision = bump(db,run.conversation_id,1,now) + 1;
    db.prepare("UPDATE messages SET content=?,visibility='visible',status='complete',updated_revision=? WHERE id=?").run(candidate,revision,run.reply_message_id);
  } else db.prepare("UPDATE messages SET status=? WHERE id=?").run(state === "completed" ? "complete" : "partial",run.reply_message_id);
  interruptedArchives(db,run.id,now);
  db.prepare("UPDATE runs SET status=?,finished_at=?,error_code=? WHERE id=?").run(state,now,state === "failed" ? code ?? "UPSTREAM_UNAVAILABLE" : null,run.id);
  const fields = visible ? { reply: reply(db,run) } : state === "failed" ? { code: code ?? "UPSTREAM_UNAVAILABLE", message: "本次生成未能完成。" } : {};
  event(db,run,"run." + state,fields,now);
}
