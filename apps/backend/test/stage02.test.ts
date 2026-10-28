import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { createServer } from "node:net";
import Database from "better-sqlite3";
import { SqliteStorage } from "../dist/storage/storage.js";
import { openDatabase, verifyPragmas } from "../dist/storage/database.js";
import { loadMigrations, migration, verifyIntegrity } from "../dist/storage/migrations.js";
import { checkedDirectory, checkedFile, localPath } from "../dist/storage/paths.js";
import { restoreDatabase } from "../dist/storage/backup.js";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { foundationPorts, projectRoot, startServer } from "../dist/server.js";
import type { ScopedRepositories } from "../dist/storage/repositories/index.js";
import { accepted, count, directory, fixture, inspect, seed } from "./storage-fixtures.js";

const isCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const row = <T>(db: Database.Database, sql: string) => db.prepare(sql).get() as T;

test("D01：真实文件库建立 32 张表并验证全部 PRAGMA，关闭重开不重跑迁移", async t => {
  const { root, storage, clock } = fixture(t);
  seed(storage);
  const history = inspect(root, db => {
    verifyPragmas(db); verifyIntegrity(db, loadMigrations());
    assert.equal(row<{ n: number }>(db, "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").n, 32);
    assert.equal(row<{ n: number }>(db, "SELECT count(*) AS n FROM kuisense_latest_context").n, 0);
    assert.equal(count(db, "schema_migrations"), loadMigrations().length);
    return db.prepare("SELECT * FROM schema_migrations").all();
  });
  assert.equal((await storage.getReadiness()).lease.held, true);
  await storage.close();
  const reopened = new SqliteStorage({ dataRoot: root, instanceId: "reopened", clock });
  t.after(() => reopened.close());
  assert.equal(reopened.readConversation("owner-a", "conversation-a")?.title, "合成标题-a");
  inspect(root, db => {
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations").all(), history);
    assert.equal(row<{ fence: number }>(db, "SELECT fence FROM runtime_leases WHERE name='backend'").fence, 2);
  });
});

test("D01：第二实例不能领取有效租约，也不能先执行新迁移", t => {
  const { root, clock, storage } = fixture(t);
  assert.throws(() => new SqliteStorage({ dataRoot: root, instanceId: "second", clock, migrations: [...loadMigrations(), migration(loadMigrations().length + 1, "CREATE TABLE forbidden_migration(id TEXT);")] }), isCode("LEASE_BUSY"));
  inspect(root, db => {
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='forbidden_migration'").get(), undefined);
    assert.equal(count(db, "schema_migrations"), loadMigrations().length);
  });
  assert.doesNotThrow(() => seed(storage));
});

test("D02：迁移中途失败，DDL、历史和租约领取一起回滚", async t => {
  const { root, storage, clock } = fixture(t);
  await storage.close();
  const before = inspect(root, db => db.prepare("SELECT * FROM runtime_leases").all());
  assert.throws(() => new SqliteStorage({ dataRoot: root, instanceId: "broken", clock, migrations: [...loadMigrations(), migration(loadMigrations().length + 1, "CREATE TABLE rollback_probe(id TEXT); INSERT INTO absent_table VALUES(1);")] }));
  inspect(root, db => {
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='rollback_probe'").get(), undefined);
    assert.equal(count(db, "schema_migrations"), loadMigrations().length);
    assert.deepEqual(db.prepare("SELECT * FROM runtime_leases").all(), before);
  });
  const repaired = new SqliteStorage({ dataRoot: root, instanceId: "repaired", clock });
  t.after(() => repaired.close());
});

test("D02：旧脚本改写、未知历史版本和非连续清单均拒绝", async t => {
  const { root, storage, clock } = fixture(t);
  await storage.close();
  const original = loadMigrations()[0]!;
  assert.throws(() => new SqliteStorage({ dataRoot: root, instanceId: "edited", clock, migrations: [migration(1, original.sql + "\n-- modified")] }), isCode("MIGRATION_MISMATCH"));
  assert.throws(() => new SqliteStorage({ dataRoot: root, instanceId: "gap", clock, migrations: [original, migration(3, "CREATE TABLE future(id TEXT);")] }), isCode("MIGRATION_INVALID"));
  inspect(root, db => db.prepare("INSERT INTO schema_migrations VALUES(99,'synthetic',100000)").run());
  assert.throws(() => new SqliteStorage({ dataRoot: root, instanceId: "future", clock }), isCode("MIGRATION_MISMATCH"));
});

test("D02：不接管来源不明的现存数据库", () => {
  const root = directory();
  const db = openDatabase(root);
  db.exec("CREATE TABLE unrelated(id TEXT)"); db.close();
  assert.throws(() => new SqliteStorage({ dataRoot: root, instanceId: "unknown", clock: { now: () => 100000 } }), isCode("SCHEMA_UNRECOGNIZED"));
  inspect(root, existing => assert.equal(existing.prepare("SELECT 1 FROM sqlite_master WHERE name=\'schema_migrations\'").get(), undefined));
});

test("D03：仓储查询和修改限制 owner；SQL 复合外键阻止跨主人关联", t => {
  const { root, storage } = fixture(t); seed(storage);
  assert.equal(storage.readConversation("owner-b", "conversation-a"), undefined);
  assert.throws(() => storage.write("owner-b", repo => repo.renameConversation("conversation-a", "篡改", 100001)), isCode("NOT_FOUND"));
  assert.throws(() => storage.write("owner-b", repo => repo.createConversation("cross", "character-a", "越权", 100001)), isCode("NOT_FOUND"));
  assert.throws(() => storage.write("missing", () => {}), isCode("NOT_FOUND"));
  inspect(root, db => {
    assert.throws(() => db.prepare("INSERT INTO conversations(id,owner_id,character_id,title,created_at,updated_at) VALUES ('cross','owner-b','character-a','x',1,1)").run(), /FOREIGN KEY/);
    assert.throws(() => db.prepare("INSERT INTO messages(id,conversation_id,seq,role,status,updated_revision,created_at) VALUES ('bad','conversation-a',0,'user','complete',1,1)").run(), /CHECK/);
  });
  assert.equal(storage.readConversation("owner-a", "conversation-a")?.title, "合成标题-a");
});

test("D03：上下文父节点和回复不能越过会话边界", t => {
  const { root, storage } = fixture(t); seed(storage);
  storage.write("owner-a", repo => accepted(repo));
  inspect(root, db => {
    db.exec("INSERT INTO branches(id,conversation_id,reason,created_at) VALUES ('branch-a','conversation-a','synthetic',1),('branch-b','conversation-b','synthetic',1)");
    db.exec("INSERT INTO context_entries(id,conversation_id,branch_id,kind,payload_json,created_at) VALUES ('context-a','conversation-a','branch-a','message','{}',1)");
    assert.throws(() => db.exec("INSERT INTO context_entries(id,conversation_id,branch_id,parent_id,kind,payload_json,created_at) VALUES ('bad','conversation-b','branch-b','context-a','message','{}',1)"), /FOREIGN KEY/);
    assert.throws(() => db.exec("INSERT INTO runs(id,conversation_id,origin,request_key,input_hash,reply_message_id,input_json,status,created_at) VALUES ('bad-run','conversation-b','heartbeat','key','hash','user-a','{}','accepted',1)"), /FOREIGN KEY/);
  });
});

test("D03：幂等键、用户消息归属、全局运行与终态事件受约束", t => {
  const { root, storage } = fixture(t); seed(storage);
  storage.write("owner-a", repo => accepted(repo));
  storage.write("owner-b", repo => accepted(repo, "b"));
  inspect(root, db => {
    db.exec("INSERT INTO messages(id,conversation_id,seq,role,status,updated_revision,created_at) VALUES ('extra-user','conversation-a',3,'user','complete',3,1),('extra-reply','conversation-a',4,'assistant','partial',4,1)");
    const insert = db.prepare("INSERT INTO runs(id,conversation_id,origin,request_key,input_hash,user_message_id,reply_message_id,input_json,status,created_at) VALUES ('duplicate','conversation-a','user',?,'hash',?,'extra-reply','{}','accepted',1)");
    assert.throws(() => insert.run("request-a", "extra-user"), /UNIQUE/);
    assert.throws(() => insert.run("new-key", "user-a"), /UNIQUE/);
    assert.throws(() => db.exec("UPDATE runs SET status='running' WHERE id='run-a'"), /CHECK/);
    db.exec("INSERT INTO branches(id,conversation_id,reason,created_at) VALUES ('ba','conversation-a','synthetic',1),('bb','conversation-b','synthetic',1)");
    db.exec("INSERT INTO context_entries(id,conversation_id,branch_id,kind,payload_json,created_at) VALUES ('ca','conversation-a','ba','message','{}',1),('cb','conversation-b','bb','message','{}',1)");
    db.exec("UPDATE runs SET context_user_entry_id='ca',status='running' WHERE id='run-a'");
    assert.throws(() => db.exec("UPDATE runs SET context_user_entry_id='cb',status='running' WHERE id='run-b'"), /UNIQUE/);
    db.exec("UPDATE runs SET status='completed',finished_at=100001 WHERE id='run-a'");
    assert.throws(() => db.exec("UPDATE runs SET status='running',finished_at=NULL WHERE id='run-a'"), /terminal_run_immutable/);
    db.exec("INSERT INTO run_events VALUES ('run-a',2,'run.completed','{}',100001)");
    assert.throws(() => db.exec("INSERT INTO run_events VALUES ('run-a',3,'run.failed','{}',100002)"), /UNIQUE/);
  });
});

test("D04：接收四类记录发生异常时全部回滚，成功事务一次保存", t => {
  const { root, storage } = fixture(t); seed(storage);
  assert.throws(() => storage.write("owner-a", repo => { accepted(repo); throw new Error("synthetic-failure"); }), /synthetic-failure/);
  inspect(root, db => {
    for (const table of ["messages", "runs", "run_events"] as const) assert.equal(count(db, table), 0);
  });
  storage.write("owner-a", repo => accepted(repo));
  inspect(root, db => {
    assert.equal(count(db, "messages"), 2); assert.equal(count(db, "runs"), 1); assert.equal(count(db, "run_events"), 1);
  });
});

test("D04：仓储不能逃逸事务，异步回调回滚且 await 后不能再写入", async t => {
  const { storage } = fixture(t); seed(storage);
  let captured: ScopedRepositories | undefined, continuation: Promise<void> | undefined;
  storage.write("owner-a", repo => { captured = repo; });
  assert.throws(() => captured!.renameConversation("conversation-a", "逃逸", 100001), isCode("TRANSACTION_CLOSED"));
  assert.throws(() => storage.write("owner-a", repo => {
    continuation = (async () => {
      repo.renameConversation("conversation-a", "await 前", 100001);
      await Promise.resolve();
      repo.renameConversation("conversation-a", "await 后", 100002);
    })();
    return continuation;
  }), isCode("ASYNC_TRANSACTION"));
  await assert.rejects(continuation!, isCode("TRANSACTION_CLOSED"));
  assert.equal(storage.readConversation("owner-a", "conversation-a")?.title, "合成标题-a");
});

test("D05：接管递增 fence，旧实例写入失败且关闭不能释放新实例租约", async t => {
  const { root, clock, storage } = fixture(t); seed(storage);
  clock.value += 30000;
  const successor = new SqliteStorage({ dataRoot: root, instanceId: "successor", clock });
  t.after(() => successor.close());
  assert.throws(() => storage.write("owner-a", repo => repo.renameConversation("conversation-a", "旧结果", clock.value)), isCode("LEASE_LOST"));
  await storage.close();
  assert.equal((await successor.getReadiness()).lease.held, true);
  successor.write("owner-a", repo => repo.renameConversation("conversation-a", "新实例", clock.value));
  assert.equal(successor.readConversation("owner-a", "conversation-a")?.title, "新实例");
  inspect(root, db => assert.equal(row<{ fence: number }>(db, "SELECT fence FROM runtime_leases WHERE name='backend'").fence, 2));
});

test("D05：事务提交前再次检查租约，执行期间到期也整体回滚", t => {
  const { clock, storage, root } = fixture(t); seed(storage);
  assert.throws(() => storage.write("owner-a", repo => {
    repo.renameConversation("conversation-a", "到期结果", clock.value);
    clock.value += 30000;
  }), isCode("LEASE_LOST"));
  inspect(root, db => assert.equal(row<{ title: string }>(db, "SELECT title FROM conversations WHERE id='conversation-a'").title, "合成标题-a"));
});

test("D05：每 5 秒续租；失败仅通知一次并禁止重新写入", async t => {
  const { clock, storage } = fixture(t); seed(storage);
  let tick: (() => void) | undefined, stops = 0, notifications = 0;
  storage.startRenewal(() => { notifications++; }, (callback, milliseconds) => {
    assert.equal(milliseconds, 5000); tick = callback; return () => { stops++; };
  });
  clock.value += 5000; tick!();
  assert.equal((await storage.getReadiness()).lease.expiresAt, 135000);
  clock.value = 135000; tick!();
  await Promise.resolve();
  assert.equal(notifications, 1); assert.ok(stops >= 1);
  tick!(); await Promise.resolve(); assert.equal(notifications, 1);
  assert.equal((await storage.getReadiness()).lease.held, false);
  assert.throws(() => storage.write("owner-a", () => {}), isCode("STORAGE_UNAVAILABLE"));
});

test("D05：真实文件库存储接入健康探针，过期返回 503 且不泄漏状态细节", async t => {
  const { clock, storage } = fixture(t);
  const ports = foundationPorts(), sink = new Writable({ write(_chunk, _encoding, next) { next(); } });
  const app = createApp(loadConfig({ NODE_ENV: "test", APP_MODE: "synthetic" }, projectRoot), { ...ports, clock, storage }, { logStream: sink });
  t.after(() => app.close());
  const ready = await app.inject("/health/ready");
  assert.equal(ready.statusCode, 200); assert.deepEqual(ready.json(), { status: "ok" });
  clock.value += 30000;
  const unavailable = await app.inject("/health/ready");
  assert.equal(unavailable.statusCode, 503); assert.deepEqual(unavailable.json(), { status: "unavailable" });
});

test("D06：在线备份包含 WAL 和原始字节，恢复保持业务事实且撤销旧运行权限", async t => {
  const { root, storage, clock } = fixture(t); seed(storage);
  storage.write("owner-a", repo => accepted(repo));
  const bytes = Buffer.from([0, 255, 10, 13, 65, 128]);
  inspect(root, db => {
    db.exec("INSERT INTO provider_profiles(id,owner_id,provider,model,options_json,compatibility_status,created_at) VALUES ('p','owner-a','mock','synthetic','{}','synthetic',1)");
    db.exec("INSERT INTO character_versions(id,character_id,provider_profile_id,config_json,created_at) VALUES ('v','character-a','p','{}',1)");
    db.prepare("INSERT INTO character_documents VALUES ('v','synthetic.txt',?,?)").run(bytes, createHash("sha256").update(bytes).digest("hex"));
    db.exec("INSERT INTO auth_sessions VALUES ('synthetic-token','owner-a','synthetic-csrf',1,1,999999,NULL)");
    db.exec("INSERT INTO scheduled_tasks VALUES ('task','conversation-a',1,60,'UTC',1,'{}',999999,1)");
  });
  assert.ok(statSync(join(root, "kuinest.sqlite-wal")).size > 32);
  const destination = join(root, "backups", "synthetic.sqlite");
  await storage.backup(destination);
  await assert.rejects(storage.backup(destination)); // 不覆盖已有备份
  const hashBefore = createHash("sha256").update(readFileSync(destination)).digest("hex");
  const restoredRoot = join(directory(), "restored");
  await restoreDatabase(destination, restoredRoot, clock.value);
  const source = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    inspect(restoredRoot, restored => {
      verifyIntegrity(restored, loadMigrations());
      assert.deepEqual(row<{ content: Buffer }>(restored, "SELECT content FROM character_documents").content, bytes);
      for (const table of ["owners", "provider_profiles", "characters", "character_versions", "character_documents", "conversations", "branches", "context_entries", "messages", "runs", "run_events", "context_snapshots", "provider_calls", "tool_calls", "memory_versions", "memory_heads", "task_occurrences", "import_batches", "audit_events", "schema_migrations", "auth_throttles"]) {
        assert.deepEqual(restored.prepare("SELECT * FROM " + table + " ORDER BY rowid").all(), source.prepare("SELECT * FROM " + table + " ORDER BY rowid").all(), table);
      }
      assert.equal(row<{ revoked_at: number }>(restored, "SELECT revoked_at FROM auth_sessions").revoked_at, clock.value);
      assert.equal(row<{ enabled: number }>(restored, "SELECT enabled FROM scheduled_tasks").enabled, 0);
      assert.equal(row<{ expires_at: number }>(restored, "SELECT expires_at FROM runtime_leases").expires_at, 0);
      assert.equal(row<{ fence: number }>(restored, "SELECT fence FROM runtime_leases").fence, 1);
    });
    assert.equal(row<{ revoked_at: null }>(source, "SELECT revoked_at FROM auth_sessions").revoked_at, null);
    assert.equal(row<{ enabled: number }>(source, "SELECT enabled FROM scheduled_tasks").enabled, 1);
  } finally { source.close(); }
  assert.equal(createHash("sha256").update(readFileSync(destination)).digest("hex"), hashBefore);
  await assert.rejects(restoreDatabase(destination, restoredRoot, clock.value));
  const restoredStorage = new SqliteStorage({ dataRoot: restoredRoot, instanceId: "restored", clock });
  t.after(() => restoredStorage.close());
  assert.equal((await restoredStorage.getReadiness()).lease.held, true);
  assert.equal(restoredStorage.readConversation("owner-a", "conversation-a")?.title, "合成标题-a");
});

test("D06：损坏、外键异常或迁移校验和异常的备份在创建恢复目录前拒绝", async t => {
  const { root, storage, clock } = fixture(t); seed(storage);
  for (const corruption of ["checksum", "foreign-key", "bytes"]) {
    const source = join(root, "backups", corruption + ".sqlite");
    await storage.backup(source);
    if (corruption === "bytes") writeFileSync(source, "synthetic-corrupt-database");
    else {
      const db = new Database(source);
      try {
        if (corruption === "checksum") db.exec("UPDATE schema_migrations SET checksum='tampered'");
        else { db.pragma("foreign_keys=OFF"); db.exec("INSERT INTO auth_sessions VALUES ('bad','absent','synthetic',1,1,2,NULL)"); }
      } finally { db.close(); }
    }
    const target = join(directory(), "must-not-exist");
    await assert.rejects(restoreDatabase(source, target, clock.value));
    assert.equal(existsSync(target), false);
  }
});

test("D06：拒绝网络路径、目录联接和多硬链接数据库，防止跨目录访问", () => {
  for (const path of ["relative.sqlite", "\\\\synthetic-server\\share\\db", "//synthetic-server/share/db"]) assert.throws(() => localPath(path));
  const root = directory(), target = join(root, "target"), junction = join(root, "junction");
  mkdirSync(target); symlinkSync(target, junction, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => checkedDirectory(junction), isCode("PATH_UNSAFE"));
  const file = join(root, "original.sqlite"), alias = join(root, "alias.sqlite");
  writeFileSync(file, "synthetic"); linkSync(file, alias);
  assert.throws(() => checkedFile(file), isCode("FILE_UNSAFE"));
  assert.throws(() => checkedFile(alias), isCode("FILE_UNSAFE"));
});

test("D06：备份过程中失租则失败，关闭后不得继续备份", async t => {
  const { root, clock, storage } = fixture(t); seed(storage);
  const pending = storage.backup(join(root, "backups", "expired.sqlite"));
  clock.value += 30000;
  await assert.rejects(pending);
  await storage.close();
  assert.throws(() => storage.backup(join(root, "backups", "closed.sqlite")));
});

test("D01：实际服务启动迁移、第二实例拒绝、关闭释放租约并支持重启", async t => {
  const parent = join(projectRoot, "runtime", "dev-synthetic");
  mkdirSync(parent, { recursive: true });
  const dataRoot = mkdtempSync(join(parent, "stage02-server-"));
  const reserve = createServer();
  await new Promise<void>((resolve, reject) => { reserve.once("error", reject); reserve.listen(0, "127.0.0.1", resolve); });
  const address = reserve.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
  const env = { NODE_ENV: "test", APP_MODE: "synthetic", DATA_ROOT: dataRoot, PORT: String(port) };
  const app = await startServer(env);
  t.after(() => app.close());
  assert.equal((await fetch("http://127.0.0.1:" + port + "/health/ready")).status, 200);
  await assert.rejects(startServer(env), isCode("LEASE_BUSY"));
  assert.equal((await app.inject("/health/ready")).statusCode, 200);
  await app.close();
  const next = await startServer(env); t.after(() => next.close());
  assert.equal((await next.inject("/health/ready")).statusCode, 200);
  await next.close();
  assert.equal(next.server.listening, false);
});

test("D06：维护 CLI 只处理合成目录，备份恢复可执行且不自动激活", async t => {
  const parent = join(projectRoot, "runtime", "dev-synthetic"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "stage02-cli-"));
  const storage = new SqliteStorage({ dataRoot: root, instanceId: randomUUID(), clock: { now: Date.now } });
  t.after(() => storage.close()); seed(storage);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", APP_MODE: "synthetic", DATA_ROOT: root };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  const run = (...args: string[]) => spawnSync(process.execPath, ["apps/backend/dist/storage/cli.js", ...args], { cwd: projectRoot, env, encoding: "utf8", timeout: 15000, windowsHide: true });
  const busy = run("backup");
  assert.equal(busy.status, 1); assert.match(busy.stderr, /LEASE_BUSY/);
  await storage.close();
  const backup = run("backup"); assert.equal(backup.status, 0, backup.stderr);
  const id = (JSON.parse(backup.stdout) as { backupId: string }).backupId;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const restore = run("restore", "--backup=" + id); assert.equal(restore.status, 0, restore.stderr);
  const result = JSON.parse(restore.stdout) as { restoreId: string; activated: boolean };
  assert.equal(result.activated, false);
  inspect(join(root, "restores", result.restoreId), db => assert.equal(count(db, "owners"), 2));
  const bad = run("restore", "--backup=../../private");
  assert.equal(bad.status, 1); assert.doesNotMatch(bad.stderr, /\.\.\/|[A-Z]:\\/);
});

test("D02：已有数据库外键损坏时启动拒绝，不能取得新租约", async t => {
  const { root, storage, clock } = fixture(t);
  await storage.close();
  inspect(root, db => {
    db.pragma("foreign_keys=OFF");
    db.exec("INSERT INTO auth_sessions VALUES ('synthetic-bad','absent','synthetic',1,1,2,NULL)");
  });
  assert.throws(() => new SqliteStorage({ dataRoot: root, instanceId: "damaged", clock }), isCode("FOREIGN_KEY_FAILED"));
  inspect(root, db => assert.equal(row<{ fence: number }>(db, "SELECT fence FROM runtime_leases").fence, 1));
});

test("D01：监听端口失败会关闭存储并释放刚领取的租约", async t => {
  const parent = join(projectRoot, "runtime", "dev-synthetic"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "stage02-listen-failure-"));
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve())));
  const address = blocker.address(); assert.ok(address && typeof address !== "string");
  await assert.rejects(startServer({ NODE_ENV: "test", APP_MODE: "synthetic", DATA_ROOT: root, PORT: String(address.port) }), /START_FAILED/);
  inspect(root, db => assert.equal(row<{ expires_at: number }>(db, "SELECT expires_at FROM runtime_leases").expires_at, 0));
});
