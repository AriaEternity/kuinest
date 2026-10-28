import Database from "better-sqlite3";
import { join } from "node:path";
import { checkedFile, checkSidecars } from "../../../apps/backend/dist/storage/paths.js";
import { openDatabase } from "../../../apps/backend/dist/storage/database.js";
import { requireNoActiveLease } from "../../../apps/backend/dist/storage/lease.js";
import { appliedMigrations, loadMigrations, verifyIntegrity, applyMigrationsInTransaction } from "../../../apps/backend/dist/storage/migrations.js";
import { check, uid, newDirectory } from "./safe.js";
import { analyze, summary } from "./validate.js";
import { loadBundle, copyBundle } from "./capture.js";
import { source, stateHash, checkDelta, verifyLedger } from "./ledger.js";
import { projectCharacter, projectConversations } from "./project.js";
import type { Analysis } from "./types.js";
export function applyTransaction(db: Database.Database, a: Analysis, owner: string) {
  check(db.inTransaction, "TRANSACTION_REQUIRED");
  requireNoActiveLease(db, Date.now()); verifyIntegrity(db, loadMigrations());
  check(a.gaps.length === 0, "COMPATIBILITY_GAPS");
  const m = a.bundle.manifest, old = source(db);
  check(db.prepare("SELECT 1 FROM owners WHERE id=?").get(owner), "OWNER_MISSING");
  check(!db.prepare("SELECT 1 FROM runs WHERE status IN ('accepted','running')").get() && !db.prepare("SELECT 1 FROM scheduled_tasks WHERE enabled=1").get(), "TARGET_BUSY");
  if (old) {
    check(old.id === m.sourceId && old.owner_id === owner && stateHash(db) === old.state_sha256, "TARGET_DIVERGED");
    if (old.batch_id === m.batchId) { check(old.manifest_sha256 === a.bundle.manifestHash, "BATCH_CONFLICT"); return { ...summary(a), applied:true, replay:true }; }
    checkDelta(db, a, old, owner);
  } else {
    check(m.revision === 1 && m.parent === null, "BATCH_CHAIN");
    for (const table of ["characters","conversations","provider_profiles","import_batches"])
      check(!db.prepare("SELECT 1 FROM " + table + " LIMIT 1").get(), "TARGET_NOT_EMPTY");
  }
  check(!db.prepare("SELECT 1 FROM import_batches WHERE id=?").get(m.batchId), "BATCH_CONFLICT");
  const character = old?.character_id ?? uid(m.sourceId,"character");
  db.prepare("INSERT INTO import_batches VALUES (?,?,?,'applied',?,?)").run(m.batchId,owner,a.bundle.manifestHash,JSON.stringify({manifestBase64:a.bundle.manifestBytes.toString("base64"),continuity:"pending"}),m.capturedAt);
  if (!old) {
    db.prepare("INSERT INTO characters VALUES (?,?,?,NULL,?)").run(character,owner,"待验收导入角色",m.capturedAt);
    db.prepare("INSERT INTO import_sources VALUES (?,?,?,?,?,?,?,?)").run(m.sourceId,owner,character,m.agentId,m.revision,a.bundle.manifestHash,m.batchId,"pending");
  }
  for (const f of m.files) db.prepare("INSERT OR IGNORE INTO import_objects VALUES (?,?,?,?)").run(m.sourceId,f.path,f.sha256,a.bundle.files.get(f.path)!);
  projectCharacter(db,a,owner,character); projectConversations(db,a,owner,character);
  db.prepare("UPDATE import_sources SET revision=?,manifest_sha256=?,batch_id=? WHERE id=?").run(m.revision,a.bundle.manifestHash,m.batchId,m.sourceId);
  verifyIntegrity(db,loadMigrations());
  db.prepare("UPDATE import_sources SET state_sha256=? WHERE id=?").run(stateHash(db),m.sourceId);
  verifyLedger(db);
  return { ...summary(a), applied:true, replay:false };
}
export function apply(batch: string, target: string, owner: string) {
  const a = analyze(loadBundle(batch));
  // 在打开目标前完成输入校验，拒绝会改变目标的错误输入。
  check(a.gaps.length === 0, "COMPATIBILITY_GAPS");
  const db = openDatabase(target,true);
  try { return db.transaction(()=>applyTransaction(db,a,owner)).immediate(); } finally { db.close(); }
}
export function verify(target: string) {
  const file=checkedFile(join(target,"kuinest.sqlite"));checkSidecars(file);
  // 封存核验不升级或写入旧库；写入apply仍严格要求最新schema。
  const db = new Database(file,{readonly:true,fileMustExist:true});
  try { return db.transaction(()=>{
    requireNoActiveLease(db,Date.now()); verifyIntegrity(db,appliedMigrations(db));
    return {ok:true,...verifyLedger(db),activated:false,continuity:"user_acceptance_pending"};
  })(); } finally { db.close(); }
}
export function dryRun(input: string, output: string) {
  const a = analyze(loadBundle(input)); copyBundle(a.bundle,output);
  if (a.gaps.length) return {...summary(a), applied:false};
  // 增量预演需要前序候选库；此模式只为首批建立新的预演库。
  if (a.bundle.manifest.revision !== 1) return {...summary(a), applied:false, needsPreviousCandidate:true};
  const target = output + "/candidate"; newDirectory(target);
  const db = openDatabase(target);
  try {
    db.transaction(()=>{
      applyMigrationsInTransaction(db,loadMigrations(),Date.now());
      db.prepare("INSERT INTO owners VALUES ('migration-preview','migration-preview','!',?)").run(Date.now());
    }).immediate();
    return db.transaction(()=>applyTransaction(db,a,"migration-preview")).immediate();
  } finally { db.close(); }
}
