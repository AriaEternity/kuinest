import type Database from "better-sqlite3";
import type { ApiStorage } from "../application/ports.js";
import * as auth from "./auth-records.js";
import * as query from "./public-queries.js";

export function apiAccess(db: Database.Database, write: <T>(operation: () => T) => T, guard: () => void): ApiStorage {
  const read = <T>(operation: () => T): T => {
    guard();
    // 一次读取的消息和会话版本必须来自同一快照。
    return db.transaction(() => { guard(); return operation(); })();
  };
  return Object.freeze({
    owner: (username: string) => read(() => auth.owner(db, username)),
    initializeOwner: (record) => write(() => auth.initializeOwner(db, record)),
    changePassword: (id, expected, hash, now) => write(() => auth.changePassword(db, id, expected, hash, now)),
    unlockLogin: () => write(() => { db.prepare("DELETE FROM auth_throttles WHERE bucket_key='login-global' OR bucket_key LIKE 'login-ip:%'").run(); }),
    reserveLogin: (key, now) => write(() => auth.reserveLogin(db, key, now)),
    failedLogin: (now) => write(() => auth.failedLogin(db, now)),
    createSession: (record, expected) => write(() => auth.createSession(db, record, expected)),
    session: (hash, now, touch = true) => touch ? write(() => auth.session(db, hash, now)) : read(() => auth.session(db, hash, now, false)),
    revokeSession: (hash, now) => write(() => { db.prepare("UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(now, hash); }),
    conversations: (id, before, limit) => read(() => query.conversations(db, id, before, limit)),
    createConversation: (owner, id, title, now) => write(() => query.createConversation(db, owner, id, title, now)),
    renameConversation: (owner, id, title, now) => write(() => query.renameConversation(db, owner, id, title, now)),
    deleteConversation: (owner, id, now) => write(() => query.deleteConversation(db, owner, id, now)),
    conversation: (owner, id) => read(() => query.conversation(db, owner, id)),
    history: (owner, id, before, limit) => read(() => query.history(db, owner, id, before, limit)),
    changes: (owner, id, after, limit) => read(() => query.changes(db, owner, id, after, limit)),
    run: (owner, id) => read(() => query.run(db, owner, id)),
    submission: (owner, id, client) => read(() => query.submission(db, owner, id, client)),
  } satisfies ApiStorage);
}
