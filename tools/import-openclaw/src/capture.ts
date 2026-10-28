import type { Scope, Manifest, Bundle } from "./types.js";
import { scope } from "./manifest.js";
import { check, hash, json, read, write, newDirectory, limits } from "./safe.js";
export function loadBundle(root: string): Bundle {
  const manifestBytes = read(root, "manifest.json", 2 * 1024 * 1024);
  const manifest = scope(json(manifestBytes), true) as Manifest, files = new Map<string, Buffer>();
  for (const f of manifest.files) {
    const bytes = read(root, f.path);
    check(bytes.length === f.bytes && hash(bytes) === f.sha256, "HASH_MISMATCH"); files.set(f.path, bytes);
  }
  return { manifest, manifestBytes, manifestHash: hash(manifestBytes), files };
}
export function capture(input: string, output: string, definition: Scope, readFile = read): Bundle {
  const s = scope(definition) as Scope, files = new Map<string, Buffer>(); let total = 0;
  for (const f of s.files) {
    const bytes = readFile(input, f.path); total += bytes.length; check(total <= limits.total, "TOTAL_LIMIT"); files.set(f.path, bytes);
  }
  // 复核全部授权路径，不按mtime猜活动会话，不访问未列出的文件。
  for (const f of s.files) check(hash(readFile(input, f.path)) === hash(files.get(f.path)!), "SOURCE_CHANGED");
  const manifest: Manifest = { ...s, files: s.files.map(f => ({ ...f, bytes: files.get(f.path)!.length, sha256: hash(files.get(f.path)!) })), consistency: "double-read-matched", capturedAt: Date.now() };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  newDirectory(output);
  for (const [path, bytes] of files) write(output, path, bytes);
  // 清单最后写入；中途失败留下未完成目录，不能冒充完整批次。
  write(output, "manifest.json", manifestBytes);
  return loadBundle(output);
}
export function copyBundle(bundle: Bundle, output: string): Bundle {
  newDirectory(output);
  for (const [path, bytes] of bundle.files) write(output, path, bytes);
  write(output, "manifest.json", bundle.manifestBytes);
  return loadBundle(output);
}
