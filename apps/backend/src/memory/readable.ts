import type { CharacterConfig, MemoryVersion } from "../context/types.js";
// confirmed标记只由存储层对照确认台账产生，不能由模型或迁移provenance自行声明。
export function readableKeys(c: CharacterConfig, rows: MemoryVersion[]): string[] {
 return [...new Set([...c.memoryReadKeys,...(c.memoryReviewEnabled ? rows.filter(r=>r.confirmed===true).map(r=>r.key) : [])])];
}
