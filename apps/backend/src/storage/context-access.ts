import { boundary } from "../conversations/boundary.js";
import type Database from "better-sqlite3";
import type { ContextStorage } from "../context/types.js";
import { loadPinned, snapshot, chain } from "./context-records.js";
import { resolve } from "../context/branches.js";
import { ensure } from "../application/errors.js";
import { object } from "../providers/messages.js";
import { RunFailure } from "../conversations/types.js";
export function contextAccess(db: Database.Database, write: <T>(fn: () => T) => T, guard: () => void): ContextStorage {
  return Object.freeze({
    load(claim) { guard(); return db.transaction(() => { guard(); return loadPinned(db, claim); })(); },
    save(claim, manifest, now, compact) {
      write(() => {
        const snap = snapshot(db, claim), old = snap.manifest;
        ensure(old.state === "pinned", "SERVICE_NOT_READY");
        const branch = db.prepare("SELECT head_entry_id AS head FROM branches WHERE id=? AND conversation_id=?").get(old.branchId, claim.conversationId) as { head: string } | undefined;
        ensure(branch?.head === boundary(claim), "SERVICE_NOT_READY");
        let head = boundary(claim);
        if (compact) {
          const call = db.prepare("SELECT response_json AS response FROM provider_calls WHERE id=? AND run_id=? AND purpose='compaction' AND status='completed'").get(compact.callId, claim.id) as { response: string } | undefined;
          if (!call || !object(compact.payload)) throw new RunFailure("COMPACTION_FAILED");
          const response = JSON.parse(call.response);
          let result: unknown; try { result = JSON.parse(response.assistant.content); } catch { throw new RunFailure("COMPACTION_FAILED"); }
          if (!object(result) || result.text !== compact.payload.summary || JSON.stringify(result.sourceIds) !== JSON.stringify(compact.payload.sourceIds) || compact.payload.providerCallId !== compact.callId) throw new RunFailure("COMPACTION_FAILED");
          resolve([...chain(db, claim.conversationId, boundary(claim)), { id: compact.id, branchId: String(old.branchId), parentId: boundary(claim), kind: "compaction", payload: compact.payload }], compact.id);
          db.prepare("INSERT INTO context_entries(id,conversation_id,branch_id,parent_id,kind,payload_json,created_at) VALUES(?,?,?,?,'compaction',?,?)").run(compact.id, claim.conversationId, old.branchId, boundary(claim), JSON.stringify(compact.payload), now);
          db.prepare("UPDATE branches SET head_entry_id=? WHERE id=? AND conversation_id=?").run(compact.id, old.branchId, claim.conversationId); head = compact.id;
        }
        const saved = JSON.stringify({ ...old, state: "ready", preparedHead: head, prepared: manifest });
        if (Buffer.byteLength(saved) > 2 * 1024 * 1024) throw new RunFailure("CONTEXT_TOO_LARGE");
        db.prepare("UPDATE context_snapshots SET manifest_json=? WHERE run_id=?").run(saved, claim.id);
      });
    },
  } satisfies ContextStorage);
}
