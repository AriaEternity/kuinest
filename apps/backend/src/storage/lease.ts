import type Database from "better-sqlite3";
import { requireCondition } from "./errors.js";
import { hasTable } from "./migrations.js";

export interface LeaseToken { readonly owner: string; readonly fence: number; }
interface LeaseRow { owner_instance: string; fence: number; expires_at: number; }
function row(db: Database.Database): LeaseRow | undefined {
  return db.prepare("SELECT owner_instance,fence,expires_at FROM runtime_leases WHERE name='backend'").get() as LeaseRow | undefined;
}
export function requireNoActiveLease(db: Database.Database, now: number): void {
  requireCondition(db.inTransaction, "TRANSACTION_REQUIRED");
  if (hasTable(db, "runtime_leases")) requireCondition((row(db)?.expires_at ?? 0) <= now, "LEASE_BUSY");
}
export function claimLease(db: Database.Database, owner: string, now: number): LeaseToken {
  requireCondition(db.inTransaction && owner.length > 0 && Number.isSafeInteger(now), "LEASE_INVALID");
  const previous = row(db);
  requireCondition(!previous || previous.expires_at <= now, "LEASE_BUSY");
  const fence = (previous?.fence ?? 0) + 1;
  requireCondition(Number.isSafeInteger(fence), "FENCE_EXHAUSTED");
  db.prepare("INSERT INTO runtime_leases(name,owner_instance,fence,expires_at) VALUES ('backend',?,?,?) ON CONFLICT(name) DO UPDATE SET owner_instance=excluded.owner_instance,fence=excluded.fence,expires_at=excluded.expires_at").run(owner, fence, now + 30000);
  return Object.freeze({ owner, fence });
}
export function assertLease(db: Database.Database, token: LeaseToken, now: number): void {
  const current = row(db);
  requireCondition(current?.owner_instance === token.owner && current.fence === token.fence && current.expires_at > now, "LEASE_LOST");
}
export function renewLease(db: Database.Database, token: LeaseToken, now: number): void {
  requireCondition(db.inTransaction, "TRANSACTION_REQUIRED");
  assertLease(db, token, now);
  db.prepare("UPDATE runtime_leases SET expires_at=? WHERE name='backend' AND owner_instance=? AND fence=?").run(now + 30000, token.owner, token.fence);
}
export function releaseLease(db: Database.Database, token: LeaseToken): void {
  // 保留 fence 历史，不能删除行后从 1 重新计数。
  db.prepare("UPDATE runtime_leases SET expires_at=0 WHERE name='backend' AND owner_instance=? AND fence=?").run(token.owner, token.fence);
}
export function leaseState(db: Database.Database, token: LeaseToken, now: number) {
  const current = row(db);
  return { held: current?.owner_instance === token.owner && current.fence === token.fence && current.expires_at > now, expiresAt: current?.expires_at ?? 0 };
}
