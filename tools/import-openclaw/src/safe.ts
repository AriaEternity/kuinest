import { memoryKey } from "../../../apps/backend/dist/context/profile.js";
import { createHash } from "node:crypto";
import { readSync, openSync, fstatSync, closeSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { checkedDirectory, checkedFile, reserveNewDirectory } from "../../../apps/backend/dist/storage/paths.js";
export class ImportError extends Error { constructor(readonly code: string) { super(code); } }
export function check(value: unknown, code: string): asserts value { if (!value) throw new ImportError(code); }
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const uid = (...parts: string[]) => "oc_" + hash(JSON.stringify(parts));
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const hex = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export function text(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ImportError("UTF8_INVALID"); }
}
export function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(text(bytes)); } catch (e) { if (e instanceof ImportError) throw e; throw new ImportError("JSON_INVALID"); }
}
export function child(root: string, relative: string): string {
  check((/^[A-Za-z0-9_./-]+$/.test(relative) || relative.startsWith("workspace/memory/") && memoryKey(relative.slice(10))) && !relative.split("/").some(p => !p || p === "." || p === ".."), "PATH_INVALID");
  const base = checkedDirectory(root), full = resolve(base, relative);
  check(full.startsWith(base + (process.platform === "win32" ? "\\" : "/")), "PATH_INVALID");
  return full;
}
export const limits = { record: 16 * 1024 * 1024, file: 64 * 1024 * 1024, total: 256 * 1024 * 1024, files: 2048, records: 100000 };
export function read(root: string, path: string, max = limits.file): Buffer {
  const full = checkedFile(child(root, path)), fd = openSync(full, "r");
  try {
    const before = fstatSync(fd); check(before.isFile() && before.nlink === 1 && before.size <= max, "FILE_LIMIT_OR_UNSAFE");
    const data = Buffer.alloc(before.size);
    // 有界读取；正在追加的文件不会让readFileSync持续分配。
    let count = 0;
    while (count < data.length) { const n = readSync(fd, data, count, data.length-count, count); check(n > 0, "SOURCE_CHANGED"); count += n; }
    const extra = Buffer.alloc(1); check(readSync(fd,extra,0,1,count) === 0, "SOURCE_CHANGED");
    const after = fstatSync(fd);
    check(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, "SOURCE_CHANGED");
    checkedFile(full);
    return data;
  } finally { closeSync(fd); }
}
export function newDirectory(path: string): string { return reserveNewDirectory(path); }
export function write(root: string, path: string, bytes: Uint8Array): void {
  const full = child(root, path); checkedDirectory(dirname(full), true);
  writeFileSync(full, bytes, { flag: "wx", mode: 0o600 });
}
export function safeFailure(error: unknown): { ok: false; code: string } {
  // 绝不透传第三方异常正文、绝对路径、JSON片段或堆栈。
  return { ok: false, code: error instanceof ImportError ? error.code : "IMPORT_FAILED" };
}
