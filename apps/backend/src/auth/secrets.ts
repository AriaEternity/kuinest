import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedDirectory, checkedFile } from "../storage/paths.js";
import { requireCondition } from "../storage/errors.js";
import { ensure } from "../application/errors.js";

// 必须在取得数据库租约之后调用；只使用当前合成数据根下的固定文件。
export function loadSyntheticKey(root: string): Buffer {
  checkedDirectory(root);
  const file = join(root, "cursor-hmac.key");
  if (!existsSync(file)) {
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
  }
  const key = readFileSync(checkedFile(file));
  requireCondition(key.length === 32, "LOCAL_KEY_INVALID");
  return key;
}
export class Signing {
  #key: Buffer;
  constructor(key: Buffer) { ensure(key.length >= 32, "SERVICE_NOT_READY"); this.#key = Buffer.from(key); }
  #mac(scope: readonly string[], payload: string): Buffer {
    return createHmac("sha256", this.#key).update(JSON.stringify(scope)).update("\0").update(payload).digest();
  }
  ipBucket(address: string, now: number): string {
    return "login-ip:" + this.#mac(["login-ip", String(Math.floor(now / 60000))], address).toString("hex");
  }
  cursor(scope: readonly string[], key: readonly (number | string)[]): string {
    const payload = Buffer.from(JSON.stringify(key)).toString("base64url");
    const token = "1." + payload + "." + this.#mac(["cursor", ...scope], payload).toString("base64url");
    ensure(token.length <= 256, "SERVICE_NOT_READY");
    return token;
  }
  readCursor(scope: readonly string[], token: string): unknown[] {
    ensure(token.length <= 256, "CURSOR_INVALID");
    const parts = /^1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    ensure(parts, "CURSOR_INVALID");
    const payload = parts[1]!, signature = Buffer.from(parts[2]!, "base64url");
    ensure(signature.length === 32 && signature.toString("base64url") === parts[2] && timingSafeEqual(signature, this.#mac(["cursor", ...scope], payload)), "CURSOR_INVALID");
    try {
      const bytes = Buffer.from(payload, "base64url");
      ensure(bytes.toString("base64url") === payload, "CURSOR_INVALID");
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      ensure(Array.isArray(value), "CURSOR_INVALID");
      return value;
    } catch { ensure(false, "CURSOR_INVALID"); }
  }
}
