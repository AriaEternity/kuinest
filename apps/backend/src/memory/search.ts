import type { MemoryVersion } from "../context/types.js";
import { prefix, validText } from "../context/profile.js";
import { RunFailure } from "../conversations/types.js";
import { validateMemories } from "./read.js";
export function queryTerms(query: string) {
  if (!validText(query)) throw new RunFailure("CONTEXT_INVALID");
  const phrases = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const parts = phrases.flatMap(phrase => {
    const chars = [...phrase];
    return /^\p{Script=Han}+$/u.test(phrase) && chars.length > 2
      ? [phrase, ...chars.slice(0, -1).map((char, i) => char + chars[i + 1]!)] : [phrase];
  });
  const unique = [...new Set(parts)];
  return { terms: unique.slice(0, 32), truncated: unique.length > 32 };
}
export function search(rows: MemoryVersion[], query: string, allowed: string[]) {
  validateMemories(rows);
  if (!validText(query)) throw new RunFailure("CONTEXT_INVALID");
  const { terms } = queryTerms(query);
  const candidates = rows.filter(row => allowed.includes(row.key)).flatMap(row => {
    const matches = terms.map(term => row.content.indexOf(term)).filter(at => at >= 0);
    return matches.length ? [{ row, score: matches.length, position: Math.min(...matches) }] : [];
  }).sort((a, b) => b.score - a.score || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0));
  let remaining = 8000;
  return candidates.slice(0, 5).map(({ row, score, position }) => {
    let start = Math.max(0, position - 200);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(row.content[start]!)) start--;
    const text = prefix(row.content.slice(start), Math.min(1600, remaining)); remaining -= text.length;
    return { versionId: row.id, key: row.key, start, end: start + text.length, text, score };
  });
}
