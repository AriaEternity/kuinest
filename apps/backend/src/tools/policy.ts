import { config } from "../context/profile.js";
import type { Pinned } from "../context/types.js";
export function policy(input: Pinned, searchEnabled: boolean) {
  const c = config(input.config, input.profile.status === "synthetic");
  return { config: c, names: ["clock_now", "memory_search", "memory_get",
    ...(input.origin !== "heartbeat" && input.allowMemoryWrite && c.memoryReviewEnabled ? ["memory_propose"] : []),
    ...(input.allowMemoryWrite && c.memoryAppendKeys.length ? ["memory_append"] : []),
    ...(input.allowMemoryWrite && c.memoryReplaceEnabled && c.memoryWriteKeys.length ? ["memory_replace"] : []),
    ...(input.allowWebSearch && searchEnabled ? ["web_search"] : [])] };
}
export class ToolError extends Error { constructor(readonly code: string) { super("工具未能完成。"); } }
