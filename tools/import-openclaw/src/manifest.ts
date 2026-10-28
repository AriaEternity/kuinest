import { validateReviewedAdditions } from "./review-additions.js";
import { bindReplay } from "./replay.js";
import { documentNames, additionDocumentNames, config, profile, memoryKey } from "../../../apps/backend/dist/context/profile.js";
import type { Scope, Manifest, FileKind } from "./types.js";
import { compatibilityKeys } from "./types.js";
import { check, object, uuid, hex, id, limits } from "./safe.js";
const closed = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
export function allowed(path: string, kind: FileKind): boolean {
  if (kind === "addition") return additionDocumentNames.some(n => path === "workspace/" + n);
  if (kind === "document") return documentNames.some(n => path === "workspace/" + n);
  if (kind === "memory") return path.startsWith("workspace/memory/") && memoryKey(path.slice(10));
  if (kind === "session") return /^sessions\/[A-Za-z0-9_-]{1,128}\.jsonl$/.test(path);
  if (kind === "index") return path === "sessions/sessions.json";
  return kind === "tasks" && path === "tasks/jobs.json";
}
export function scope(value: unknown, sealed = false): Scope | Manifest {
  check(object(value) && closed(value, ["format","sourceId","batchId","revision","parent","agentId","mode","sourceVersion","requireReasoning","reasoningReplay","migrationMode","removedMemories","reviewedAdditions","files","conversations","profile","config","compatibility", ...(sealed ? ["consistency","capturedAt"] : [])]), "MANIFEST_INVALID");
  check(value.format === "kuinest-openclaw-v1" && uuid(value.sourceId) && uuid(value.batchId) && value.agentId === "main"
    && ["synthetic","private"].includes(String(value.mode)) && value.sourceVersion === "2026.7.1-2" && typeof value.requireReasoning === "boolean", "SOURCE_IDENTITY");
  check(value.migrationMode === undefined || value.migrationMode === "fresh-start-v1", "MIGRATION_MODE_INVALID");
  const fresh = value.migrationMode === "fresh-start-v1";
  check(fresh || value.removedMemories === undefined, "MIGRATION_MODE_INVALID");
  if (fresh) check(value.requireReasoning === false && value.reasoningReplay === undefined, "FRESH_START_POLICY");
  check(Number.isSafeInteger(value.revision) && Number(value.revision) > 0 && (value.revision === 1 ? value.parent === null : hex(value.parent)), "BATCH_CHAIN");
  check(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= limits.files, "MANIFEST_INVALID");
  const names = new Set<string>(); let total = 0;
  for (const f of value.files) {
    check(object(f) && closed(f, sealed ? ["path","kind","bytes","sha256"] : ["path","kind"]) && typeof f.path === "string" && allowed(f.path, f.kind as FileKind) && !names.has(f.path.toLowerCase()), "FILE_ALLOWLIST");
    names.add(f.path.toLowerCase());
    if (sealed) {
      check(hex(f.sha256) && Number.isSafeInteger(f.bytes) && Number(f.bytes) >= 0 && Number(f.bytes) <= limits.file, "FILE_LIMIT_OR_UNSAFE");
      total += Number(f.bytes);
    }
  }
  check(total <= limits.total && (fresh || names.has("sessions/sessions.json")), "MANIFEST_INVALID");
  check(documentNames.every(n => names.has(("workspace/" + n).toLowerCase())), "DOCUMENT_MISSING");
  check(Array.isArray(value.conversations) && value.conversations.length > 0 && value.conversations.length <= (fresh ? 1 : 200), "MAPPING_INVALID");
  const keys = new Set<string>(), sessions = new Set<string>();
  for (const c of value.conversations) {
    check(object(c) && closed(c, ["key","history"]) && typeof c.key === "string" && /^agent:main:[a-zA-Z0-9:_-]{1,128}$/.test(c.key) && !keys.has(c.key) && Array.isArray(c.history) && (fresh ? c.history.length === 0 : c.history.length > 0 && c.history.length <= 1000), "MAPPING_INVALID");
    keys.add(c.key);
    for (const s of c.history) {
      check(object(s) && closed(s, ["sessionId","leafId"]) && id(s.sessionId) && (s.leafId === null || id(s.leafId)) && !sessions.has(s.sessionId), "MAPPING_INVALID");
      sessions.add(s.sessionId);
    }
  }
  if (value.removedMemories !== undefined) {
    check(fresh && Array.isArray(value.removedMemories) && value.removedMemories.length <= limits.files, "MEMORY_REMOVAL_INVALID");
    const removed = new Set<string>();
    for (const path of value.removedMemories) {
      check(typeof path === "string" && allowed(path, "memory") && !names.has(path.toLowerCase()) && !removed.has(path.toLowerCase()), "MEMORY_REMOVAL_INVALID");
      removed.add(path.toLowerCase());
    }
    check(value.revision !== 1 || removed.size === 0, "MEMORY_REMOVAL_INVALID");
  }
  const compatibility = value.compatibility;
  check(object(compatibility) && closed(compatibility, [...compatibilityKeys]) && compatibilityKeys.every(k => ["verified","unverified","accepted_difference"].includes(String(compatibility[k]))), "COMPATIBILITY_INVALID");
  check(object(value.profile) && closed(value.profile, ["id","provider","model","endpoint","options","status"]) && id(value.profile.id), "PROFILE_INVALID");
  check(value.mode === "synthetic" ? value.profile.status === "synthetic" && value.profile.provider === "mock" : value.profile.status === "unverified" && value.profile.provider === "deepseek", "PROFILE_INVALID");
  try { profile(value.profile as unknown as Scope["profile"]); config(value.config); } catch { check(false, "PROFILE_INVALID"); }
  validateReviewedAdditions(value, sealed);
  if (value.reasoningReplay !== undefined) bindReplay(value.reasoningReplay, value.profile as unknown as Scope["profile"]);
  if (sealed) check(value.consistency === "double-read-matched" && Number.isSafeInteger(value.capturedAt) && Number(value.capturedAt) > 0, "CONSISTENCY_INVALID");
  return structuredClone(value) as unknown as Scope | Manifest;
}
