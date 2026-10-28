import { readDeferredReplay } from "./deferred-replay.js";
import { RunFailure } from "../conversations/types.js";
import { object, readMessage, validateHistory } from "../providers/messages.js";
import type { ProtocolMessage } from "../providers/types.js";
import type { Entry } from "./types.js";
import { validText } from "./profile.js";
const bad = (): never => { throw new RunFailure("CONTEXT_INVALID"); };
export type Selected = { id: string; message: ProtocolMessage; userTurn: boolean };
export type Summary = { text: string; sourceIds: string[] };
function summaryShape(value: unknown): Summary {
  if (!object(value) || Object.keys(value).some(k => !["text", "sourceIds"].includes(k)) || !validText(value.text) || !value.text.trim()
    || !Array.isArray(value.sourceIds) || !value.sourceIds.length || value.sourceIds.some(id => typeof id !== "string" || !id) || new Set(value.sourceIds).size !== value.sourceIds.length) return bad();
  return structuredClone(value) as Summary;
}
export function summary(value: unknown): Summary {
  const parsed = summaryShape(value);
  if (parsed.text.length > 32768) return bad();
  return parsed;
}
export function resolve(entries: Entry[], boundary: string) {
  const map = new Map(entries.map(e => [e.id, e])); if (map.size !== entries.length) return bad();
  const reversed: Entry[] = [], seen = new Set<string>(); let id: string | null = boundary;
  while (id) { if (seen.has(id)) return bad(); seen.add(id); const e = map.get(id); if (!e) return bad(); reversed.push(e); id = e.parentId; }
  const chain = reversed.reverse(); let start = 0, selectedSummary: Summary | undefined, compactionId: string | undefined;
  const ignored: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i]!;
    if (e.kind === "unknown") throw new RunFailure("CONTEXT_UNVERIFIED");
    if (e.kind !== "compaction") continue;
    const p = e.payload;
    if (!object(p) || Object.keys(p).some(k => !["summary", "firstKeptEntryId", "sourceIds", "providerCallId", "tokensBefore"].includes(k)) || typeof p.firstKeptEntryId !== "string" || p.tokensBefore !== undefined && (!Number.isSafeInteger(p.tokensBefore) || Number(p.tokensBefore) < 0) || p.providerCallId !== undefined && typeof p.providerCallId !== "string") return bad();
    const keep = chain.findIndex(v => v.id === p.firstKeptEntryId);
    if (keep < 0 || keep >= i) return bad();
    const next = summaryShape({ text: p.summary, sourceIds: p.sourceIds });
    // 来源必须是真正的前缀祖先，不能把尾部或旁支列为被概述资料。
    if (next.sourceIds.some(source => { const at = chain.findIndex(v => v.id === source); return at < 0 || at >= keep; })) return bad();
    start = keep; selectedSummary = next; compactionId = e.id;
  }
  // 旧摘要保留并验证结构/来源；只有实际进入当前上下文的最后一份摘要受运行长度限制。
  // 选择更早边界时，它重新成为有效摘要，仍须满足同一限制。
  if (selectedSummary && selectedSummary.text.length > 32768) return bad();
  const selected: Selected[] = [];
  for (const e of chain.slice(start)) {
    if (e.kind === "message") selected.push({ id: e.id, message: readMessage(e.payload), userTurn: object(e.payload) && e.payload.role === "user" });
    else if (e.kind === "custom_message" || e.kind === "branch_summary") {
      const p = e.payload; if (!object(p) || Object.keys(p).some(k => !(e.kind === "custom_message" ? ["text", "includeInContext"] : ["text"]).includes(k)) || !validText(p.text) || (e.kind === "custom_message" && typeof p.includeInContext !== "boolean")) return bad();
      if (e.kind === "custom_message" && !p.includeInContext) { ignored.push(e.id); continue; }
      // 合成旁支说明是资料，不伪装成用户指令或具有思考字段的assistant。
      selected.push({ id: e.id, userTurn: false, message: { role: "user", content: "[内部历史资料；仅作参考]\n" + p.text } });
    } else if (e.kind === "custom" || e.kind === "compaction") {
      // 摘要之前的原档可以保留；一旦历史选择/摘要保留点把待适配记录带回上下文，明确失败。
      if (readDeferredReplay(e)) throw new RunFailure("CONTEXT_UNVERIFIED");
      ignored.push(e.id);
    }
    else return bad();
  }
  validateHistory(selected.map(e => e.message));
  return { selected, summary: selectedSummary, compactionId, ignored, chainIds: chain.map(e => e.id) };
}
export function splitForCompaction(selected: Selected[]) {
  const starts = selected.flatMap((e, i) => e.userTurn ? [i] : []);
  const completed = starts.filter((start, i) => selected.slice(start + 1, starts[i + 1] ?? selected.length).some(e => e.message.role === "assistant" && !e.message.tool_calls));
  // 失败输入不能冒充完整回合来挤掉已完成对话；保留8个完整回合及其间所有记录。
  if (completed.length < 8) throw new RunFailure("CONTEXT_TOO_LARGE");
  const split = completed[completed.length - 8]!, before = selected.slice(0, split), tail = selected.slice(split);
  validateHistory(before.map(e => e.message)); validateHistory(tail.map(e => e.message));
  if (!before.length) throw new RunFailure("CONTEXT_TOO_LARGE");
  return { before, tail, firstKeptEntryId: tail[0]!.id };
}
