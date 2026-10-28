import { accessSync, constants, lstatSync, mkdirSync, openSync, closeSync, realpathSync, statfsSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep, dirname, join } from "node:path";
import { requireCondition } from "./errors.js";

function stat(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export function localPath(path: string): string {
  requireCondition(isAbsolute(path) && !path.includes("\0") && !/^(?:\\\\|\/\/)/.test(path), "PATH_INVALID");
  if (process.platform === "win32") requireCondition(/^[a-z]:[\\/]/i.test(path) && !path.slice(2).includes(":"), "PATH_INVALID");
  return resolve(path);
}
export function checkedDirectory(path: string, create = false): string {
  const full = localPath(path), prefix = parse(full).root;
  let current = prefix;
  for (const part of relative(prefix, full).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info = stat(current);
    if (!info && create) { mkdirSync(current, { mode: 0o700 }); info = lstatSync(current); }
    requireCondition(info?.isDirectory() && !info.isSymbolicLink(), "PATH_UNSAFE");
  }
  const real = realpathSync(full);
  requireCondition(process.platform === "win32" ? real.toLowerCase() === full.toLowerCase() : real === full, "PATH_UNSAFE");
  // 拒绝已知网络文件系统；Windows UNC 路径在进入目录之前拒绝。
  const filesystem = statfsSync(full);
  requireCondition(![0x6969, 0xff534d42, 0x517b, 0x564c].includes(filesystem.type >>> 0), "NETWORK_FILESYSTEM");
  accessSync(full, constants.R_OK | constants.W_OK);
  return full;
}
export function checkedFile(path: string, create = false): string {
  const full = localPath(path);
  checkedDirectory(dirname(full));
  let info = stat(full);
  if (!info && create) { const fd = openSync(full, "wx", 0o600); closeSync(fd); info = lstatSync(full); }
  requireCondition(info?.isFile() && !info.isSymbolicLink() && info.nlink === 1, "FILE_UNSAFE");
  return full;
}
export function checkSidecars(databasePath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (stat(databasePath + suffix)) checkedFile(databasePath + suffix);
}
export function reserveNewFile(path: string): string {
  const full = localPath(path);
  checkedDirectory(dirname(full), true);
  const fd = openSync(full, "wx", 0o600);
  closeSync(fd);
  return full;
}
export function reserveNewDirectory(path: string): string {
  const full = localPath(path);
  checkedDirectory(dirname(full), true);
  mkdirSync(full, { mode: 0o700 });
  return checkedDirectory(full);
}
