import type Database from "better-sqlite3";
import type { ProtocolStorage, CallRef, CallArchive, ToolMessage } from "../providers/types.js";
import type { Claim } from "../conversations/types.js";
import { RunFailure } from "../conversations/types.js";
import { validateHistory, object, readMessage } from "../providers/messages.js";
import { owned } from "./runs/records.js";
import { matches } from "./runs/projection.js";
import { ensure } from "../application/errors.js";

const archiveLimit = 16 * 1024 * 1024;
export function protocolAccess(db: Database.Database, write: <T>(operation: () => T) => T): ProtocolStorage {
  const live = (claim: Claim) => {
    const row = owned(db, claim.ownerId, claim.id);
    ensure(matches(row, claim) && row.cancel_requested_at === null, "SERVICE_NOT_READY");
  };
  const callRow = (claim: Claim, call: CallRef) => {
    live(claim);
    const row = db.prepare("SELECT status,response_json AS response FROM provider_calls WHERE id=? AND run_id=? AND ordinal=?").get(call.id, claim.id, call.ordinal) as { status: string; response: string | null } | undefined;
    ensure(call.runId === claim.id && row, "SERVICE_NOT_READY"); return row;
  };
  return {
    begin(claim, id, request, now, purpose = "reply") {
      return write(() => {
        live(claim); validateHistory(request.messages);
        const count = db.prepare("SELECT count(*) AS total,COALESCE(sum(purpose='reply'),0) AS replies,COALESCE(sum(status='started'),0) AS active,COALESCE(max(ordinal),0) AS ordinal FROM provider_calls WHERE run_id=?").get(claim.id) as { total: number; replies: number; active: number; ordinal: number };
        if (count.total >= 9 || purpose === "reply" && count.replies >= 8 || purpose === "compaction" && count.total - count.replies >= 1) throw new RunFailure("TOOL_LIMIT");
        ensure(count.active === 0, "SERVICE_NOT_READY");
        const options = Object.fromEntries(["mode", "provider", "model", "maxTokens", "thinking", "reasoning_effort", "imageInput", "sourceEntryIds", "snapshotId", "purpose"].filter(key => Object.hasOwn(request.options, key)).map(key => [key, request.options[key]]));
        const manifest = JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools, options });
        if (Buffer.byteLength(manifest) > archiveLimit) throw new RunFailure("CONTEXT_TOO_LARGE");
        const ordinal = count.ordinal + 1;
        db.prepare("INSERT INTO provider_calls(id,run_id,ordinal,purpose,request_manifest_json,status,created_at) VALUES(?,?,?,?,?,'started',?)").run(id, claim.id, ordinal, purpose, manifest, now);
        return { id, runId: claim.id, ordinal };
      });
    },
    checkpoint(claim, call, archive, status, now) {
      write(() => {
        const row = callRow(claim, call); ensure(row.status === "started", "SERVICE_NOT_READY");
        let value = JSON.stringify(archive);
        const other = (db.prepare("SELECT COALESCE(sum(length(CAST(response_json AS BLOB))),0) AS bytes FROM provider_calls WHERE run_id=? AND id<>?").get(claim.id, call.id) as { bytes: number }).bytes;
        if (other + Buffer.byteLength(value) > archiveLimit - 4096) {
          if (status !== "failed") throw new RunFailure("OUTPUT_LIMIT");
          // 保留最后一个合法检查点，错误元数据使用预留空间；不把超预算正文继续落盘。
          const saved = row.response ? JSON.parse(row.response) as CallArchive : { assistant: { role: "assistant", content: "" } };
          value = JSON.stringify({ ...saved, error: { code: "OUTPUT_LIMIT" } });
        }
        const persisted = JSON.parse(value) as CallArchive;
        db.prepare("UPDATE provider_calls SET response_json=?,status=?,finish_reason=?,usage_json=?,finished_at=? WHERE id=? AND run_id=? AND status='started'")
          .run(value, status, persisted.finish_reason ?? null, persisted.usage ? JSON.stringify(persisted.usage) : null, status === "started" ? null : now, call.id, claim.id);
      });
    },
    beginTool(claim, call, id, tool, now) {
      return write(() => {
        const row = callRow(claim, call); ensure(row.status === "completed" && row.response, "SERVICE_NOT_READY");
        const source = JSON.parse(row.response) as CallArchive;
        ensure(source.finish_reason === "tool_calls" && source.assistant.tool_calls?.some(saved => saved.id === tool.id && saved.function.name === tool.function.name && saved.function.arguments === tool.function.arguments), "SERVICE_NOT_READY");
        const existing = db.prepare("SELECT id,status,name,arguments_json AS args,result_json AS result FROM tool_calls WHERE provider_call_id=? AND provider_tool_id=?").get(call.id, tool.id) as { id: string; status: string; name: string; args: string; result: string | null } | undefined;
        let args: string; try { args = JSON.stringify(JSON.parse(tool.function.arguments)); } catch { args = JSON.stringify({ invalidArguments: true }); }
        if (existing) {
          ensure(existing.name === tool.function.name && existing.args === args && ["completed", "failed"].includes(existing.status) && existing.result, "SERVICE_NOT_READY");
          return { id: existing.id, result: JSON.parse(existing.result) as ToolMessage };
        }
        if (db.prepare("SELECT 1 FROM tool_calls WHERE run_id=? AND provider_tool_id=?").get(claim.id, tool.id)) throw new RunFailure("UPSTREAM_INCOMPLETE");
        const counts = db.prepare("SELECT count(*) AS total,COALESCE(sum(provider_call_id=?),0) AS current FROM tool_calls WHERE run_id=?").get(call.id, claim.id) as { total: number; current: number };
        if (counts.total >= 16 || counts.current >= 8) throw new RunFailure("TOOL_LIMIT");
        db.prepare("INSERT INTO tool_calls(id,run_id,provider_call_id,provider_tool_id,name,arguments_json,status,created_at) VALUES(?,?,?,?,?,?,'running',?)").run(id, claim.id, call.id, tool.id, tool.function.name, args, now);
        return { id };
      });
    },
    finishTool(claim, id, result, failed, now) {
      write(() => {
        live(claim);
        const message = readMessage(result); ensure(message.role === "tool", "SERVICE_NOT_READY");
        const json = JSON.stringify(message);
        if (Buffer.byteLength(json) > 32 * 1024) throw new RunFailure("OUTPUT_LIMIT");
        const row = db.prepare("UPDATE tool_calls SET status=?,result_json=?,finished_at=? WHERE id=? AND run_id=? AND provider_tool_id=? AND status='running'").run(failed ? "failed" : "completed", json, now, id, claim.id, message.tool_call_id);
        ensure(row.changes === 1, "SERVICE_NOT_READY");
      });
    },
  };
}
export function interruptedArchives(db: Database.Database, runId: string, now: number): void {
  db.prepare("UPDATE provider_calls SET status='unknown',finished_at=? WHERE run_id=? AND status='started'").run(now, runId);
  db.prepare("UPDATE tool_calls SET status='unknown',finished_at=? WHERE run_id=? AND status IN ('pending','running')").run(now, runId);
}
export function completedProtocol(db: Database.Database, runId: string) {
  const calls = db.prepare("SELECT id,status,response_json AS response FROM provider_calls WHERE run_id=? AND purpose='reply' ORDER BY ordinal").all(runId) as { id: string; status: string; response: string | null }[];
  const messages = [];
  for (const call of calls) {
    ensure(call.status === "completed" && call.response, "SERVICE_NOT_READY");
    const saved = JSON.parse(call.response) as CallArchive, assistant = readMessage(saved.assistant);
    ensure(assistant.role === "assistant" && ["stop", "tool_calls"].includes(saved.finish_reason ?? ""), "SERVICE_NOT_READY");
    messages.push(assistant);
    for (const tool of assistant.tool_calls ?? []) {
      const row = db.prepare("SELECT result_json AS result,status FROM tool_calls WHERE run_id=? AND provider_call_id=? AND provider_tool_id=?").get(runId, call.id, tool.id) as { result: string | null; status: string } | undefined;
      ensure(row?.result && ["completed", "failed"].includes(row.status), "SERVICE_NOT_READY");
      const result = readMessage(JSON.parse(row.result)); ensure(result.role === "tool" && result.tool_call_id === tool.id, "SERVICE_NOT_READY"); messages.push(result);
    }
  }
  if (calls.length) ensure((JSON.parse(calls.at(-1)!.response!) as CallArchive).finish_reason === "stop", "SERVICE_NOT_READY");
  return validateHistory(messages);
}
