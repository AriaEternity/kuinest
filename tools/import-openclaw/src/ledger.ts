import { hasTable } from "../../../apps/backend/dist/storage/migrations.js";
import { checkFreshDelta, verifyFreshCandidate } from "./fresh-start.js";
import { replayProfileHash } from "./replay.js";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Analysis, Manifest } from "./types.js";
import { check, hash, json, uid } from "./safe.js";
import { parse } from "./parse.js";
export type Source = { id: string; owner_id: string; character_id: string; agent_id: string; revision: number; manifest_sha256: string; batch_id: string; state_sha256: string };
const tables = ["owners","auth_sessions","auth_throttles","provider_profiles","characters","character_versions","character_documents","conversations","branches","import_batches","context_entries","messages","runs","run_events","context_snapshots","provider_calls","tool_calls","memory_versions","memory_heads","scheduled_tasks","task_occurrences","audit_events","import_objects","import_record_map"] as const;
export function stateHash(db: Database.Database): string {
  const digest = createHash("sha256");
  for (const table of tables) {
    digest.update(table);
    for (const row of db.prepare("SELECT * FROM " + table + " ORDER BY rowid").iterate() as Iterable<Record<string, unknown>>)
      // 兼容旧封存摘要：新增NULL删除列没有业务变化；实际删除标记仍纳入摘要。
      digest.update(JSON.stringify(Object.entries(row).filter(([k,v]) => table !== "conversations" || k !== "deleted_at" || v !== null).map(([k,v]) => [k, Buffer.isBuffer(v) ? { sha256: hash(v), bytes: v.length } : v])));
  }
  // 空资产表不改变旧候选指纹；首次加入图片后纳入字节哈希及消息顺序，禁止绕过单向增量校验。
  for (const table of ["image_assets", "message_images", "memory_proposals", "memory_proposal_revisions"]) {
    if (!hasTable(db,table)) continue;
    let tagged = false;
    for (const row of db.prepare("SELECT * FROM " + table + " ORDER BY rowid").iterate() as Iterable<Record<string, unknown>>) {
      if (!tagged) { digest.update("image-extension-v1:" + table); tagged = true; }
      digest.update(JSON.stringify(Object.entries(row).map(([k,v]) => [k, Buffer.isBuffer(v) ? { sha256: hash(v), bytes: v.length } : v])));
    }
  }
  for (const row of db.prepare("SELECT id,owner_id,character_id,agent_id,revision,manifest_sha256,batch_id FROM import_sources ORDER BY id").iterate())
    digest.update(JSON.stringify(row));
  return digest.digest("hex");
}
export function source(db: Database.Database): Source | undefined {
  const rows = db.prepare("SELECT * FROM import_sources").all() as Source[];
  check(rows.length <= 1, "TARGET_SCOPE"); return rows[0];
}
export function previousManifest(db: Database.Database, s: Source): Manifest {
  const row = db.prepare("SELECT metadata_json FROM import_batches WHERE id=?").get(s.batch_id) as { metadata_json: string } | undefined;
  check(row, "LEDGER_INVALID");
  const metadata = JSON.parse(row.metadata_json) as { manifestBase64: string };
  const bytes = Buffer.from(metadata.manifestBase64, "base64"); check(hash(bytes) === s.manifest_sha256, "LEDGER_INVALID");
  return json(bytes) as Manifest;
}
export function checkDelta(db: Database.Database, a: Analysis, old: Source, owner: string): void {
  const m = a.bundle.manifest;
  check(old.id === m.sourceId && old.owner_id === owner && old.agent_id === m.agentId, "SOURCE_MISMATCH");
  check(stateHash(db) === old.state_sha256, "TARGET_DIVERGED");
  check(m.revision === old.revision + 1 && m.parent === old.manifest_sha256, "BATCH_CHAIN");
  const previous = previousManifest(db, old);
  check(previous.mode === m.mode, "SOURCE_MISMATCH");
  check(previous.migrationMode === m.migrationMode, "MIGRATION_MODE_CHANGED");
  if (m.migrationMode === "fresh-start-v1") { checkFreshDelta(previous,m); return; }
  if (previous.reasoningReplay || m.reasoningReplay) {
    const identity = (v: Manifest) => v.reasoningReplay ? [v.reasoningReplay.format, v.reasoningReplay.target.api,
      v.reasoningReplay.target.provider, v.reasoningReplay.target.model, v.reasoningReplay.profileSha256, v.reasoningReplay.deferHistoricalReplay === true, v.requireReasoning] : null;
    check(JSON.stringify(identity(previous)) === JSON.stringify(identity(m))
      && replayProfileHash(previous.profile) === replayProfileHash(m.profile), "REPLAY_POLICY_CHANGED");
  }
  for (const c of previous.conversations) {
    const next = m.conversations.find(n => n.key === c.key);
    check(next && c.history.every(h => next.history.some(n => n.sessionId === h.sessionId)), "SESSION_REMOVED");
  }
  for (const f of previous.files) {
    const next = m.files.find(n => n.path === f.path);
    check(next && next.kind === f.kind, "SOURCE_FILE_REMOVED");
    if (f.kind !== "session") continue;
    const row = db.prepare("SELECT content FROM import_objects WHERE source_id=? AND path=? AND sha256=?").get(old.id, f.path, f.sha256) as { content: Buffer } | undefined;
    check(row && hash(row.content) === f.sha256, "RAW_ARCHIVE_INVALID");
    const bytes = a.bundle.files.get(f.path)!;
    check(bytes.length >= row.content.length && bytes.subarray(0, row.content.length).equals(row.content), "SOURCE_REWRITTEN");
  }
}
export function verifyLedger(db: Database.Database) {
  const s = source(db); check(s && stateHash(db) === s.state_sha256, "TARGET_DIVERGED");
  const m = previousManifest(db, s);
  if (m.migrationMode === "fresh-start-v1") {
    const archivedObjects = verifyFreshCandidate(db,m,s.character_id);
    return { files:m.files.length, records:0, revision:s.revision, migrationMode:"fresh-start-v1", archivedObjects, historyRestored:false };
  }
  let records = 0;
  for (const f of m.files) {
    const row = db.prepare("SELECT content FROM import_objects WHERE source_id=? AND path=? AND sha256=?").get(s.id, f.path, f.sha256) as { content: Buffer } | undefined;
    check(row && hash(row.content) === f.sha256 && row.content.length === f.bytes, "RAW_ARCHIVE_INVALID");
    if (f.kind === "session") {
      const session = parse(row.content); records += session.entries.length;
      for (const e of session.entries) {
        const mapping = db.prepare("SELECT raw_sha256,target_id FROM import_record_map WHERE source_id=? AND session_id=? AND entry_id=?").get(s.id,session.id,e.id) as {raw_sha256:string;target_id:string} | undefined;
        check(mapping && mapping.raw_sha256 === session.rawHashes.get(e.id) && mapping.target_id === uid(s.id,s.agent_id,session.id,e.id), "RECORD_COVERAGE");
      }
    }
  }
  const n = db.prepare("SELECT count(*) AS n FROM import_record_map WHERE source_id=?").get(s.id) as { n: number };
  check(n.n === records, "RECORD_COVERAGE");
  return { files: m.files.length, records: n.n, revision: s.revision };
}
