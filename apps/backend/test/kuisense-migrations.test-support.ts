import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { releaseFixture } from "./release-fixtures.js";
import { projectRoot } from "../dist/server.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { restoreDatabase } from "../dist/storage/backup.js";
import { loadMigrations, migration } from "../dist/storage/migrations.js";
import { RuntimeBackups, restoreRuntimeBackup, backupFileHash } from "../dist/runtime/backups.js";
import { prepareRuntime, runtimeFileHash } from "../../../tools/import-openclaw/dist/runtime-prepare.js";

const inspect = <T>(file: string, fn: (db: Database.Database) => T): T => {
  const db = new Database(file, { readonly: true }); try { return fn(db); } finally { db.close(); }
};
const schema = (file: string) => inspect(file, db => db.prepare("SELECT version FROM schema_migrations ORDER BY version").all());
const contents = (file: string) => inspect(file, db => Object.fromEntries(["character_documents", "memory_heads", "memory_versions", "messages"].map(name => [name, db.prepare("SELECT * FROM " + name + " ORDER BY rowid").all()])));
async function oldFixture(inactive = false) {
  const f = await releaseFixture(!inactive), file = join(f.root, "kuinest.sqlite");
  const db = new Database(file);
  try {
    // 仅将本测试新建的合成夹具还原为schema4，不是生产回退流程。
    db.exec("DROP INDEX conversations_visible_page; ALTER TABLE conversations DROP COLUMN deleted_at; DROP TABLE kuisense_latest_context; DELETE FROM schema_migrations WHERE version>=5;");
    if (inactive) db.exec("UPDATE characters SET active_version_id=NULL;");
    db.pragma("wal_checkpoint(TRUNCATE)");
    // 封存夹具不携带WAL旁文件，避免只读检查创建空旁文件影响准备关口。
    db.pragma("journal_mode = DELETE");
  } finally { db.close(); }
  return { ...f, file };
}
const output = () => join(projectRoot, ".cache/stage10-tests", "kuisense-restore-" + randomUUID());

test("KS-M01：旧schema4默认恢复仅升级副本，显式旧前缀恢复保留版本，原档与资料不变", async () => {
  const f = await oldFixture(), before = runtimeFileHash(f.file), data = contents(f.file);
  const restored = output(), rollback = output();
  await restoreDatabase(f.file, restored, Date.now());
  await restoreDatabase(f.file, rollback, Date.now(), loadMigrations().slice(0, 4));
  assert.equal(schema(join(restored, "kuinest.sqlite")).length, loadMigrations().length);
  assert.equal(schema(join(rollback, "kuinest.sqlite")).length, 4);
  assert.deepEqual(contents(join(restored, "kuinest.sqlite")), data);
  assert.deepEqual(contents(join(rollback, "kuinest.sqlite")), data);
  assert.equal(runtimeFileHash(f.file), before);
});

test("KS-M02：schema4运行准备保留两份旧格式回退，仅data升级当前版本且绑定资料一致", async () => {
  const f = await oldFixture(true), before = runtimeFileHash(f.file), data = contents(f.file), target = output();
  const result = await prepareRuntime(f.file, before, f.version, target, "synthetic");
  assert.equal(result.rollbackVerified, true); assert.equal(result.activated, false); assert.equal(result.modelCalls, 0);
  for (const [name, count] of [["rollback", 4], ["restore-rehearsal", 4], ["data", loadMigrations().length]] as const) {
    const file = join(target, name, "kuinest.sqlite");
    assert.equal(schema(file).length, count); assert.deepEqual(contents(file), data);
  }
  assert.equal(runtimeFileHash(f.file), before);
});

test("KS-M03：旧库错误校验和、缺号或未知迁移在创建恢复/准备输出前拒绝", async () => {
  for (const sql of ["UPDATE schema_migrations SET checksum='bad' WHERE version=4", "DELETE FROM schema_migrations WHERE version=2", "INSERT INTO schema_migrations VALUES(99,'unknown',0)"]) {
    const f = await oldFixture(true), db = new Database(f.file);
    try { db.exec(sql); } finally { db.close(); }
    const before = runtimeFileHash(f.file), restored = output(), prepared = output();
    await assert.rejects(() => restoreDatabase(f.file, restored, Date.now()), { code: "MIGRATION_MISMATCH" });
    await assert.rejects(() => prepareRuntime(f.file, before, f.version, prepared, "synthetic"), { code: "MIGRATION_MISMATCH" });
    assert.equal(existsSync(restored), false); assert.equal(existsSync(prepared), false); assert.equal(runtimeFileHash(f.file), before);
  }
});

test("KS-M04：副本升级失败时迁移事务回滚，旧源不变且不报告成功", async () => {
  const f = await oldFixture(), before = runtimeFileHash(f.file), target = output();
  const invalid = [...loadMigrations(), migration(loadMigrations().length + 1, "CREATE TABLE upgrade_probe(id INTEGER); INSERT INTO missing_table VALUES(1);")];
  await assert.rejects(() => restoreDatabase(f.file, target, Date.now(), invalid));
  const file = join(target, "kuinest.sqlite"); assert.equal(schema(file).length, 4);
  assert.equal(inspect(file, db => db.prepare("SELECT name FROM sqlite_master WHERE name IN ('upgrade_probe','kuisense_latest_context')").all()).length, 0);
  assert.equal(runtimeFileHash(f.file), before);
});

test("KS-M05：原格式受控备份可恢复到当前schema，原备份哈希不变且绑定通过", async () => {
  const f = await oldFixture(), store = new SqliteStorage({ dataRoot: f.root, instanceId: randomUUID(), clock: { now: Date.now }, migrations: loadMigrations().slice(0, 4) });
  const manager = new RuntimeBackups(store, f.root, f.binding);
  try {
    const backup = await manager.create(), file = join(f.root, "managed-backups", backup.id + ".sqlite"), before = backupFileHash(file);
    const restored = await restoreRuntimeBackup(f.root, backup.id);
    assert.equal(restored.coverageVerified, true); assert.equal(restored.started, false);
    assert.equal(schema(join(f.root, "restores", restored.restoreId, "kuinest.sqlite")).length, loadMigrations().length);
    assert.equal(backupFileHash(file), before);
  } finally { await manager.close(); await store.close(); }
});

test("KS-M06：已上传设备数据的候选不得冒充全新运行源；备份恢复保留设备数据", async () => {
  const f = await releaseFixture(false), file = join(f.root, "kuinest.sqlite"), db = new Database(file);
  try { db.exec("UPDATE characters SET active_version_id=NULL;"); } finally { db.close(); }
  const store = new SqliteStorage({ dataRoot: f.root, instanceId: randomUUID(), clock: { now: Date.now } });
  const payloadJson = JSON.stringify({ schema_version: 1, recent_summary: "纯合成设备上下文" });
  store.kuisenseContextAccess().replace({ schemaVersion: 1, receivedAt: Date.now(), payloadJson }); await store.close();
  const before = runtimeFileHash(file), target = output();
  await assert.rejects(() => prepareRuntime(file, before, f.version, target, "synthetic"), { code: "RUNTIME_SOURCE_USED" });
  assert.equal(existsSync(target), false);
  const restored = output(); await restoreDatabase(file, restored, Date.now());
  assert.equal(inspect(join(restored, "kuinest.sqlite"), d => (d.prepare("SELECT payload_json AS value FROM kuisense_latest_context").get() as { value: string }).value), payloadJson);
  assert.equal(runtimeFileHash(file), before);
});
