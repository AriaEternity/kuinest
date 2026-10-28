import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { ApplicationError, ensure } from "../application/errors.js";

const parameters = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
export function checkPassword(value: string, creation: boolean): void {
  const characters = [...value];
  ensure(characters.length >= (creation ? 12 : 1) && characters.length <= 256 && Buffer.byteLength(value, "utf8") <= 1024, "INPUT_INVALID");
  ensure(characters.every(char => { const n = char.codePointAt(0)!; return n < 0xd800 || n > 0xdfff; }), "INPUT_INVALID");
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, parameters, (error, value) => error ? reject(error) : resolve(value)));
}
function parse(encoded: string | undefined): { salt: Buffer; digest: Buffer; valid: boolean } {
  const match = /^scrypt\$v1\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(encoded ?? "");
  if (match) {
    const salt = Buffer.from(match[1]!, "base64url"), digest = Buffer.from(match[2]!, "base64url");
    if (salt.toString("base64url") === match[1] && digest.toString("base64url") === match[2])
      return { salt, digest, valid: true };
  }
  // 未知账号和异常旧哈希仍走同等成本的 scrypt，不执行输入指定的任意参数。
  return { salt: Buffer.alloc(16), digest: Buffer.alloc(32), valid: false };
}
export const validPasswordHash = (value: string): boolean => parse(value).valid;
export interface Passwords { hash(value: string): Promise<string>; verify(value: string, encoded?: string): Promise<boolean>; }
export class PasswordHasher implements Passwords {
  #busy = false;
  async #one<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new ApplicationError("RATE_LIMITED", 1);
    this.#busy = true;
    try { return await operation(); } finally { this.#busy = false; }
  }
  hash(value: string): Promise<string> {
    checkPassword(value, true);
    return this.#one(async () => {
      const salt = randomBytes(16), digest = await derive(value, salt);
      return "scrypt$v1$131072$8$1$" + salt.toString("base64url") + "$" + digest.toString("base64url");
    });
  }
  verify(value: string, encoded?: string): Promise<boolean> {
    checkPassword(value, false);
    return this.#one(async () => {
      const parsed = parse(encoded), actual = await derive(value, parsed.salt);
      const matches = timingSafeEqual(actual, parsed.digest);
      return parsed.valid && matches;
    });
  }
}
// 一个进程共享哈希闸门，包含多个应用工厂或本地维护实例。
export const passwords = new PasswordHasher();
