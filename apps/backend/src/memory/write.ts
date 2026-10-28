import type Database from "better-sqlite3";
import type { Claim } from "../conversations/types.js";
import type { MemoryVersion } from "../context/types.js";
import { config, memoryKey, validText } from "../context/profile.js";
import { activeVersion, liveContext, snapshot } from "../storage/context-records.js";
export class MemoryError extends Error {
  constructor(readonly code: "MEMORY_VERSION_CONFLICT" | "MEMORY_WRITE_INVALID" | "MEMORY_TOOL_INVALID") { super("记忆操作未完成。"); }
}
export type MemoryWrite = { characterId: string; key: string; expectedVersion: string | null; content: string; provenance: { source: "synthetic" | "tool"; reference: string }; sourceToolCallId?: string; claim?: Claim; operation?: "append" | "replace" };
const fail = (code: ConstructorParameters<typeof MemoryError>[0]): never => { throw new MemoryError(code); };
const projection = "id,character_id AS characterId,logical_key AS key,version,parent_id AS parentId,content,provenance_json AS provenance,source_tool_call_id AS sourceToolCallId";
export function writeMemory(db: Database.Database, owner: string, input: MemoryWrite, id: string, now: number): MemoryVersion {
  const v = activeVersion(db, owner, input.characterId);
  if (!memoryKey(input.key) || !(input.expectedVersion === null || typeof input.expectedVersion === "string") || !validText(input.content) || Buffer.byteLength(input.content) > 32 * 1024
    || !input.provenance || !["synthetic", "tool"].includes(input.provenance.source) || typeof input.provenance.reference !== "string" || input.provenance.reference.length > 256
    || Object.keys(input.provenance).some(k => !["source", "reference"].includes(k))) return fail("MEMORY_WRITE_INVALID");
  let content = input.content;
  if (input.operation) {
    if (input.provenance.source !== "tool" || !["append","replace"].includes(input.operation)) return fail("MEMORY_WRITE_INVALID");
    if (input.operation === "append" && input.expectedVersion !== null) {
      const parent = db.prepare("SELECT content FROM memory_versions WHERE id=? AND character_id=? AND logical_key=?").get(input.expectedVersion,input.characterId,input.key) as { content: string } | undefined;
      if (!parent) return fail("MEMORY_VERSION_CONFLICT"); content = parent.content + input.content;
    }
    if (Buffer.byteLength(content) > 32768) return fail("MEMORY_WRITE_INVALID");
  }
  const provenance = JSON.stringify(input.provenance);
  if (input.sourceToolCallId) {
    const replay = db.prepare("SELECT " + projection + " FROM memory_versions WHERE source_tool_call_id=?").get(input.sourceToolCallId) as MemoryVersion | undefined;
    if (replay) {
      if (replay.characterId !== input.characterId || replay.key !== input.key || replay.parentId !== input.expectedVersion || replay.content !== content || replay.provenance !== provenance) return fail("MEMORY_TOOL_INVALID");
      return { ...replay, provenance: JSON.parse(provenance) };
    }
  }
  let c = config(JSON.parse(v.config), v.status === "synthetic");
  if (input.provenance.source === "tool") {
    if (!input.claim || !input.sourceToolCallId || input.claim.ownerId !== owner) return fail("MEMORY_TOOL_INVALID");
    liveContext(db, input.claim);
    const pinned = snapshot(db, input.claim);
    if (pinned.manifest.characterId !== input.characterId) return fail("MEMORY_TOOL_INVALID");
    const version = db.prepare("SELECT v.config_json AS config,p.compatibility_status AS status FROM character_versions v JOIN provider_profiles p ON p.id=v.provider_profile_id WHERE v.id=? AND v.character_id=? AND p.id=?").get(pinned.versionId, input.characterId, pinned.profileId) as { config: string; status: string };
    c = config(JSON.parse(version.config), version.status === "synthetic");
    const call = db.prepare("SELECT name,arguments_json AS args FROM tool_calls WHERE id=? AND run_id=? AND status='running'").get(input.sourceToolCallId, input.claim.id) as { name: string; args: string } | undefined;
    if (!call || call.name !== (input.operation ? "memory_" + input.operation : "memory_write")) return fail("MEMORY_TOOL_INVALID");
    if (input.operation && (pinned.manifest.allowMemoryWrite !== true || (input.operation === "append" ? !c.memoryAppendKeys.includes(input.key) : !c.memoryReplaceEnabled))) return fail("MEMORY_TOOL_INVALID");
    const args = JSON.parse(call.args);
    if (args.key !== input.key || args.expectedVersion !== input.expectedVersion || args.content !== input.content) return fail("MEMORY_TOOL_INVALID");
  } else if (input.sourceToolCallId || input.claim || v.status !== "synthetic") return fail("MEMORY_WRITE_INVALID");
  if (!c.memoryWriteKeys.includes(input.key)) return fail("MEMORY_WRITE_INVALID");
  const old = db.prepare("SELECT v.id,v.version FROM memory_heads h JOIN memory_versions v ON v.id=h.version_id AND v.character_id=h.character_id AND v.logical_key=h.logical_key WHERE h.character_id=? AND h.logical_key=?").get(input.characterId, input.key) as { id: string; version: number } | undefined;
  if ((old?.id ?? null) !== input.expectedVersion) return fail("MEMORY_VERSION_CONFLICT");
  // 已停用的键可以重新建立，但不能复用旧版本号或自动拼回旧内容；CAS仍以当前指针为准。
  const last = old ?? db.prepare("SELECT version FROM memory_versions WHERE character_id=? AND logical_key=? ORDER BY version DESC LIMIT 1").get(input.characterId,input.key) as {version:number} | undefined;
  const version = (last?.version ?? 0) + 1;
  db.prepare("INSERT INTO memory_versions(id,character_id,logical_key,version,parent_id,content,provenance_json,source_tool_call_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, input.characterId, input.key, version, old?.id ?? null, content, provenance, input.sourceToolCallId ?? null, now);
  db.prepare("INSERT INTO memory_heads(character_id,logical_key,version_id) VALUES(?,?,?) ON CONFLICT(character_id,logical_key) DO UPDATE SET version_id=excluded.version_id").run(input.characterId, input.key, id);
  return { id, characterId: input.characterId, key: input.key, version, parentId: old?.id ?? null, content, provenance: input.provenance, sourceToolCallId: input.sourceToolCallId ?? null };
}
