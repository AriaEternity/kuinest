import Database from "better-sqlite3";
import { join } from "node:path";
import { checkedDirectory, checkedFile, checkSidecars } from "./paths.js";
import { sqliteSupported } from "../http/health.js";
import { requireCondition } from "./errors.js";

export function openDatabase(root: string, mustExist = false): Database.Database {
  const directory = checkedDirectory(root, !mustExist);
  const file = join(directory, "kuinest.sqlite");
  checkedFile(file, !mustExist); checkSidecars(file);
  const db = new Database(file, { fileMustExist: true, timeout: 5000 });
  try {
    const version = (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
    requireCondition(sqliteSupported(version), "SQLITE_UNSUPPORTED");
    db.pragma("foreign_keys=ON");
    db.pragma("journal_mode=WAL");
    db.pragma("synchronous=FULL");
    db.pragma("busy_timeout=5000");
    verifyPragmas(db);
    checkSidecars(file);
    return db;
  } catch (error) { db.close(); throw error; }
}
export function verifyPragmas(db: Database.Database): void {
  requireCondition(db.pragma("foreign_keys", { simple: true }) === 1 &&
    db.pragma("journal_mode", { simple: true }) === "wal" &&
    db.pragma("synchronous", { simple: true }) === 2 &&
    db.pragma("busy_timeout", { simple: true }) === 5000, "SQLITE_CONFIGURATION");
}
