import type Database from "better-sqlite3";
import type { Manifest } from "./types.js";
import { scope } from "./manifest.js";
import { check, hash, json, uid } from "./safe.js";

export function checkFreshDelta(previous: Manifest, next: Manifest): void {
  check(JSON.stringify(previous.conversations) === JSON.stringify(next.conversations), "FRESH_START_MAPPING_CHANGED");
  // 已确认基线及增补固定到哈希；新编辑须走新的显式审阅流程，不能被旧站增量覆盖。
  if (previous.reviewedAdditions) check(JSON.stringify(previous.reviewedAdditions) === JSON.stringify(next.reviewedAdditions), "REVIEW_BASELINE_CHANGED");
  if (next.reviewedAdditions) for (const file of previous.files.filter(f => f.kind === "document" || f.kind === "memory" || f.kind === "addition"))
    check(next.files.some(f => f.path === file.path && f.kind === file.kind && f.sha256 === file.sha256), "REVIEW_BASELINE_CHANGED");
  const removed = new Set(next.removedMemories ?? []);
  for (const path of removed) check(previous.files.some(f => f.path === path && f.kind === "memory"), "MEMORY_REMOVAL_INVALID");
  for (const file of previous.files) {
    const current = next.files.find(f => f.path === file.path);
    if (current) { check(current.kind === file.kind, "SOURCE_MISMATCH"); continue; }
    if (file.kind === "memory") check(removed.has(file.path), "MEMORY_REMOVAL_REQUIRED");
    else check(file.kind !== "document", "SOURCE_FILE_REMOVED");
  }
  // 会话、索引与任务只追加原档版本；源端缩短、改写或轮换不改目标上下文。
  // 未在本批出现的历史原档继续保留，不能据此删除数据库中的旧版本。
}

export function projectFreshConversation(db: Database.Database, m: Manifest, owner: string, character: string): void {
  const conversation = uid(m.sourceId,m.conversations[0]!.key), branch = uid(m.sourceId,"fresh-start-v1","branch");
  const existing = db.prepare("SELECT 1 FROM conversations WHERE id=?").get(conversation);
  if (existing) return;
  db.prepare("INSERT INTO conversations(id,owner_id,character_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(conversation,owner,character,"新会话",m.capturedAt,m.capturedAt);
  db.prepare("INSERT INTO branches(id,conversation_id,reason,created_at) VALUES (?,?,?,?)")
    .run(branch,conversation,"fresh-start-v1",m.capturedAt);
  db.prepare("UPDATE conversations SET active_branch_id=? WHERE id=?").run(branch,conversation);
}

export function verifyFreshCandidate(db: Database.Database, m: Manifest, character: string): number {
  // 原档既不投影为消息，也不进入记忆检索、工具链或调度队列。
  for (const table of ["context_entries","messages","import_record_map","image_assets","message_images","runs","run_events","context_snapshots","provider_calls","tool_calls","scheduled_tasks","task_occurrences"])
    check(!db.prepare("SELECT 1 FROM " + table + " LIMIT 1").get(), "FRESH_START_NOT_EMPTY");
  const conversation = uid(m.sourceId,m.conversations[0]!.key), branch = uid(m.sourceId,"fresh-start-v1","branch");
  const conversations = db.prepare("SELECT id,character_id,active_branch_id,last_context_user_at,next_public_seq,change_revision FROM conversations").all() as {id:string;character_id:string;active_branch_id:string;last_context_user_at:number|null;next_public_seq:number;change_revision:number}[];
  check(conversations.length === 1 && conversations[0]!.id === conversation && conversations[0]!.character_id === character
    && conversations[0]!.active_branch_id === branch && conversations[0]!.last_context_user_at === null
    && conversations[0]!.next_public_seq === 1 && conversations[0]!.change_revision === 0, "FRESH_START_NOT_EMPTY");
  const branches = db.prepare("SELECT id,conversation_id,parent_branch_id,head_entry_id,reason FROM branches").all() as {id:string;conversation_id:string;parent_branch_id:string|null;head_entry_id:string|null;reason:string}[];
  check(branches.length === 1 && branches[0]!.id === branch && branches[0]!.conversation_id === conversation
    && branches[0]!.parent_branch_id === null && branches[0]!.head_entry_id === null && branches[0]!.reason === "fresh-start-v1", "FRESH_START_NOT_EMPTY");
  const heads = db.prepare("SELECT h.logical_key,v.content FROM memory_heads h JOIN memory_versions v ON v.id=h.version_id WHERE h.character_id=?").all(character) as {logical_key:string;content:string}[];
  const memories = m.files.filter(f => f.kind === "memory" || f.path === "workspace/MEMORY.md");
  check(heads.length === memories.length && memories.every(f => {
    const head = heads.find(h => h.logical_key === f.path.slice(10));
    return head !== undefined && hash(head.content) === f.sha256;
  }), "MEMORY_HEAD_COVERAGE");
  // 核对历次清单覆盖的全部原档版本，不能只验证最新清单而遗漏已退役文件。
  const versions = new Set<string>();
  const batches = db.prepare("SELECT manifest_sha256,metadata_json FROM import_batches").all() as {manifest_sha256:string;metadata_json:string}[];
  for (const batch of batches) {
    const metadata = JSON.parse(batch.metadata_json) as {manifestBase64:string};
    const bytes = Buffer.from(metadata.manifestBase64,"base64");
    check(hash(bytes) === batch.manifest_sha256, "LEDGER_INVALID");
    const prior = scope(json(bytes),true) as Manifest;
    check(prior.sourceId === m.sourceId && prior.migrationMode === "fresh-start-v1", "LEDGER_INVALID");
    for (const file of prior.files) {
      const key = JSON.stringify([file.path,file.sha256]);
      if (versions.has(key)) continue;
      const row = db.prepare("SELECT content FROM import_objects WHERE source_id=? AND path=? AND sha256=?").get(m.sourceId,file.path,file.sha256) as {content:Buffer} | undefined;
      check(row && row.content.length === file.bytes && hash(row.content) === file.sha256, "RAW_ARCHIVE_INVALID");
      versions.add(key);
    }
  }
  const count = db.prepare("SELECT count(*) AS n FROM import_objects").get() as {n:number};
  check(count.n === versions.size, "RAW_ARCHIVE_INVALID");
  return versions.size;
}
