import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import Database from "better-sqlite3";
import { projectRoot } from "../dist/server.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { openDatabase } from "../dist/storage/database.js";
import type { ScopedRepositories } from "../dist/storage/repositories/index.js";

export function directory(prefix = "database-"): string {
  const parent = join(projectRoot, ".cache", "stage02-tests");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}
export function fixture(t: TestContext) {
  const root = directory();
  const clock = { value: 100000, now() { return this.value; } };
  const storage = new SqliteStorage({ dataRoot: root, instanceId: randomUUID(), clock });
  t.after(() => storage.close());
  return { root, clock, storage };
}
export function inspect<T>(root: string, operation: (db: Database.Database) => T): T {
  const db = openDatabase(root, true);
  try { return operation(db); } finally { db.close(); }
}
export function seed(storage: SqliteStorage): void {
  for (const suffix of ["a", "b"]) {
    storage.provisionOwner({ id: "owner-" + suffix, username: "合成主人-" + suffix, passwordHash: "synthetic-not-a-password-hash", createdAt: 100000 });
    storage.write("owner-" + suffix, repo => {
      repo.createCharacter("character-" + suffix, "合成角色-" + suffix, 100000);
      repo.createConversation("conversation-" + suffix, "character-" + suffix, "合成标题-" + suffix, 100000);
    });
  }
}
export function accepted(repo: ScopedRepositories, suffix = "a") {
  const conversationId = "conversation-" + suffix, userMessageId = "user-" + suffix, replyId = "reply-" + suffix, id = "run-" + suffix;
  repo.insertMessage({ id: userMessageId, conversationId, seq: 1, role: "user", content: "纯合成输入", status: "complete", revision: 1, createdAt: 100000 });
  repo.insertMessage({ id: replyId, conversationId, seq: 2, role: "assistant", content: "", status: "partial", revision: 2, createdAt: 100000 });
  repo.insertAcceptedRun({ id, conversationId, requestKey: "request-" + suffix, inputHash: "synthetic-hash", userMessageId, replyId, createdAt: 100000 });
  repo.insertAcceptedEvent(id, { synthetic: true }, 100000);
}
export function count(db: Database.Database, table: "messages" | "runs" | "run_events" | "schema_migrations" | "owners"): number {
  // 表名是测试源码中的固定枚举，不接收请求输入。
  return (db.prepare("SELECT count(*) AS n FROM " + table).get() as { n: number }).n;
}
