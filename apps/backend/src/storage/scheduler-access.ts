import type Database from "better-sqlite3";
import type { IdFactory } from "../ports.js";
import { ensure } from "../application/errors.js";
import { hash } from "../context/profile.js";
import { definition, validateTask, TaskError, type TaskInput } from "../scheduler/types.js";
import { event, read, bump } from "./runs/records.js";
type Row = { id: string; conversation_id: string; enabled: number; interval_seconds: number; timezone: string; revision: number; definition_json: string; next_due_at: number };
function validReference(db: Database.Database, owner: string, input: TaskInput): void {
  validateTask(input);
  ensure(db.prepare("SELECT 1 FROM conversations c JOIN character_versions v ON v.character_id=c.character_id JOIN character_documents d ON d.version_id=v.id WHERE c.id=? AND c.owner_id=? AND c.deleted_at IS NULL AND v.id=? AND d.logical_name=? AND length(d.content)<=32768").get(input.conversationId, owner, input.definition.documentVersionId, input.definition.documentName), "NOT_FOUND");
}
export function schedulerAccess(db: Database.Database, write: <T>(fn: () => T) => T) {
  return Object.freeze({
    create(owner: string, id: string, input: TaskInput, now: number) {
      return write(() => {
        validReference(db, owner, input);
        db.prepare("INSERT INTO scheduled_tasks(id,conversation_id,interval_seconds,timezone,revision,definition_json,next_due_at,created_at) VALUES(?,?,?,?,1,?,?,?)")
          .run(id, input.conversationId, input.intervalSeconds, input.timezone, JSON.stringify(input.definition), input.nextDueAt, now);
        return { id, revision: 1, enabled: false };
      });
    },
    // 仅可信维护端口；网页和模型没有创建、启用或改写任务的入口。修改定义必定重新禁用。
    update(owner: string, id: string, expectedRevision: number, input: TaskInput) {
      return write(() => {
        validReference(db, owner, input);
        const row = db.prepare("SELECT t.* FROM scheduled_tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.owner_id=?").get(id, owner) as Row | undefined;
        ensure(row, "NOT_FOUND");
        if (row.revision !== expectedRevision) throw new TaskError("TASK_REVISION_CONFLICT");
        db.prepare("UPDATE scheduled_tasks SET conversation_id=?,interval_seconds=?,timezone=?,definition_json=?,next_due_at=?,enabled=0,revision=revision+1 WHERE id=?")
          .run(input.conversationId,input.intervalSeconds,input.timezone,JSON.stringify(input.definition),input.nextDueAt,id);
        return { id, revision: row.revision + 1, enabled: false };
      });
    },
    setEnabled(owner: string, id: string, expectedRevision: number, enabled: boolean) {
      return write(() => {
        const row = db.prepare("SELECT t.* FROM scheduled_tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.owner_id=?").get(id, owner) as Row | undefined;
        ensure(row, "NOT_FOUND"); if (row.revision !== expectedRevision) throw new TaskError("TASK_REVISION_CONFLICT");
        if (typeof enabled !== "boolean") throw new TaskError("TASK_INVALID");
        validReference(db, owner, { conversationId: row.conversation_id, intervalSeconds: row.interval_seconds, timezone: row.timezone, nextDueAt: row.next_due_at, definition: definition(JSON.parse(row.definition_json)) });
        db.prepare("UPDATE scheduled_tasks SET enabled=?,revision=revision+1 WHERE id=?").run(enabled ? 1 : 0, id);
        return { id, revision: row.revision + 1, enabled };
      });
    },
    tick(now: number, ids: IdFactory, globalQueue = 16): number {
      return write(() => {
        if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 || !Number.isSafeInteger(globalQueue) || globalQueue < 1 || globalQueue > 16) throw new TaskError("TASK_INVALID");
        // 在同一持租写事务读取当前revision并执行，避免扫描结果跨await后失效。
        const tasks = db.prepare("SELECT t.* FROM scheduled_tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.enabled=1 AND c.deleted_at IS NULL AND t.next_due_at<=? ORDER BY t.next_due_at,t.id LIMIT 100").all(now) as Row[];
        let enqueued = 0;
        for (const task of tasks) {
          const d = definition(JSON.parse(task.definition_json));
          validateTask({ conversationId: task.conversation_id, intervalSeconds: task.interval_seconds, timezone: task.timezone, nextDueAt: task.next_due_at, definition: d });
          const step = task.interval_seconds * 1000, due = task.next_due_at + Math.floor((now - task.next_due_at) / step) * step, next = due + step;
          if (!Number.isSafeInteger(next) || next > 8640000000000000) throw new TaskError("TASK_INVALID");
          if (due > task.next_due_at) db.prepare("INSERT INTO task_occurrences(task_id,due_at,range_start_at,status) VALUES(?,?,?,'skipped_catchup')")
            .run(task.id, due - step, task.next_due_at);
          const busy = db.prepare("SELECT 1 FROM runs WHERE conversation_id=? AND status IN ('accepted','running')").get(task.conversation_id)
            || (db.prepare("SELECT count(*) AS n FROM runs WHERE status IN ('accepted','running')").get() as { n: number }).n >= globalQueue;
          if (busy) db.prepare("INSERT INTO task_occurrences(task_id,due_at,status) VALUES(?,?,'skipped_busy')").run(task.id, due);
          else {
            const runId = ids.next(), replyId = ids.next();
            const c = db.prepare("SELECT next_public_seq AS seq,change_revision AS revision FROM conversations WHERE id=?").get(task.conversation_id) as { seq: number; revision: number };
            ensure(Number.isSafeInteger(c.seq + 1), "SERVICE_NOT_READY");
            db.prepare("UPDATE conversations SET next_public_seq=? WHERE id=?").run(c.seq + 1, task.conversation_id);
            db.prepare("INSERT INTO messages(id,conversation_id,seq,role,content,status,visibility,updated_revision,created_at) VALUES(?,?,?,'assistant','','partial','suppressed',?,?)").run(replyId, task.conversation_id, c.seq, bump(db, task.conversation_id, 1, now) + 1, now);
            const input = JSON.stringify({ taskId: task.id, revision: task.revision, dueAt: due, timezone: task.timezone, definition: d });
            db.prepare("INSERT INTO runs(id,conversation_id,origin,request_key,input_hash,reply_message_id,input_json,status,created_at) VALUES(?,?,'heartbeat',?,?,?,?,'accepted',?)")
              .run(runId, task.conversation_id, "task:" + task.id + ":" + due, hash(input), replyId, input, now);
            db.prepare("INSERT INTO task_occurrences(task_id,due_at,status,run_id) VALUES(?,?,'enqueued',?)").run(task.id, due, runId);
            event(db, read(db, runId)!, "run.accepted", { origin: "heartbeat", conversationId: task.conversation_id, replyId, acceptedAt: new Date(now).toISOString() }, now);
            enqueued++;
          }
          const changed = db.prepare("UPDATE scheduled_tasks SET next_due_at=? WHERE id=? AND enabled=1 AND revision=? AND next_due_at=?").run(next, task.id, task.revision, task.next_due_at);
          ensure(changed.changes === 1, "SERVICE_NOT_READY");
        }
        return enqueued;
      });
    },
  });
}
