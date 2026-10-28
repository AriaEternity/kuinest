import { persistedSelection } from "./source-selection.js";
import { readInterrupted } from "./interrupted.js";
import { loadSource } from "./source-receive.js";
import { check, json, uid, ImportError } from "./safe.js";
import { parse, chain } from "./parse.js";
import { mapSession } from "./map.js";
import { validateHistory } from "../../../apps/backend/dist/providers/messages.js";
import { resolve as resolveContext } from "../../../apps/backend/dist/context/branches.js";
import type { Session, RawEntry, Scope } from "./types.js";

// 只返回固定字段/代码和计数；绝不返回源条目、文件名、ID、正文或第三方异常。
const gapCodes = ["MESSAGE_FORMAT", "THINKING_SIGNATURE_UNSUPPORTED", "MULTIMODAL_UNSUPPORTED",
  "CONTENT_BLOCK_UNSUPPORTED", "REASONING_AMBIGUOUS", "TOOLS_AMBIGUOUS", "REASONING_MISSING",
  "ASSISTANT_INCOMPLETE", "UNKNOWN_ENTRY", "REPLAY_SOURCE_IDENTITY_MISSING", "CROSS_MODEL_REPLAY_REVIEW", "REPLAY_SIGNATURE_REQUIRED", "OTHER"] as const;
type Identity = Pick<Scope, "sourceId" | "agentId" | "requireReasoning">;
function messages(session: Session, entries: RawEntry[], identity: Identity) {
  const gaps = Object.fromEntries(gapCodes.map(code => [code, 0])) as Record<typeof gapCodes[number], number>;
  const payloads: unknown[] = [], archivedPayloads: unknown[] = []; let total = 0, mappedCount = 0, excludedFromReplay = 0, missingWhenReasoningRequired = 0;
  const interrupted = { aborted: 0, error: 0, visiblePartials: 0 };
  for (const raw of entries) {
    if (raw.type !== "message") continue;
    total++;
    const single = { ...session, entries: [{ ...raw, parentId: null }] };
    const mapped = mapSession(single, identity);
    for (const code of mapped.gaps) gaps[gapCodes.includes(code as typeof gapCodes[number]) ? code as typeof gapCodes[number] : "OTHER"]++;
    const first = mapped.entries[0]!;
    const partial = readInterrupted(first);
    if (partial) {
      mappedCount++; excludedFromReplay++; archivedPayloads.push(partial);
      if ((raw.message as { stopReason: string }).stopReason === "aborted") interrupted.aborted++; else interrupted.error++;
      if (typeof partial.content === "string" && partial.content.length) interrupted.visiblePartials++;
    } else if (first.kind === "message") { payloads.push(first.payload); archivedPayloads.push(first.payload); mappedCount++; }
    if (mapSession(single, { ...identity, requireReasoning: true }).gaps.has("REASONING_MISSING")) missingWhenReasoningRequired++;
  }
  let protocolValid = false;
  try { validateHistory(archivedPayloads); validateHistory(payloads); protocolValid = mappedCount === total; } catch { /* 仅保留布尔结果 */ }
  return { total, mapped: mappedCount, replayMessages: payloads.length, excludedFromReplay, interrupted, gaps, missingWhenReasoningRequired, protocolValid };
}
function mappingFailure(error: unknown) {
  return error instanceof ImportError && ["COMPACTION_INVALID", "SUMMARY_INVALID", "CUSTOM_MESSAGE_INVALID"].includes(error.code)
    ? error.code : "MAPPING_FAILED";
}
export function auditSource(directory: string) {
  // 使用一次完整性核验所得的同一份字节，避免检查后重新读取。
  const { receipt: r, files: bytes } = loadSource(directory);
  const session = parse(bytes.get(r.files.find(f => f.kind === "session")!.path)!);
  check(session.id === r.sessionId, "SOURCE_BINDING_MISMATCH");
  const index = json(bytes.get("sessions/sessions.json")!);
  check(typeof index === "object" && index !== null && !Array.isArray(index)
    && Object.keys(index).length === 1 && r.sessionKey in index, "INDEX_MAPPING_MISMATCH");
  const selected = (index as Record<string, unknown>)[r.sessionKey];
  check(typeof selected === "object" && selected !== null && "sessionId" in selected && selected.sessionId === session.id, "INDEX_MAPPING_MISMATCH");
  check(r.sourceVersion === "2026.7.1-2" || r.mode === "synthetic" && r.sourceVersion === null, "SOURCE_VERSION_UNSUPPORTED");

  const identity: Identity = { sourceId: r.sourceId, agentId: r.agentId, requireReasoning: false };
  const compactions = { total: 0, invalidKeep: 0, keepAtStart: 0, invalidSummary: 0, invalidTokens: 0, summaryOverLimit: 0 };
  for (const e of session.entries) {
    if (e.type !== "compaction") continue;
    compactions.total++;
    const keep = chain(session, e.parentId).findIndex(a => a.id === e.firstKeptEntryId);
    if (keep < 0) compactions.invalidKeep++;
    if (keep === 0) compactions.keepAtStart++;
    if (typeof e.summary !== "string" || !e.summary.trim()) compactions.invalidSummary++;
    if (typeof e.summary === "string" && e.summary.length > 32768) compactions.summaryOverLimit++;
    if (!Number.isSafeInteger(e.tokensBefore) || Number(e.tokensBefore) < 0) compactions.invalidTokens++;
  }

  const archiveMessages = messages(session, session.entries, identity);
  let mappingStatus = "mapped";
  let mapped: ReturnType<typeof mapSession> | undefined;
  try { mapped = mapSession(session, identity); } catch (error) { mappingStatus = mappingFailure(error); }
  const mappingGaps = mapped ? [...mapped.gaps].map(code => gapCodes.includes(code as typeof gapCodes[number]) ? code : "OTHER").sort() : [];

  const parents = new Set(session.entries.map(e => e.parentId).filter((v): v is string => v !== null));
  const leaves = session.entries.filter(e => !parents.has(e.id));
  // 唯一结构叶只用于定位兼容诊断，不等价于源运行时已选择该叶。
  const candidateLeaf = leaves.length === 1 ? leaves[0] : undefined;
  const candidateChain = candidateLeaf ? chain(session, candidateLeaf.id) : [];
  const latest = candidateChain.findLast(e => e.type === "compaction");
  const keep = latest ? candidateChain.findIndex(e => e.id === latest.firstKeptEntryId) : 0;
  const tail = candidateLeaf && keep >= 0 ? messages(session, candidateChain.slice(keep), identity) : null;
  let contextStatus = "not_assessed";
  if (mapped && candidateLeaf) {
    try { resolveContext(mapped.entries, uid(r.sourceId, r.agentId, session.id, candidateLeaf.id)); contextStatus = "valid"; }
    catch { contextStatus = "CONTEXT_OR_PROTOCOL_INVALID"; }
  }
  return {
    ok: true, format: "kuinest-source-audit-v1", byteIntegrity: "verified", records: session.entries.length,
    archiveMessages, compactions, mappingStatus, mappingGaps,
    candidate: {
      uniqueStructuralLeaf: !!candidateLeaf, coversAllEntries: !!candidateLeaf && candidateChain.length === session.entries.length,
      selectionVerified: false, persistedDefault: persistedSelection(session, r.sourceVersion), latestSummaryOverLimit: !!latest && typeof latest.summary === "string" && latest.summary.length > 32768,
      tailMessages: tail, contextStatus
    },
    remaining: {
      unsupportedMemoryEntries: r.unsupportedMemoryEntries, unmappedArchiveCount: r.unmappedArchiveCount,
      historyCoverage: "current-session-only", profileVerified: false, userAcceptance: "pending"
    },
    readyForApply: false, applied: false
  };
}
