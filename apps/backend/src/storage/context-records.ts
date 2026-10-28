import { hasTable } from "./migrations.js";
import { boundary } from "../conversations/boundary.js";
import { heartbeatInput } from "../scheduler/types.js";
import type Database from "better-sqlite3";
import type { Claim } from "../conversations/types.js";
import { RunFailure } from "../conversations/types.js";
import { ensure } from "../application/errors.js";
import { owned, type Record as RunRecord } from "./runs/records.js";
import { matches } from "./runs/projection.js";
import { hash } from "../context/profile.js";
import type { Entry, MemoryVersion, Pinned, Profile } from "../context/types.js";
import { object } from "../providers/messages.js";
export function liveContext(db: Database.Database, claim: Claim) {
  const run = owned(db, claim.ownerId, claim.id);
  ensure(matches(run, claim) && run.cancel_requested_at === null, "SERVICE_NOT_READY"); return run;
}
type VersionRow = { characterId: string; versionId: string; profileId: string; config: string; provider: Profile["provider"]; model: string; endpoint: string | null; options: string; status: string; profileOwner: string };
export function activeVersion(db: Database.Database, owner: string, character: string): VersionRow {
  const row = db.prepare("SELECT c.id AS characterId,v.id AS versionId,v.provider_profile_id AS profileId,v.config_json AS config,p.provider,p.model,p.endpoint,p.options_json AS options,p.compatibility_status AS status,p.owner_id AS profileOwner FROM characters c JOIN character_versions v ON v.id=c.active_version_id AND v.character_id=c.id JOIN provider_profiles p ON p.id=v.provider_profile_id WHERE c.id=? AND c.owner_id=?").get(character, owner) as VersionRow | undefined;
  ensure(row && row.profileOwner === owner, "NOT_FOUND"); return row;
}
export function memoryRows(db: Database.Database, character: string): MemoryVersion[] {
  const count = db.prepare("SELECT count(*) AS n,COALESCE(sum(length(CAST(v.content AS BLOB))),0) AS bytes FROM memory_heads h JOIN memory_versions v ON v.id=h.version_id AND v.character_id=h.character_id AND v.logical_key=h.logical_key WHERE h.character_id=?").get(character) as { n: number; bytes: number };
  if (count.n > 200 || count.bytes > 1024 * 1024) throw new RunFailure("MEMORY_INDEX_REQUIRED");
  const rows = db.prepare("SELECT v.id,v.character_id AS characterId,v.logical_key AS key,v.version,v.parent_id AS parentId,v.content,v.provenance_json AS provenance,v.source_tool_call_id AS sourceToolCallId FROM memory_heads h JOIN memory_versions v ON v.id=h.version_id AND v.character_id=h.character_id AND v.logical_key=h.logical_key WHERE h.character_id=? ORDER BY v.logical_key").all(character) as MemoryVersion[];
  return rows.map(row => ({ ...row, provenance: JSON.parse(row.provenance as string), ...confirmedFlag(db,row.id,character) }));
}
export function chain(db: Database.Database, conversation: string, boundary: string): Entry[] {
  const entries: Entry[] = [], seen = new Set<string>(); let id: string | null = boundary, bytes = 0;
  while (id) {
    if (seen.has(id)) throw new RunFailure("CONTEXT_INVALID"); seen.add(id);
    const row = db.prepare("SELECT id,parent_id AS parentId,branch_id AS branchId,kind,payload_json AS payload FROM context_entries WHERE id=? AND conversation_id=?").get(id, conversation) as (Omit<Entry, "payload"> & { payload: string }) | undefined;
    if (!row) throw new RunFailure("CONTEXT_INVALID");
    bytes += Buffer.byteLength(row.payload);
    if (entries.length >= 10000 || bytes > 32 * 1024 * 1024) throw new RunFailure("CONTEXT_TOO_LARGE");
    let payload: unknown; try { payload = JSON.parse(row.payload); } catch { throw new RunFailure("CONTEXT_INVALID"); }
    entries.push({ ...row, payload }); id = row.parentId;
  }
  return entries;
}
export function pinContext(db: Database.Database, run: RunRecord, owner: string, snapshotId: string, now: number, heartbeatBoundary?: string): void {
  const conversation = db.prepare("SELECT character_id AS character FROM conversations WHERE id=? AND owner_id=?").get(run.conversation_id, owner) as { character: string };
  const task = run.origin === "heartbeat" ? heartbeatInput(run.input_json) : undefined;
  let v = activeVersion(db, owner, conversation.character);
  if (task) {
    const fixed = db.prepare("SELECT c.id AS characterId,v.id AS versionId,v.provider_profile_id AS profileId,v.config_json AS config,p.provider,p.model,p.endpoint,p.options_json AS options,p.compatibility_status AS status,p.owner_id AS profileOwner FROM characters c JOIN character_versions v ON v.character_id=c.id JOIN provider_profiles p ON p.id=v.provider_profile_id WHERE c.id=? AND c.owner_id=? AND v.id=? AND p.owner_id=?").get(conversation.character,owner,task.definition.documentVersionId,owner) as VersionRow | undefined;
    ensure(fixed, "SERVICE_NOT_READY"); v = fixed;
  }
  const docs = db.prepare("SELECT logical_name AS name,sha256 FROM character_documents WHERE version_id=? ORDER BY logical_name").all(v.versionId);
  let memories: { id: string; key: string; sha256: string }[] = [], memoryIndexRequired = false;
  try { memories = memoryRows(db, v.characterId).map(m => ({ id: m.id, key: m.key, sha256: hash(m.content) })); }
  catch (error) { if (!(error instanceof RunFailure && error.code === "MEMORY_INDEX_REQUIRED")) throw error; memoryIndexRequired = true; }
  const currentBoundary = heartbeatBoundary ?? run.context_user_entry_id;
  ensure(currentBoundary, "SERVICE_NOT_READY");
  const user = db.prepare("SELECT branch_id AS branch FROM context_entries WHERE id=? AND conversation_id=?").get(currentBoundary, run.conversation_id) as { branch: string };
  const manifest = { state: "pinned", compiler: "kuinest-v1", boundary: currentBoundary, origin: run.origin, allowWebSearch: task?.definition.allowWebSearch ?? JSON.parse(run.input_json).allowWebSearch === true, allowMemoryWrite: task ? task.definition.allowMemoryWrite : true, ...(task ? { task: { ...task.definition, revision: task.revision, timezone: task.timezone } } : {}), branchId: user.branch, characterId: v.characterId,
    configHash: hash(v.config), profileHash: hash(JSON.stringify([v.provider, v.model, v.endpoint, v.options, v.status])), documents: docs, memories, memoryIndexRequired, receivedAt: run.created_at };
  db.prepare("INSERT INTO context_snapshots(id,run_id,character_version_id,provider_profile_id,manifest_json,created_at) VALUES(?,?,?,?,?,?)").run(snapshotId, run.id, v.versionId, v.profileId, JSON.stringify(manifest), now);
}
export function snapshot(db: Database.Database, claim: Claim) {
  liveContext(db, claim);
  const row = db.prepare("SELECT id,character_version_id AS versionId,provider_profile_id AS profileId,manifest_json AS manifest FROM context_snapshots WHERE run_id=?").get(claim.id) as { id: string; versionId: string; profileId: string; manifest: string } | undefined;
  ensure(row, "SERVICE_NOT_READY");
  const manifest = JSON.parse(row.manifest) as Record<string, unknown>;
  if (manifest.boundary !== boundary(claim) || typeof manifest.branchId !== "string" || typeof manifest.characterId !== "string" || !Array.isArray(manifest.memories) || !Array.isArray(manifest.documents)) throw new RunFailure("CONTEXT_INVALID");
  return { ...row, manifest };
}
export function loadPinned(db: Database.Database, claim: Claim): Pinned {
  const snap = snapshot(db, claim), m = snap.manifest;
  if (m.memoryIndexRequired) throw new RunFailure("MEMORY_INDEX_REQUIRED");
  const row = db.prepare("SELECT v.config_json AS config,p.provider,p.model,p.endpoint,p.options_json AS options,p.compatibility_status AS status FROM character_versions v JOIN characters c ON c.id=v.character_id JOIN provider_profiles p ON p.id=v.provider_profile_id WHERE v.id=? AND v.character_id=? AND p.id=? AND p.owner_id=? AND c.owner_id=?").get(snap.versionId, m.characterId, snap.profileId, claim.ownerId, claim.ownerId) as Omit<VersionRow, "characterId" | "versionId" | "profileId" | "profileOwner"> | undefined;
  if (!row || hash(row.config) !== m.configHash || hash(JSON.stringify([row.provider, row.model, row.endpoint, row.options, row.status])) !== m.profileHash) throw new RunFailure("CONTEXT_INVALID");
  const docs = db.prepare("SELECT logical_name AS name,content AS bytes,sha256 FROM character_documents WHERE version_id=? ORDER BY logical_name").all(snap.versionId) as Pinned["documents"];
  if (JSON.stringify(docs.map(({ name, sha256 }) => ({ name, sha256 }))) !== JSON.stringify(m.documents)) throw new RunFailure("CONTEXT_INVALID");
  const memories = (m.memories as unknown[]).map(ref => {
    if (!object(ref) || typeof ref.id !== "string") throw new RunFailure("CONTEXT_INVALID");
    const v = db.prepare("SELECT id,character_id AS characterId,logical_key AS key,version,parent_id AS parentId,content,provenance_json AS provenance,source_tool_call_id AS sourceToolCallId FROM memory_versions WHERE id=? AND character_id=? AND logical_key=?").get(ref.id, m.characterId, ref.key) as MemoryVersion | undefined;
    if (!v || hash(v.content) !== ref.sha256) throw new RunFailure("CONTEXT_INVALID"); return { ...v, provenance: JSON.parse(v.provenance as string), ...confirmedFlag(db,v.id,String(m.characterId)) };
  });
  return { origin: m.origin === "heartbeat" ? "heartbeat" : "user", allowWebSearch: m.allowWebSearch === true, allowMemoryWrite: m.allowMemoryWrite === true, ...(m.task ? { task: m.task as NonNullable<Pinned["task"]> } : {}), snapshotId: snap.id, characterId: String(m.characterId), versionId: snap.versionId, profile: { id: snap.profileId, provider: row.provider, model: row.model, endpoint: row.endpoint, options: JSON.parse(row.options), status: row.status },
    config: JSON.parse(row.config), documents: docs, memories, entries: chain(db, claim.conversationId, boundary(claim)), boundary: boundary(claim), branchId: String(m.branchId), receivedAt: Number(m.receivedAt) };
}

function confirmedFlag(db: Database.Database, id: string, character: string): {confirmed?: boolean} {
 if (!hasTable(db,"memory_proposals")) return {};
 const row=db.prepare("SELECT 1 FROM memory_proposals WHERE confirmed_memory_id=? AND character_id=? AND status='confirmed'").get(id,character);
 return row ? {confirmed:true} : {};
}
