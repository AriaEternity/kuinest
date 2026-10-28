import Database from "better-sqlite3";
import { join } from "node:path";
import { checkedFile, checkSidecars, reserveNewDirectory, reserveNewFile } from "./paths.js";
import { openDatabase } from "./database.js";
import { requireCondition } from "./errors.js";
import { loadMigrations, checkMigrationHistory, applyMigrationsInTransaction, verifyIntegrity, type Migration } from "./migrations.js";

// 使用 SQLite 在线备份接口，已提交但仍在 WAL 中的数据也纳入快照。
export async function backupDatabase(db: Database.Database, destination: string, guard: () => void, manifest: readonly Migration[]): Promise<void> {
  guard();
  const target = reserveNewFile(destination);
  await db.backup(target, { progress: () => { guard(); return 128; } });
  guard();
  const copy = new Database(checkedFile(target), { readonly: true, fileMustExist: true });
  try { verifyIntegrity(copy, manifest); } finally { copy.close(); }
}

// 只产生候选恢复目录，不切换服务。调用者必须在停服后人工选择新目录。
export async function restoreDatabase(source: string, destinationRoot: string, now: number, manifest = loadMigrations()): Promise<void> {
  requireCondition(Number.isSafeInteger(now) && now >= 0, "TIME_INVALID");
  const file = checkedFile(source); checkSidecars(file);
  const original = new Database(file, { readonly: true, fileMustExist: true });
  try {
    // 旧源只接受目标清单的已登记连续前缀，未知版本或校验和变化仍拒绝。
    const count = checkMigrationHistory(original, manifest, false);
    requireCondition(count > 0, "SCHEMA_INCOMPLETE");
    const sourceManifest = manifest.slice(0, count);
    verifyIntegrity(original, sourceManifest);
    const target = reserveNewDirectory(destinationRoot);
    await original.backup(reserveNewFile(join(target, "kuinest.sqlite")));
    const restored = openDatabase(target, true);
    try {
      verifyIntegrity(restored, sourceManifest);
      restored.transaction(() => {
        // 只升级新副本；显式传入旧前缀时用于保持原版本的回退演练。
        applyMigrationsInTransaction(restored, manifest, now);
        // 恢复不复活旧登录、实例租约或定时任务；保留 fence 和业务记录。
        restored.prepare("UPDATE runtime_leases SET expires_at=0").run();
        restored.prepare("UPDATE auth_sessions SET revoked_at=? WHERE revoked_at IS NULL").run(now);
        restored.prepare("UPDATE scheduled_tasks SET enabled=0").run();
      }).immediate();
      verifyIntegrity(restored, manifest);
    } finally { restored.close(); }
  } finally { original.close(); }
}
