import type Database from "better-sqlite3";
import type { RunStorage } from "../../conversations/types.js";
import type { LeaseToken } from "../lease.js";
import { ensure } from "../../application/errors.js";
import { read, owned, type Record } from "./records.js";
import { submit } from "./submit.js";
import { claim } from "./queue.js";
import { context, userEntry } from "./context.js";
import { append, finish, matches, terminal } from "./projection.js";
export function runAccess(db: Database.Database, token: LeaseToken, write: <T>(operation: () => T) => T, guard: () => void, withContext = false, webSearch = false, images = false): RunStorage {
  const view = <T>(operation: () => T) => { guard(); return db.transaction(() => { guard(); return operation(); })(); };
  return Object.freeze({
    supportsImages: images && withContext,
    submit: (owner, conversation, input, now, ids, limits) => write(() => submit(db, owner, conversation, input, now, ids, limits, webSearch, images)),
    claim: (now, ids) => write(() => claim(db, token, now, ids, withContext)),
    context: current => view(() => { const row = read(db, current.id); ensure(matches(row, current), "SERVICE_NOT_READY"); return context(db, row); }),
    append: (current, text, now) => write(() => append(db, current, text, now)),
    finish: (current, status, code, now, ids, candidate) => write(() => finish(db, current, status, code, now, ids, candidate)),
    cancel: (owner, id, now, ids) => write(() => {
      const row = owned(db, owner, id);
      if (row.status !== "accepted" && row.status !== "running") return;
      db.prepare("UPDATE runs SET cancel_requested_at=COALESCE(cancel_requested_at,?) WHERE id=?").run(now, id);
      if (row.status === "accepted") { row.cancel_requested_at = now; terminal(db, row, "cancelled", undefined, now, ids); }
    }),
    control: current => view(() => {
      const row = read(db, current.id); return !matches(row, current) ? "terminal" : row.cancel_requested_at !== null ? "cancelled" : "running";
    }),
    recover: (now, ids) => write(() => {
      // 用户输入保留；中断的主动候选仍隐藏，已受理任务继续排队。
      const rows = db.prepare("SELECT * FROM runs WHERE status='running'").all() as Record[];
      for (const row of rows) {
        ensure(row.fence !== token.fence || row.claim_owner !== token.owner, "SERVICE_NOT_READY");
        if (row.origin === "user") userEntry(db, row); terminal(db, row, row.cancel_requested_at !== null ? "cancelled" : "failed", "RUN_INTERRUPTED", now, ids);
      }
      return rows.length;
    }),
  } satisfies RunStorage);
}
