import type { Session } from "./types.js";
const canonical = new Set(["message", "thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"]);
// 依据固定版本buildIndex/getBranch，只证明已持久化且严格线性的明确子集。
// 不加载旧运行时，不把现场内存状态或调用者显式leaf覆盖当作已核实。
export function persistedSelection(session: Session, sourceVersion: string | null) {
  const reviewCodes: string[] = [];
  if (sourceVersion !== "2026.7.1-2") reviewCodes.push("SOURCE_RULE_UNVERIFIED");
  let parent: string | null = null;
  for (const entry of session.entries) {
    if (!canonical.has(entry.type)) reviewCodes.push("NONCANONICAL_SELECTION");
    if (Object.hasOwn(entry, "appendMode")) reviewCodes.push("APPEND_MODE_REQUIRES_REVIEW");
    if (entry.parentId !== parent) reviewCodes.push("NONLINEAR_SELECTION");
    parent = entry.id;
  }
  const codes = [...new Set(reviewCodes)];
  return { basis: "openclaw-2026.7.1-2-persisted-linear", verified: codes.length === 0,
    records: session.entries.length, reviewCodes: codes, runtimeStateVerified: false, explicitOverrideVerified: false };
}
