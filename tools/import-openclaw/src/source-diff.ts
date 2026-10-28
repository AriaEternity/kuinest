import { loadSource } from "./source-receive.js";
import { parse } from "./parse.js";
import { check, json, object } from "./safe.js";
import type { ReceiptFile } from "./source-receive.js";
function snapshot(directory: string) {
  const source = loadSource(directory), r = source.receipt;
  const bytes = source.files.get(r.files.find(f => f.kind === "session")!.path)!;
  const session = parse(bytes), index = json(source.files.get("sessions/sessions.json")!);
  check(session.id === r.sessionId, "SOURCE_BINDING_MISMATCH");
  const selected = object(index) ? index[r.sessionKey] : undefined;
  check(object(index) && Object.keys(index).length === 1 && object(selected) && selected.sessionId === session.id, "INDEX_MAPPING_MISMATCH");
  return { ...source, bytes, session };
}
const byKind = (files: ReceiptFile[]) => Object.fromEntries(["document", "memory", "session", "index"].map(kind => [kind, files.filter(f => f.kind === kind).length]));
export function diffSource(beforeDirectory: string, afterDirectory: string) {
  const before = snapshot(beforeDirectory), after = snapshot(afterDirectory), a = before.receipt, b = after.receipt;
  check(a.sourceId === b.sourceId && a.mode === b.mode && a.agentId === b.agentId && a.sessionKey === b.sessionKey, "SOURCE_BINDING_MISMATCH");
  const older = new Map(a.files.map(f => [f.path, f])), newer = new Map(b.files.map(f => [f.path, f]));
  const added = b.files.filter(f => !older.has(f.path)), removed = a.files.filter(f => !newer.has(f.path));
  const changed = b.files.filter(f => older.has(f.path) && older.get(f.path)!.sha256 !== f.sha256);
  const sameSession = before.session.id === after.session.id, reviewCodes: string[] = [];
  if (a.sourceVersion !== b.sourceVersion) reviewCodes.push("SOURCE_VERSION_CHANGED");
  if (b.capturedAt < a.capturedAt) reviewCodes.push("SOURCE_ORDER_REVERSED");
  if (a.batchId === b.batchId && before.receiptHash !== after.receiptHash) reviewCodes.push("BATCH_ID_REUSED");
  if (removed.length) reviewCodes.push("SOURCE_FILE_REMOVED");
  let records: { before: number; after: number; retained: number; added: number; removed: number; rewritten: number; bytePrefixPreserved: boolean } | null = null;
  if (sameSession) {
    let retained = 0, absent = 0, rewritten = 0, extra = 0;
    for (const [id, oldHash] of before.session.rawHashes) {
      const next = after.session.rawHashes.get(id);
      if (next === undefined) absent++; else if (next !== oldHash) rewritten++; else retained++;
    }
    for (const id of after.session.rawHashes.keys()) if (!before.session.rawHashes.has(id)) extra++;
    const bytePrefixPreserved = after.bytes.length >= before.bytes.length && after.bytes.subarray(0, before.bytes.length).equals(before.bytes);
    records = { before: before.session.entries.length, after: after.session.entries.length, retained, added: extra, removed: absent, rewritten, bytePrefixPreserved };
    if (!bytePrefixPreserved || absent || rewritten) reviewCodes.push("SOURCE_REWRITTEN");
  } else reviewCodes.push("SESSION_ROTATED_MAPPING_REQUIRED");
  // 仅检查两份源副本的身份和字节关系；不批准语义兼容或候选库应用。
  return { ok: true, format: "kuinest-source-diff-v1", byteIntegrity: "verified", sameSource: true, sameSession,
    files: { added: byKind(added), changed: byKind(changed), removed: byKind(removed) }, records,
    reviewCodes, structuralDeltaValid: reviewCodes.length === 0, compatibilityVerified: false, needsMigrationManifest: true, applied: false };
}
