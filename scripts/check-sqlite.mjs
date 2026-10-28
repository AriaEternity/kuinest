import Database from "better-sqlite3";
// 仅打开内存库验证当前已安装的原生驱动，不执行第 02 阶段迁移。
const db = new Database(":memory:");
try {
  const { version } = db.prepare("SELECT sqlite_version() AS version").get();
  const parts = version.split(".").map(Number);
  if (parts[0] < 3 || (parts[0] === 3 && (parts[1] < 53 || (parts[1] === 53 && parts[2] < 1))))
    throw new Error("SQLite 版本低于设计基线。");
  process.stdout.write(JSON.stringify({ status: "ok", sqliteVersion: version, storage: "memory" }) + "\n");
} finally { db.close(); }
