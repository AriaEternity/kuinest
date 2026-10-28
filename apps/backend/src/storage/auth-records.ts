import { hash } from "../context/profile.js";
import type Database from "better-sqlite3";
import type { OwnerCredential, OwnerInitialization, SessionRecord } from "../application/ports.js";
import { ensure } from "../application/errors.js";

export const owner = (db: Database.Database, username: string) => db.prepare("SELECT id,username,password_hash AS passwordHash FROM owners WHERE username=?").get(username) as OwnerCredential | undefined;
export function initializeOwner(db: Database.Database, record: OwnerInitialization): void {
  ensure((db.prepare("SELECT count(*) AS n FROM owners").get() as { n: number }).n === 0, "SERVICE_NOT_READY");
  db.prepare("INSERT INTO owners(id,username,password_hash,created_at) VALUES(?,?,?,?)").run(record.id, record.username, record.passwordHash, record.createdAt);
  db.prepare("INSERT INTO provider_profiles(id,owner_id,provider,model,options_json,compatibility_status,created_at) VALUES(?,?,'mock','synthetic','{}','synthetic',?)").run(record.profileId, record.id, record.createdAt);
  db.prepare("INSERT INTO characters(id,owner_id,name,created_at) VALUES(?,?,'合成演示角色',?)").run(record.characterId, record.id, record.createdAt);
  db.prepare("INSERT INTO character_versions(id,character_id,provider_profile_id,config_json,created_at) VALUES(?,?,?,'{\"kind\":\"synthetic-binding\",\"stage\":3}',?)").run(record.versionId, record.characterId, record.profileId, record.createdAt);
  db.prepare("UPDATE characters SET active_version_id=? WHERE id=? AND owner_id=?").run(record.versionId, record.characterId, record.id);
  for (const [name, content] of [["IDENTITY.md", "合成演示角色，仅用于葵栖工程验证，不代表小葵。"], ["SOUL.md", "这是明确虚构的演示资料。对未知事实说明不确定性。"]])
    db.prepare("INSERT INTO character_documents(version_id,logical_name,content,sha256) VALUES(?,?,?,?)").run(record.versionId, name, Buffer.from(content!), hash(content!));
}
export function changePassword(db: Database.Database, ownerId: string, expected: string, passwordHash: string, now: number): void {
  const result = db.prepare("UPDATE owners SET password_hash=? WHERE id=? AND password_hash=?").run(passwordHash, ownerId, expected);
  ensure(result.changes === 1, "AUTH_INVALID");
  db.prepare("UPDATE auth_sessions SET revoked_at=? WHERE owner_id=? AND revoked_at IS NULL").run(now, ownerId);
}
interface ThrottleRow { failures: number; window_started_at: number; blocked_until: number; }
export function reserveLogin(db: Database.Database, ipKey: string, now: number): number {
  const global = db.prepare("SELECT failures,window_started_at,blocked_until FROM auth_throttles WHERE bucket_key='login-global'").get() as ThrottleRow | undefined;
  if (global && global.blocked_until > now) return Math.max(1, Math.ceil((global.blocked_until - now) / 1000));
  if (!global || global.window_started_at <= now - 600000)
    db.prepare("INSERT INTO auth_throttles VALUES('login-global',0,?,0) ON CONFLICT(bucket_key) DO UPDATE SET failures=0,window_started_at=excluded.window_started_at,blocked_until=0").run(now);
  const start = Math.floor(now / 60000) * 60000;
  db.prepare("DELETE FROM auth_throttles WHERE bucket_key LIKE 'login-ip:%' AND window_started_at<?").run(start);
  const ip = db.prepare("SELECT failures FROM auth_throttles WHERE bucket_key=?").get(ipKey) as { failures: number } | undefined;
  if ((ip?.failures ?? 0) >= 5) return Math.max(1, Math.ceil((start + 60000 - now) / 1000));
  db.prepare("INSERT INTO auth_throttles VALUES(?,1,?,0) ON CONFLICT(bucket_key) DO UPDATE SET failures=failures+1").run(ipKey, start);
  return 0;
}
export function failedLogin(db: Database.Database, now: number): void {
  db.prepare("INSERT INTO auth_throttles VALUES('login-global',0,?,0) ON CONFLICT(bucket_key) DO NOTHING").run(now);
  db.prepare("UPDATE auth_throttles SET failures=CASE WHEN window_started_at<=? THEN 1 ELSE failures+1 END,window_started_at=CASE WHEN window_started_at<=? THEN ? ELSE window_started_at END WHERE bucket_key='login-global'").run(now - 600000, now - 600000, now);
  db.prepare("UPDATE auth_throttles SET blocked_until=? WHERE bucket_key='login-global' AND failures>=10").run(now + 600000);
}
export function createSession(db: Database.Database, record: SessionRecord, expectedHash: string): void {
  ensure(db.prepare("SELECT 1 FROM owners WHERE id=? AND password_hash=?").get(record.ownerId, expectedHash), "AUTH_INVALID");
  db.prepare("DELETE FROM auth_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL OR last_seen_at<=?").run(record.createdAt, record.createdAt - 86400000);
  db.prepare("INSERT INTO auth_sessions(token_hash,owner_id,csrf_token,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)").run(record.tokenHash, record.ownerId, record.csrfToken, record.createdAt, record.lastSeenAt, record.expiresAt);
}
export function session(db: Database.Database, hash: string, now: number, touch = true): SessionRecord | undefined {
  const record = db.prepare("SELECT token_hash AS tokenHash,owner_id AS ownerId,csrf_token AS csrfToken,created_at AS createdAt,last_seen_at AS lastSeenAt,expires_at AS expiresAt FROM auth_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? AND last_seen_at>?").get(hash, now, now - 86400000) as SessionRecord | undefined;
  if (touch && record && record.lastSeenAt <= now - 60000) {
    db.prepare("UPDATE auth_sessions SET last_seen_at=? WHERE token_hash=? AND last_seen_at=?").run(now, hash, record.lastSeenAt);
    record.lastSeenAt = now;
  }
  return record;
}
