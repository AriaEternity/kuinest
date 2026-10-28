import { beginHeartbeat } from "./heartbeat.js";
import { pinContext } from "../context-records.js";
import type Database from "better-sqlite3";
import type { IdFactory } from "../../ports.js";
import type { LeaseToken } from "../lease.js";
import type { Claim } from "../../conversations/types.js";
import { ensure } from "../../application/errors.js";
import { beginTurn } from "./context.js";
import { event, type Record } from "./records.js";
export function claim(db: Database.Database, token: LeaseToken, now: number, ids: IdFactory, withContext = false): Claim | undefined {
  if (db.prepare("SELECT 1 FROM runs WHERE status='running'").get()) return undefined;
  const user = db.prepare("SELECT r.* FROM runs r JOIN messages m ON m.id=r.user_message_id AND m.conversation_id=r.conversation_id WHERE r.status='accepted' AND r.origin='user' AND NOT EXISTS(SELECT 1 FROM runs earlier JOIN messages em ON em.id=earlier.user_message_id AND em.conversation_id=earlier.conversation_id WHERE earlier.conversation_id=r.conversation_id AND earlier.origin='user' AND earlier.status IN ('accepted','running') AND em.seq<m.seq) ORDER BY r.created_at,r.id LIMIT 1").get() as Record | undefined;
  const run = user ?? (withContext ? db.prepare("SELECT * FROM runs WHERE status='accepted' AND origin='heartbeat' ORDER BY created_at,id LIMIT 1").get() as Record | undefined : undefined);
  if (!run) return undefined;
  ensure(run.cancel_requested_at === null, "SERVICE_NOT_READY");
  const heartbeat = run.origin === "heartbeat" ? beginHeartbeat(db, run, now, ids) : undefined;
  const boundary = heartbeat ? { head: heartbeat.head, user: null } : beginTurn(db, run, now, ids);
  db.prepare("UPDATE runs SET status='running',claim_owner=?,fence=?,started_at=?,context_head_at_start=?,context_user_entry_id=? WHERE id=? AND status='accepted'").run(token.owner, token.fence, now, boundary.head, boundary.user, run.id);
  const owner = (db.prepare("SELECT owner_id AS id FROM conversations WHERE id=?").get(run.conversation_id) as { id: string }).id;
  if (withContext) pinContext(db, { ...run, context_user_entry_id: boundary.user }, owner, ids.next(), now, heartbeat?.anchor);
  event(db, run, "run.started", {}, now);
  return Object.freeze({ id: run.id, conversationId: run.conversation_id, ownerId: owner, fence: token.fence, claimOwner: token.owner, contextUserEntryId: boundary.user, origin: run.origin, ...(heartbeat ? { contextBoundaryId: heartbeat.anchor } : {}) });
}
