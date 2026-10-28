import { messageImages } from "../image-bindings.js";
import { submission } from "../../conversations/submit.js";
import type { MessageContent } from "../../images/content.js";
import { completedProtocol } from "../protocol.js";
import { readMessage, validateHistory } from "../../providers/messages.js";
import type { ProtocolMessage } from "../../providers/types.js";
import type Database from "better-sqlite3";
import type { IdFactory, ProviderRequest } from "../../ports.js";
import type { Record } from "./records.js";
import { ensure } from "../../application/errors.js";
import { RunFailure } from "../../conversations/types.js";
interface Entry { id: string; conversation_id: string; branch_id: string; parent_id: string | null; kind: string; payload_json: string; }
function boundInput(db: Database.Database, run: Record): MessageContent {
  const raw = JSON.parse(run.input_json);
  const input = submission({ ...raw, clientMessageId: run.request_key.slice(5) });
  const visible = db.prepare("SELECT content FROM messages WHERE id=? AND conversation_id=? AND role='user' AND visibility='visible'").get(run.user_message_id, run.conversation_id) as { content: string } | undefined;
  ensure(run.request_key.startsWith("user:") && visible && input.text === visible.content
    && input.inputJson === run.input_json && input.inputHash === run.input_hash, "SERVICE_NOT_READY");
  const images = messageImages(db, run.user_message_id!, run.conversation_id);
  ensure(JSON.stringify(images.map(image => image.id)) === JSON.stringify(input.imageIds), "SERVICE_NOT_READY");
  return images.length ? [...(input.text.length ? [{ type: "text" as const, text: input.text }] : []), ...images] : input.text;
}
export function userEntry(db: Database.Database, run: Record): Entry {
  const entry = db.prepare("SELECT * FROM context_entries WHERE id=? AND conversation_id=?").get(run.context_user_entry_id, run.conversation_id) as Entry | undefined;
  ensure(entry && entry.kind === "message", "SERVICE_NOT_READY");
  const payload = JSON.parse(entry.payload_json) as { role?: unknown; content?: unknown };
  ensure(payload.role === "user" && Object.keys(payload).every(key => ["role", "content"].includes(key))
    && JSON.stringify(payload.content) === JSON.stringify(boundInput(db, run)), "SERVICE_NOT_READY");
  ensure(db.prepare("SELECT 1 FROM branches WHERE id=? AND conversation_id=?").get(entry.branch_id, run.conversation_id), "SERVICE_NOT_READY");
  return entry;
}
export function beginTurn(db: Database.Database, run: Record, now: number, ids: IdFactory): { user: string; head: string | null } {
  const parent = db.prepare("SELECT active_branch_id AS branch,last_context_user_at AS last FROM conversations WHERE id=?").get(run.conversation_id) as { branch: string | null; last: number | null };
  const reset = parent.last !== null && run.created_at - parent.last >= 7 * 86400000;
  let branch = parent.branch, head: string | null = null;
  if (!branch || reset) {
    branch = ids.next();
    db.prepare("INSERT INTO branches(id,conversation_id,parent_branch_id,reason,created_at) VALUES(?,?,?,?,?)").run(branch, run.conversation_id, parent.branch, reset ? "idle_reset" : "initial", now);
    db.prepare("UPDATE conversations SET active_branch_id=? WHERE id=?").run(branch, run.conversation_id);
  } else {
    const existing = db.prepare("SELECT head_entry_id AS head FROM branches WHERE id=? AND conversation_id=?").get(branch, run.conversation_id) as { head: string | null } | undefined;
    ensure(existing, "SERVICE_NOT_READY"); head = existing.head;
  }
  const content = boundInput(db, run);
  const user = ids.next();
  db.prepare("INSERT INTO context_entries(id,conversation_id,branch_id,parent_id,kind,payload_json,created_at) VALUES(?,?,?,?,'message',?,?)").run(user, run.conversation_id, branch, head, JSON.stringify({ role: "user", content }), now);
  db.prepare("UPDATE branches SET head_entry_id=? WHERE id=? AND conversation_id=?").run(user, branch, run.conversation_id);
  db.prepare("UPDATE conversations SET last_context_user_at=? WHERE id=?").run(run.created_at, run.conversation_id);
  return { user, head };
}
export function context(db: Database.Database, run: Record): ProviderRequest {
  const current = userEntry(db, run), seen = new Set<string>(), messages: ProtocolMessage[] = [];
  let id: string | null = current.id, bytes = 0;
  while (id) {
    ensure(!seen.has(id), "SERVICE_NOT_READY"); seen.add(id);
    const row = db.prepare("SELECT * FROM context_entries WHERE id=? AND conversation_id=?").get(id, run.conversation_id) as Entry | undefined;
    ensure(row && row.kind === "message", "SERVICE_NOT_READY");
    const value = readMessage(JSON.parse(row.payload_json));
    bytes += Buffer.byteLength(row.payload_json);
    if (seen.size > 256 || bytes > 1024 * 1024) throw new RunFailure("CONTEXT_TOO_LARGE");
    messages.push(value); id = row.parent_id;
  }
  const history = validateHistory(messages.reverse());
  for (const message of history) {
    if (message.role === "assistant" && message.tool_calls) {
      for (const tool of message.tool_calls) { Object.freeze(tool.function); Object.freeze(tool); }
      Object.freeze(message.tool_calls);
    }
    if ((message.role === "user" || message.role === "tool") && Array.isArray(message.content)) { message.content.forEach(Object.freeze); Object.freeze(message.content); }
    Object.freeze(message);
  }
  return Object.freeze({ system: "仅为本地合成测试，不代表小葵或真实模型。", messages: Object.freeze(history), tools: Object.freeze([]), options: Object.freeze({ mode: "synthetic" }) });
}
export function settleContext(db: Database.Database, run: Record, completed: boolean, content: string, now: number, ids: IdFactory): void {
  if (run.status === "accepted" || run.origin === "heartbeat") return;
  const user = userEntry(db, run);
  const branch = db.prepare("SELECT head_entry_id AS head FROM branches WHERE id=? AND conversation_id=?").get(user.branch_id, run.conversation_id) as { head: string | null };
  let head = user.id;
  if (completed) {
    const snapshot = db.prepare("SELECT manifest_json AS manifest FROM context_snapshots WHERE run_id=?").get(run.id) as { manifest: string } | undefined;
    const prepared = snapshot ? JSON.parse(snapshot.manifest).preparedHead as string | undefined : undefined;
    ensure(branch.head === (prepared ?? user.id), "SERVICE_NOT_READY");
    head = prepared ?? user.id;
    const archived = completedProtocol(db, run.id);
    const entries: ProtocolMessage[] = archived.length ? archived : [{ role: "assistant", content }];
    ensure(entries.filter(message => message.role === "assistant").map(message => message.content ?? "").join("") === content, "SERVICE_NOT_READY");
    for (const message of entries) {
      const next = ids.next();
      db.prepare("INSERT INTO context_entries(id,conversation_id,branch_id,parent_id,kind,payload_json,created_at) VALUES(?,?,?,?,'message',?,?)")
        .run(next, run.conversation_id, user.branch_id, head, JSON.stringify(message), now);
      head = next;
    }
  }
  db.prepare("UPDATE branches SET head_entry_id=? WHERE id=? AND conversation_id=?").run(head, user.branch_id, run.conversation_id);
}
