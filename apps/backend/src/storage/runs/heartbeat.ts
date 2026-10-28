import type Database from "better-sqlite3";
import type { IdFactory } from "../../ports.js";
import type { Record } from "./records.js";
import { ensure } from "../../application/errors.js";
import { completedProtocol } from "../protocol.js";
import { heartbeatInput } from "../../scheduler/types.js";
export function beginHeartbeat(db: Database.Database, run: Record, now: number, ids: IdFactory) {
  heartbeatInput(run.input_json);
  ensure(run.user_message_id === null && run.context_user_entry_id === null, "SERVICE_NOT_READY");
  const c = db.prepare("SELECT c.active_branch_id AS branch,b.head_entry_id AS head FROM conversations c LEFT JOIN branches b ON b.id=c.active_branch_id AND b.conversation_id=c.id WHERE c.id=?").get(run.conversation_id) as { branch: string | null; head: string | null };
  const branch = ids.next(), anchor = ids.next();
  db.prepare("INSERT INTO branches(id,conversation_id,parent_branch_id,reason,created_at) VALUES(?,?,?,'heartbeat',?)").run(branch,run.conversation_id,c.branch,now);
  db.prepare("INSERT INTO context_entries(id,conversation_id,branch_id,parent_id,kind,payload_json,created_at) VALUES(?,?,?,?,'custom',?,?)")
    .run(anchor,run.conversation_id,branch,c.head,JSON.stringify({ type: "heartbeat_boundary", runId: run.id, task: heartbeatInput(run.input_json) }),now);
  db.prepare("UPDATE branches SET head_entry_id=? WHERE id=?").run(anchor,branch);
  return { anchor, branch, head: c.head };
}
export function settleHeartbeat(db: Database.Database, run: Record, content: string, now: number, ids: IdFactory): void {
  const row = db.prepare("SELECT manifest_json AS manifest FROM context_snapshots WHERE run_id=?").get(run.id) as { manifest: string } | undefined;
  ensure(row, "SERVICE_NOT_READY"); const m = JSON.parse(row.manifest);
  ensure(m.state === "ready" && typeof m.preparedHead === "string" && typeof m.branchId === "string", "SERVICE_NOT_READY");
  const branch = db.prepare("SELECT head_entry_id AS head,parent_branch_id AS parent FROM branches WHERE id=? AND conversation_id=? AND reason='heartbeat'").get(m.branchId,run.conversation_id) as { head: string; parent: string | null } | undefined;
  const active = db.prepare("SELECT c.active_branch_id AS branch,b.head_entry_id AS head FROM conversations c LEFT JOIN branches b ON b.id=c.active_branch_id AND b.conversation_id=c.id WHERE c.id=?").get(run.conversation_id) as { branch: string | null; head: string | null };
  ensure(branch && branch.head === m.preparedHead && active.branch === branch.parent && active.head === run.context_head_at_start, "SERVICE_NOT_READY");
  const messages = completedProtocol(db, run.id);
  ensure(messages.length && messages.filter(v => v.role === "assistant").map(v => v.content ?? "").join("") === content, "SERVICE_NOT_READY");
  let head = branch.head;
  for (const message of messages) {
    const id = ids.next();
    db.prepare("INSERT INTO context_entries(id,conversation_id,branch_id,parent_id,kind,payload_json,created_at) VALUES(?,?,?,?,'message',?,?)").run(id,run.conversation_id,m.branchId,head,JSON.stringify(message),now);
    head = id;
  }
  db.prepare("UPDATE branches SET head_entry_id=? WHERE id=? AND conversation_id=?").run(head,m.branchId,run.conversation_id);
  db.prepare("UPDATE conversations SET active_branch_id=? WHERE id=?").run(m.branchId,run.conversation_id);
}
