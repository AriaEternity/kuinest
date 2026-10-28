import type { Session, RawEntry } from "./types.js";
import { check, hash, id, json, limits, object } from "./safe.js";
export function parse(bytes: Buffer): Session {
  const lines: Buffer[] = []; let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i !== bytes.length && bytes[i] !== 10) { check(i - start < limits.record, "RECORD_LIMIT"); continue; }
    if (i > start) lines.push(bytes.subarray(start, i));
    else check(i === bytes.length, "JSONL_BLANK");
    start = i + 1; check(lines.length <= limits.records + 1, "RECORD_COUNT_LIMIT");
  }
  check(lines.length > 0, "SESSION_EMPTY");
  const header = json(lines.shift()!);
  check(object(header) && header.type === "session" && header.version === 3 && id(header.id), "SESSION_FORMAT");
  const entries: RawEntry[] = [], rawHashes = new Map<string, string>();
  for (const line of lines) {
    const e = json(line);
    check(object(e) && id(e.id) && (e.parentId === null || id(e.parentId)) && typeof e.type === "string"
      && typeof e.timestamp === "string" && Number.isFinite(Date.parse(e.timestamp)) && !rawHashes.has(e.id), "ENTRY_INVALID");
    check(e.type !== "session", "SESSION_FORMAT");
    entries.push(e as RawEntry); rawHashes.set(e.id, hash(line));
  }
  const byId = new Map(entries.map(e => [e.id, e]));
  // 检查所有旁支，不只检查当前叶；迭代着色避免深链递归爆栈。
  const done = new Set<string>();
  for (const entry of entries) {
    let at: string | null = entry.id; const visiting = new Set<string>();
    while (at && !done.has(at)) {
      check(!visiting.has(at), "PARENT_CYCLE"); visiting.add(at);
      const e = byId.get(at); check(e, "PARENT_MISSING"); at = e.parentId;
    }
    for (const value of visiting) done.add(value);
  }
  return { id: header.id, header, entries, rawHashes };
}
export function chain(session: Session, leaf: string | null): RawEntry[] {
  const map = new Map(session.entries.map(e => [e.id, e])), result: RawEntry[] = [];
  let at = leaf;
  while (at) { const e = map.get(at); check(e, "LEAF_MISSING"); result.push(e); at = e.parentId; }
  return result.reverse();
}
