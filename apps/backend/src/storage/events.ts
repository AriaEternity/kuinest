import { publicRunFailure } from "../application/run-failure.js";
import type Database from "better-sqlite3";
import { readContract, type RunStatus } from "@kuinest/contracts";
import type { EventStorage } from "../conversations/events.js";
import { ensure } from "../application/errors.js";

export function eventAccess(db: Database.Database, write: <T>(op: () => T) => T, guard: () => void): EventStorage {
  return {
    read(owner, id, cursor) {
      guard();
      return db.transaction(() => {
        guard();
        const run = db.prepare(`SELECT r.last_event_seq AS lastSequence,r.event_floor_seq AS floor,r.status,
          r.origin,r.conversation_id AS conversationId,r.reply_message_id AS replyId,m.visibility
          FROM runs r JOIN conversations c ON c.id=r.conversation_id
          JOIN messages m ON m.id=r.reply_message_id AND m.conversation_id=r.conversation_id
          WHERE r.id=? AND c.owner_id=?`).get(id, owner) as {
          lastSequence: number; floor: number; status: RunStatus; origin: string; conversationId: string; replyId: string; visibility: string;
        } | undefined;
        ensure(run, "NOT_FOUND");
        ensure(Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= run.lastSequence, "CURSOR_INVALID");
        ensure(cursor >= run.floor - 1, "EVENT_WINDOW_EXPIRED");
        const row = db.prepare("SELECT seq,type,payload_json AS payload FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 1").get(id, cursor) as { seq: number; type: string; payload: string } | undefined;
        if (!row) { ensure(cursor === run.lastSequence, "SERVICE_NOT_READY"); return { lastSequence: run.lastSequence, status: run.status }; }
        let event = readContract("runEvent", JSON.parse(row.payload));
        ensure(event.runId === id && event.sequence === row.seq && row.seq === cursor + 1 && event.type === row.type, "SERVICE_NOT_READY");
        if (event.type === "run.accepted") {
          ensure(event.origin === run.origin, "SERVICE_NOT_READY");
          if (event.origin === "user") ensure(event.submission.runId === id && event.submission.conversationId === run.conversationId && event.submission.replyId === run.replyId, "SERVICE_NOT_READY");
          else ensure(event.conversationId === run.conversationId && event.replyId === run.replyId, "SERVICE_NOT_READY");
        }
        const message = event.type === "run.completed" ? event.reply : event.type === "run.failed" || event.type === "run.cancelled" ? event.partialReply : undefined;
        if (event.type === "reply.delta") ensure(run.visibility === "visible" && run.origin === "user" && event.replyId === run.replyId, "SERVICE_NOT_READY");
        if (message) ensure(run.visibility === "visible" && message.id === run.replyId && message.conversationId === run.conversationId && message.runId === id && message.role === "assistant", "SERVICE_NOT_READY");
        if (event.type === "run.completed" && run.origin === "user") ensure(message?.status === "complete", "SERVICE_NOT_READY");
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) ensure(event.sequence === run.lastSequence && event.type === "run." + run.status, "SERVICE_NOT_READY");
        if ((event.type === "run.failed" || event.type === "run.cancelled") && message) ensure(message.status === "partial", "SERVICE_NOT_READY");
        if (event.type === "run.failed") event = { ...event, ...publicRunFailure(event.code) };
        return { lastSequence: run.lastSequence, status: run.status, event };
      })();
    },
    prune(now) {
      return write(() => {
        const rows = db.prepare(`SELECT r.id,r.last_event_seq AS seq FROM runs r
          WHERE r.status IN ('completed','failed','cancelled') AND r.finished_at<=?
          AND r.event_floor_seq<r.last_event_seq
          AND EXISTS(SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.seq=r.last_event_seq AND e.type IN ('run.completed','run.failed','run.cancelled'))
          ORDER BY r.finished_at,r.id LIMIT 100`).all(now - 7 * 86400000) as { id: string; seq: number }[];
        for (const row of rows) {
          db.prepare("DELETE FROM run_events WHERE run_id=? AND seq<?").run(row.id, row.seq);
          db.prepare("UPDATE runs SET event_floor_seq=? WHERE id=?").run(row.seq, row.id);
        }
        return rows.length;
      });
    },
  };
}
