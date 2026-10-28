import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthSession } from "@kuinest/contracts";
import type { AppConfig } from "../config.js";
import type { Clock } from "../ports.js";
import type { ApiStorage, SessionRecord } from "../application/ports.js";
import { ApplicationError, ensure } from "../application/errors.js";
import { type Passwords, passwords as defaultPasswords } from "./password.js";
import { Signing } from "./secrets.js";
import { ApiLimiter } from "./throttle.js";

export const tokenHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const publicSession = (session: SessionRecord): AuthSession => ({
  ownerId: session.ownerId, expiresAt: new Date(Math.min(session.expiresAt, session.lastSeenAt + 86400000)).toISOString(), csrfToken: session.csrfToken,
});
export class Sessions {
  readonly cookieName: string;
  readonly secure: boolean;
  #limiter = new ApiLimiter();
  constructor(readonly store: ApiStorage, readonly clock: Clock, readonly config: AppConfig, readonly signing: Signing, readonly passwords: Passwords = defaultPasswords) {
    this.secure = !(config.environment === "development" && config.mode === "synthetic" && ["127.0.0.1", "::1"].includes(config.host));
    this.cookieName = this.secure ? "__Host-kuinest_session" : "kuinest_dev_session";
  }
  origin(value: string | undefined): void { ensure(value === this.config.publicOrigin, "ORIGIN_FORBIDDEN"); }
  async login(username: string, password: string, address: string): Promise<{ token: string; session: SessionRecord }> {
    const retry = this.store.reserveLogin(this.signing.ipBucket(address, this.clock.now()), this.clock.now());
    if (retry > 0) throw new ApplicationError("RATE_LIMITED", retry);
    const owner = this.store.owner(username);
    const valid = await this.passwords.verify(password, owner?.passwordHash);
    if (!owner || !valid) { this.store.failedLogin(this.clock.now()); throw new ApplicationError("AUTH_INVALID"); }
    const now = this.clock.now(), token = randomBytes(32).toString("base64url");
    const session: SessionRecord = { ownerId: owner.id, tokenHash: tokenHash(token), csrfToken: randomBytes(32).toString("base64url"), createdAt: now, lastSeenAt: now, expiresAt: now + 7 * 86400000 };
    this.store.createSession(session, owner.passwordHash);
    return { token, session };
  }
  authenticate(token: string | undefined, touchLimit = true, touchSession = true): SessionRecord {
    ensure(token && /^[A-Za-z0-9_-]{43}$/.test(token) && Buffer.from(token, "base64url").toString("base64url") === token, "AUTH_REQUIRED");
    const session = this.store.session(tokenHash(token), this.clock.now(), touchSession);
    ensure(session, "AUTH_REQUIRED");
    if (touchLimit) this.#limiter.check(session.ownerId, this.clock.now());
    return session;
  }
  validateStream(session: SessionRecord): void {
    ensure(this.store.session(session.tokenHash, this.clock.now(), false)?.ownerId === session.ownerId, "AUTH_REQUIRED");
  }
  csrf(session: SessionRecord, value: string | undefined): void {
    ensure(typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value), "CSRF_INVALID");
    const supplied = Buffer.from(value), expected = Buffer.from(session.csrfToken);
    ensure(supplied.length === expected.length && timingSafeEqual(supplied, expected), "CSRF_INVALID");
  }
  logout(session: SessionRecord): void { this.store.revokeSession(session.tokenHash, this.clock.now()); }
}
