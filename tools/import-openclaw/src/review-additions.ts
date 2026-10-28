import { additionDocumentNames, config } from "../../../apps/backend/dist/context/profile.js";
import { check, hex, object } from "./safe.js";
import type { Scope, Manifest } from "./types.js";

// 只接受独立且已冻结的增补声明；REVIEW-MANIFEST本身不是导入格式。
export function validateReviewedAdditions(value: Record<string, unknown>, sealed: boolean): void {
  const m = value as unknown as Manifest, r = value.reviewedAdditions;
  if (r === undefined) {
    check(!m.files.some(f => f.kind === "addition") && !config(m.config).documentOrder.some(n => additionDocumentNames.includes(n)), "REVIEW_REQUIRED"); return;
  }
  check(m.migrationMode === "fresh-start-v1" && !(m.removedMemories?.length), "REVIEW_POLICY");
  check(object(r) && Object.keys(r).every(k => ["reviewSha256","rollbackSha256","baselineReceiptSha256","baseline","files"].includes(k))
    && hex(r.reviewSha256) && hex(r.rollbackSha256) && hex(r.baselineReceiptSha256) && Array.isArray(r.baseline) && Array.isArray(r.files) && r.files.length === 3, "REVIEW_INVALID");
  const paths = new Set<string>(), roles = new Set<string>();
  for (const f of r.files) {
    check(object(f) && Object.keys(f).every(k => ["path","sha256","role"].includes(k)) && typeof f.path === "string" && hex(f.sha256)
      && ["USER","MEMORY","memory"].includes(String(f.role)) && !roles.has(String(f.role)) && !paths.has(f.path), "REVIEW_INVALID");
    const actual = m.files.find(item => item.path === f.path);
    check(actual && (f.role === "memory" ? actual.kind === "memory" : actual.kind === "addition" && f.path === "workspace/" + f.role + ".addendum.md"), "REVIEW_TARGET");
    check(!sealed || actual.sha256 === f.sha256, "REVIEW_HASH_MISMATCH"); paths.add(f.path); roles.add(String(f.role));
  }
  const baselinePaths = new Set<string>();
  for (const f of r.baseline) {
    check(object(f) && Object.keys(f).every(k => ["path","sha256"].includes(k)) && typeof f.path === "string" && hex(f.sha256) && !paths.has(f.path) && !baselinePaths.has(f.path), "REVIEW_BASELINE_INVALID");
    const actual = m.files.find(item => item.path === f.path);
    check(actual && ["document","memory"].includes(actual.kind) && (!sealed || actual.sha256 === f.sha256), "REVIEW_BASELINE_INVALID"); baselinePaths.add(f.path);
  }
  check(m.files.filter(f => ["document","memory","addition"].includes(f.kind)).every(f => paths.has(f.path) || baselinePaths.has(f.path)), "REVIEW_COVERAGE");
  const c = config(m.config);
  check(additionDocumentNames.every(name => c.documentOrder.includes(name)) && r.files.every(f => (f as {role:string}).role !== "memory" || c.memoryReadKeys.includes((f as {path:string}).path.slice(10))), "REVIEW_NOT_READABLE");
}
