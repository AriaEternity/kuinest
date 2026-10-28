import { RunFailure } from "../conversations/types.js";
import type { MemoryVersion } from "../context/types.js";
import { memoryKey, validText } from "../context/profile.js";
export function validateMemories(rows: MemoryVersion[]): MemoryVersion[] {
  if (rows.length > 200 || rows.reduce((n, row) => n + Buffer.byteLength(row.content), 0) > 1024 * 1024) throw new RunFailure("MEMORY_INDEX_REQUIRED");
  if (new Set(rows.map(row => row.key)).size !== rows.length || rows.some(row => !memoryKey(row.key) || !validText(row.content))) throw new RunFailure("CONTEXT_INVALID");
  return rows;
}
export function read(rows: MemoryVersion[], key: string): MemoryVersion | undefined {
  if (!memoryKey(key)) throw new RunFailure("CONTEXT_INVALID");
  return validateMemories(rows).find(row => row.key === key);
}
