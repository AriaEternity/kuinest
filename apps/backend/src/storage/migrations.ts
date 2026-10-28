import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { requireCondition } from "./errors.js";

export interface Migration { readonly version: number; readonly sql: string; readonly checksum: string; }
export function migration(version: number, sql: string): Migration {
  requireCondition(Number.isSafeInteger(version) && version > 0 && Buffer.byteLength(sql) < 2 * 1024 * 1024, "MIGRATION_INVALID");
  requireCondition(!/^\s*(?:BEGIN|COMMIT|ROLLBACK|END)\s*;/mi.test(sql), "MIGRATION_TRANSACTION_WRAPPER");
  return Object.freeze({ version, sql, checksum: createHash("sha256").update(sql, "utf8").digest("hex") });
}
export function loadMigrations(): readonly Migration[] {
  // 文件清单由源码维护，不遍历外部目录，也不执行外部提供的 SQL。
  const file = fileURLToPath(new URL("../../schema/001-initial.sql", import.meta.url));
  const ledger = fileURLToPath(new URL("../../schema/002-import-ledger.sql", import.meta.url));
  const images = fileURLToPath(new URL("../../schema/003-image-assets.sql", import.meta.url));
  const review = fileURLToPath(new URL("../../schema/004-memory-review.sql", import.meta.url));
  const kuisense = fileURLToPath(new URL("../../schema/005-kuisense-latest-context.sql", import.meta.url));
  const conversations = fileURLToPath(new URL("../../schema/006-conversation-management.sql", import.meta.url));
  return [migration(1, readFileSync(file, "utf8")), migration(2, readFileSync(ledger, "utf8")), migration(3, readFileSync(images, "utf8")), migration(4, readFileSync(review, "utf8")), migration(5, readFileSync(kuisense, "utf8")), migration(6, readFileSync(conversations, "utf8"))];
}
export function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function validateManifest(manifest: readonly Migration[]): void {
  requireCondition(manifest.length > 0, "MIGRATION_INVALID");
  manifest.forEach((item, index) => requireCondition(item.version === index + 1 && migration(item.version, item.sql).checksum === item.checksum, "MIGRATION_INVALID"));
}
export function checkMigrationHistory(db: Database.Database, manifest: readonly Migration[], complete: boolean): number {
  validateManifest(manifest);
  requireCondition(hasTable(db, "schema_migrations"), "SCHEMA_UNRECOGNIZED");
  const rows = db.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all() as { version: number; checksum: string }[];
  rows.forEach((row, i) => requireCondition(row.version === i + 1 && manifest[i]?.version === row.version && manifest[i]?.checksum === row.checksum, "MIGRATION_MISMATCH"));
  if (complete) requireCondition(rows.length === manifest.length, "SCHEMA_INCOMPLETE");
  return rows.length;
}
export function applyMigrationsInTransaction(db: Database.Database, manifest: readonly Migration[], now: number): void {
  requireCondition(db.inTransaction, "TRANSACTION_REQUIRED");
  validateManifest(manifest);
  if (!hasTable(db, "schema_migrations")) {
    const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { n: number };
    requireCondition(row.n === 0, "SCHEMA_UNRECOGNIZED");
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL)");
  }
  const previous = checkMigrationHistory(db, manifest, false);
  for (const item of manifest.slice(previous)) {
    db.exec(item.sql);
    db.prepare("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)").run(item.version, item.checksum, now);
  }
  checkMigrationHistory(db, manifest, true);
}
export function verifyIntegrity(db: Database.Database, manifest: readonly Migration[]): void {
  checkMigrationHistory(db, manifest, true);
  const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
  requireCondition(integrity.length === 1 && integrity[0]?.integrity_check === "ok", "INTEGRITY_FAILED");
  requireCondition((db.pragma("foreign_key_check") as unknown[]).length === 0, "FOREIGN_KEY_FAILED");
}

// 只读封存核验可使用已登记前缀；运行库仍必须升级并严格验证完整清单。
export function appliedMigrations(db: Database.Database): readonly Migration[] {
  const all = loadMigrations(), count = checkMigrationHistory(db, all, false);
  requireCondition(count >= 3, "SCHEMA_INCOMPLETE");
  return all.slice(0,count);
}
