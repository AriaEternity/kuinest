import { createHash } from "node:crypto";
import { RunFailure } from "../conversations/types.js";
import { object } from "../providers/messages.js";
import { validateProfile } from "../providers/deepseek.js";
import { thinkingPolicy } from "../providers/policy.js";
import type { CharacterConfig, Document, Profile } from "./types.js";
export const documentNames = ["IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"];
export const additionDocumentNames = ["USER.addendum.md", "MEMORY.addendum.md"];
export const expressionDocumentName = "EXPRESSION.md";
const supportedDocument = (name: string) => documentNames.includes(name) || additionDocumentNames.includes(name) || name === expressionDocumentName;
export const defaults: CharacterConfig = { compiler: "kuinest-v1", timezone: "UTC", memoryAppendKeys: [], memoryReplaceEnabled: false, memoryReviewEnabled: false, expressionEnabled: false, expressionMode: "reference", documentOrder: ["IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"], memoryReadKeys: ["MEMORY.md"], memoryWriteKeys: ["MEMORY.md"], fileChars: 80000, totalChars: 120000, windowTokens: 1000000, reserveTokens: 20000 };
export function invalid(): never { throw new RunFailure("PROFILE_INVALID"); }
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function validText(value: unknown): value is string { return typeof value === "string" && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
export function memoryName(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_\p{Script=Han}-]{1,80}\.md$/u.test(value)) return false;
  // 原样保留中文名称，不做转写/NFC变换；拒绝Windows保留设备名以便安全跨平台收件。
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\.md$/i.test(value);
}
export function memoryKey(value: unknown): value is string {
  return typeof value === "string" && (value === "MEMORY.md" || value.startsWith("memory/") && memoryName(value.slice(7)));
}
export function config(value: unknown, synthetic = false): CharacterConfig {
  if (synthetic && object(value) && value.kind === "synthetic-binding" && value.stage === 3 && Object.keys(value).length === 2) return structuredClone(defaults);
  if (!object(value) || Object.keys(value).some(k => !Object.hasOwn(defaults, k))) return invalid();
  const c = { ...structuredClone(defaults), ...value } as CharacterConfig;
  if (c.compiler !== "kuinest-v1") return invalid();
  for (const [key, max] of [["fileChars", 80000], ["totalChars", 120000], ["windowTokens", 1000000], ["reserveTokens", 1000000]] as const)
    if (!Number.isSafeInteger(c[key]) || c[key] < 1 || c[key] > max) return invalid();
  for (const key of ["documentOrder", "memoryReadKeys", "memoryWriteKeys", "memoryAppendKeys"] as const) {
    if (!Array.isArray(c[key]) || c[key].length > 200 || new Set(c[key]).size !== c[key].length || c[key].some(v => key === "documentOrder" ? !supportedDocument(v) : !memoryKey(v))) return invalid();
  }
  // 独立提示语显式启用；存储顺序仍置于资料后，实际装配用途由固定模式决定。
  if (typeof c.expressionEnabled !== "boolean" || c.expressionEnabled !== c.documentOrder.includes(expressionDocumentName)) return invalid();
  if (c.expressionEnabled && (c.documentOrder.at(-1) !== expressionDocumentName || documentNames.some(n => !c.documentOrder.includes(n)))) return invalid();
  if (!["reference", "project-instructions"].includes(c.expressionMode) || !c.expressionEnabled && c.expressionMode !== "reference") return invalid();
  // 附加层紧随对应基线，不能重命名为SOUL或绕过基线独立加载。
  for (const name of additionDocumentNames) {
    const index = c.documentOrder.indexOf(name);
    if (index >= 0 && (index === 0 || c.documentOrder[index - 1] !== name.replace(".addendum", ""))) return invalid();
  }
  try { if (typeof c.timezone !== "string" || c.timezone.length > 80) return invalid(); new Intl.DateTimeFormat("en", { timeZone: c.timezone }).format(0); } catch { return invalid(); }
  if (typeof c.memoryReplaceEnabled !== "boolean" || c.memoryAppendKeys.some(k => !k.startsWith("memory/") || !c.memoryWriteKeys.includes(k))) return invalid();
  if (c.memoryWriteKeys.some(k => !c.memoryReadKeys.includes(k))) return invalid();
  if (typeof c.memoryReviewEnabled !== "boolean" || c.memoryReviewEnabled && (c.memoryWriteKeys.length || c.memoryAppendKeys.length || c.memoryReplaceEnabled)) return invalid();
  return c;
}
export function profile(value: Profile): Profile {
  if (!["synthetic", "unverified"].includes(value.status) || !["mock", "deepseek"].includes(value.provider)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.model) || !object(value.options)
    || Object.keys(value.options).some(k => !["maxTokens", "allowedOrigin", "thinking", "reasoning_effort", "imageInput", "wireFormat"].includes(k))) return invalid();
  if (value.options.imageInput !== undefined && typeof value.options.imageInput !== "boolean") return invalid();
  if (value.options.wireFormat !== undefined && !["deepseek", "mimo"].includes(value.options.wireFormat as string)
    || value.options.wireFormat === "mimo" && value.options.thinking !== "provider-default") return invalid();
  const policy = thinkingPolicy(value.options);
  const max = value.options.maxTokens ?? 32768;
  if (!Number.isSafeInteger(max) || Number(max) < 1 || Number(max) > 32768) return invalid();
  if (value.provider === "mock") { if (value.endpoint !== null || value.status !== "synthetic") return invalid(); }
  else {
    try { validateProfile({ mode: value.status === "synthetic" ? "synthetic" : "private", endpoint: value.endpoint!, allowedOrigin: String(value.options.allowedOrigin ?? ""), model: value.model, maxTokens: Number(max), ...(value.options.imageInput !== undefined ? { imageInput: value.options.imageInput as boolean } : {}), ...policy, ...(value.options.wireFormat === undefined ? {} : { wireFormat: value.options.wireFormat as "deepseek" | "mimo" }) }); } catch { return invalid(); }
  }
  return structuredClone(value);
}
export function decodeDocument(doc: Document): string {
  if (!supportedDocument(doc.name) || hash(doc.bytes) !== doc.sha256 || doc.bytes.byteLength > 4 * 1024 * 1024) return invalid();
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(doc.bytes);
    if (doc.name === expressionDocumentName && (doc.bytes.byteLength > 65536 || !value.trim())) return invalid();
    return value;
  } catch { return invalid(); }
}
export function prefix(value: string, units: number): string {
  let result = value.slice(0, Math.max(0, units));
  if (result && /[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result;
}
export function documents(input: Document[], c: CharacterConfig) {
  if (new Set(input.map(d => d.name)).size !== input.length || input.some(d => !c.documentOrder.includes(d.name))) return invalid();
  if (additionDocumentNames.some(name => c.documentOrder.includes(name) && (!input.some(d => d.name === name) || !input.some(d => d.name === name.replace(".addendum", ""))))) return invalid();
  if (c.expressionEnabled && [...documentNames, expressionDocumentName].some(name => !input.some(d => d.name === name))) return invalid();
  let left = c.totalChars;
  const selected = c.documentOrder.flatMap(name => {
    const doc = input.find(d => d.name === name); if (!doc) return [];
    const full = decodeDocument(doc), text = prefix(full, Math.min(c.fileChars, left)); left -= text.length;
    return [{ name, text, sha256: doc.sha256, originalUnits: full.length, selectedUnits: text.length, truncated: text.length !== full.length }];
  });
  // 表达层不能挤掉原资料，也不能悄悄只加载半份提示语。
  if (c.expressionEnabled && selected.some(d => d.truncated)) throw new RunFailure("CONTEXT_TOO_LARGE");
  return selected;
}
