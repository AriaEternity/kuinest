import { kuisenseContextAccess } from "./kuisense-context.js";
import { runtimeAccess } from "./runtime-access.js";
import { memoryReviewAccess } from "./memory-review.js";
import { imageAccess } from "./image-assets.js";
import { schedulerAccess } from "./scheduler-access.js";
import { contextAccess } from "./context-access.js";
import { characterAccess } from "./character-access.js";
import { memoryAccess } from "./memory-access.js";
import type Database from "better-sqlite3";
import type { Clock, Storage, StorageReadiness } from "../ports.js";
import { openDatabase } from "./database.js";
import { applyMigrationsInTransaction, loadMigrations, verifyIntegrity, type Migration } from "./migrations.js";
import { assertLease, claimLease, leaseState, releaseLease, renewLease, requireNoActiveLease, type LeaseToken } from "./lease.js";
import { requireCondition, StorageError } from "./errors.js";
import { findConversation, scopedRepositories, type ScopedRepositories } from "./repositories/index.js";
import { backupDatabase } from "./backup.js";
import { protocolAccess } from "./protocol.js";
import { eventAccess } from "./events.js";
import { apiAccess } from "./api-access.js";
import { runAccess } from "./runs/access.js";

export interface StorageOptions {
  dataRoot: string;
  instanceId: string;
  clock: Clock;
  migrations?: readonly Migration[];
}
export type Ticker = (tick: () => void, milliseconds: number) => () => void;
const defaultTicker: Ticker = (tick, milliseconds) => {
  const timer = setInterval(tick, milliseconds); timer.unref();
  return () => clearInterval(timer);
};

export class SqliteStorage implements Storage {
  #subscribers = new Set<() => void>();
  #db: Database.Database;
  #token: LeaseToken;
  #clock: Clock;
  #manifest: readonly Migration[];
  #version: string;
  #lost = false;
  #closing = false;
  #stopTicker: (() => void) | undefined;
  #onLost: (() => void) | undefined;
  #backups = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;

  constructor(options: StorageOptions) {
    this.#clock = options.clock;
    this.#manifest = Object.freeze((options.migrations ?? loadMigrations()).map(item => Object.freeze({ ...item })));
    const db = openDatabase(options.dataRoot);
    try {
      this.#token = db.transaction(() => {
        const now = this.#clock.now();
        // 检查旧租约、DDL、迁移历史和领取新租约必须在同一写事务中。
        requireNoActiveLease(db, now);
        applyMigrationsInTransaction(db, this.#manifest, now);
        verifyIntegrity(db, this.#manifest);
        return claimLease(db, options.instanceId, this.#clock.now());
      }).immediate();
      this.#version = (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
      this.#db = db;
    } catch (error) { db.close(); throw error; }
  }
  #live(): void {
    requireCondition(!this.#lost && !this.#closing && this.#db.open, "STORAGE_UNAVAILABLE");
  }
  #checkLease(): void {
    this.#live();
    try { assertLease(this.#db, this.#token, this.#clock.now()); }
    catch (error) { this.#lose(); throw error; }
  }
  #lose(): void {
    if (this.#lost) return;
    this.#lost = true;
    this.#stopTicker?.();
    // 放到事务栈退出后通知服务关闭，避免在执行中的事务里关闭数据库。
    queueMicrotask(() => this.#onLost?.());
  }
  #transaction<T>(operation: () => T): T {
    this.#live();
    requireCondition(!this.#db.inTransaction, "NESTED_TRANSACTION");
    const committed = this.#db.transaction(() => {
      this.#checkLease();
      const result = operation();
      if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
        // 事务不允许跨 await；吸收拒绝，事务作用域仍立即失效并回滚。
        void Promise.resolve(result).catch(() => {});
        throw new StorageError("ASYNC_TRANSACTION");
      }
      this.#checkLease();
      return result;
    }).immediate();
    // 回滚不通知，订阅异常不影响已经提交的事务。通知本身不持有事件。
    if (this.#subscribers.size) queueMicrotask(() => { for (const wake of this.#subscribers) { try { wake(); } catch { /* 通知无事实数据。 */ } } });
    return committed;
  }
  // 仅供离线初始化和后续认证模块使用，HTTP 层不能直接获得数据库连接。
  provisionOwner(record: { id: string; username: string; passwordHash: string; createdAt: number }): void {
    this.#transaction(() => {
      this.#db.prepare("INSERT INTO owners(id,username,password_hash,created_at) VALUES (?,?,?,?)").run(record.id, record.username, record.passwordHash, record.createdAt);
    });
  }
  write<T>(ownerId: string, operation: (repositories: ScopedRepositories) => T): T {
    let active = true;
    try {
      return this.#transaction(() => {
        requireCondition(this.#db.prepare("SELECT 1 FROM owners WHERE id=?").get(ownerId), "NOT_FOUND");
        return operation(scopedRepositories(this.#db, ownerId, () => {
          requireCondition(active && this.#db.inTransaction, "TRANSACTION_CLOSED");
          this.#checkLease();
        }));
      });
    } finally { active = false; }
  }
  subscribeCommits(wake: () => void): () => void { this.#checkLease(); this.#subscribers.add(wake); return () => { this.#subscribers.delete(wake); }; }
  runtimeAccess() { return runtimeAccess(this.#db, fn => this.#transaction(fn), () => this.#checkLease()); }
  imageAccess(options: { maxStoredBytes?: number } = {}) { return imageAccess(this.#db, fn => this.#transaction(fn), () => this.#checkLease(), options.maxStoredBytes); }
  schedulerAccess() { return schedulerAccess(this.#db, fn => this.#transaction(fn)); }
  contextAccess() { return contextAccess(this.#db, fn => this.#transaction(fn), () => this.#checkLease()); }
  characterAccess() { return characterAccess(this.#db, fn => this.#transaction(fn)); }
  memoryReviewAccess() { return memoryReviewAccess(this.#db, fn => this.#transaction(fn), () => this.#checkLease(), this.#clock); }
  memoryAccess() { return memoryAccess(this.#db, fn => this.#transaction(fn), () => this.#checkLease()); }
  kuisenseContextAccess() { return kuisenseContextAccess(this.#db, fn => this.#transaction(fn), () => this.#checkLease()); }
  protocolAccess() { return protocolAccess(this.#db, operation => this.#transaction(operation)); }
  eventAccess() { return eventAccess(this.#db, operation => this.#transaction(operation), () => this.#checkLease()); }
  apiAccess() { return apiAccess(this.#db, operation => this.#transaction(operation), () => this.#checkLease()); }
  runAccess(options: { context?: boolean; webSearch?: boolean; images?: boolean } = {}) { return runAccess(this.#db, this.#token, operation => this.#transaction(operation), () => this.#checkLease(), options.context ?? false, options.webSearch ?? false, options.images ?? false); }
  readConversation(ownerId: string, conversationId: string) {
    this.#live();
    return findConversation(this.#db, ownerId, conversationId);
  }
  renew(): void {
    try { this.#transaction(() => renewLease(this.#db, this.#token, this.#clock.now())); }
    catch (error) { this.#lose(); throw error; }
  }
  startRenewal(onLost: () => void, ticker: Ticker = defaultTicker): void {
    this.#live();
    requireCondition(!this.#stopTicker, "RENEWAL_ALREADY_STARTED");
    this.#onLost = onLost;
    this.#stopTicker = ticker(() => {
      if (this.#closing || this.#lost) return;
      try { this.renew(); } catch { /* 失租由统一回调处理，禁止记录原始 SQL 错误。 */ }
    }, 5000);
  }
  async getReadiness(): Promise<StorageReadiness> {
    const connected = this.#db.open && !this.#closing;
    let lease = { held: false, expiresAt: 0 };
    if (connected && !this.#lost) {
      lease = leaseState(this.#db, this.#token, this.#clock.now());
      if (!lease.held) this.#lose();
    }
    return { connected, schemaCompatible: connected, sqliteVersion: this.#version, lease };
  }
  backup(destination: string): Promise<void> {
    this.#checkLease();
    requireCondition(this.#backups.size === 0, "BACKUP_BUSY");
    const pending = backupDatabase(this.#db, destination, () => this.#checkLease(), this.#manifest);
    this.#backups.add(pending);
    void pending.finally(() => this.#backups.delete(pending)).catch(() => {});
    return pending;
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#subscribers.clear();
    this.#stopTicker?.();
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#backups]);
      if (this.#db.open) {
        try { this.#db.transaction(() => releaseLease(this.#db, this.#token)).immediate(); }
        finally { this.#db.close(); }
      }
    })();
    return this.#closePromise;
  }
}
