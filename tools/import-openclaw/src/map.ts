import { deferredReplayType, deferredReplayCodes } from "../../../apps/backend/dist/context/deferred-replay.js";
import { bindReplay, replaySourceMatches, type BoundReplay } from "./replay.js";
import { imageKey, type ImagePreparation } from "./images.js";
import type { ContentPart } from "../../../apps/backend/dist/images/content.js";
import { excludeInterrupted, interruptedPayload } from "./interrupted.js";
import { readMessage } from "../../../apps/backend/dist/providers/messages.js";
import type { ProtocolMessage } from "../../../apps/backend/dist/providers/types.js";
import type { Entry } from "../../../apps/backend/dist/context/types.js";
import type { Session, Mapped, Scope, RawEntry } from "./types.js";
import { chain } from "./parse.js";
import { check, object, uid } from "./safe.js";
function message(value: unknown, gaps: Set<string>, requireReasoning: boolean, excluded = false, prepared?: ImagePreparation, rawId?: string, replay?: BoundReplay): ProtocolMessage | undefined {
  if (!object(value)) { gaps.add("MESSAGE_FORMAT"); return; }
  const bound = value.role === "assistant" && !excluded && replay && replaySourceMatches(value, replay, gaps) ? replay : undefined;
  let content: unknown = value.content, thinking = value.reasoning_content, calls = value.tool_calls;
  if (Array.isArray(content)) {
    const blocks = content; const texts: string[] = [], thoughts: string[] = [], tools: unknown[] = [], parts: ContentPart[] = [];
    let hasImages = false;
    for (const [position, b] of blocks.entries()) {
      if (!object(b)) { gaps.add("MESSAGE_FORMAT"); continue; }
      if (b.type === "text" && typeof b.text === "string") { texts.push(b.text); parts.push({ type: "text", text: b.text }); }
      else if (b.type === "image") {
        const image = rawId === undefined ? undefined : prepared?.images.get(imageKey(rawId, position));
        if (!image) gaps.add("MULTIMODAL_UNSUPPORTED");
        else { parts.push(image.reference); hasImages = true; }
      }
      else if (b.type === "thinking" && typeof b.thinking === "string") {
        thoughts.push(b.thinking);
        if (bound && b.thinking.trim() && b.thinkingSignature !== "reasoning_content") gaps.add("REPLAY_SIGNATURE_REQUIRED");
        // 固定旧版openai-completions把reasoning_content字段名放在thinkingSignature中。
        // 仅识别这一有来源依据的字段标记；不把其他API的签名或redacted内容当作普通思考。
        if (b.redacted !== undefined && b.redacted !== false ||
          b.thinkingSignature !== undefined && !(value.api === "openai-completions" && b.thinkingSignature === "reasoning_content"))
          gaps.add("THINKING_SIGNATURE_UNSUPPORTED");
      } else if (b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string" && object(b.arguments)) {
        if (replay && b.thoughtSignature !== undefined) gaps.add("THINKING_SIGNATURE_UNSUPPORTED");
        tools.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.arguments) } });
      }
      else gaps.add(b.type === "image" ? "MULTIMODAL_UNSUPPORTED" : "CONTENT_BLOCK_UNSUPPORTED");
    }
    content = hasImages ? parts : texts.join("");
    if (thoughts.length) {
      if (thinking !== undefined || !bound && thoughts.length > 1) gaps.add("REASONING_AMBIGUOUS");
      // 有显式同模型绑定时，按固定旧版非空块的顺序用换行拼接；原始块仍在JSONL原档。
      const retained = bound ? thoughts.filter(t => t.trim().length > 0) : thoughts;
      thinking = retained.length ? retained.join(bound ? "\n" : "") : undefined;
    }
    if (tools.length) { if (calls !== undefined) gaps.add("TOOLS_AMBIGUOUS"); calls = tools; }
  }
  const role = value.role === "toolResult" ? "tool" : value.role;
  const normalized: Record<string, unknown> = { role, content };
  if (role === "tool") normalized.tool_call_id = value.role === "toolResult" ? value.toolCallId : value.tool_call_id;
  if (role === "assistant") {
    if (thinking !== undefined) normalized.reasoning_content = thinking;
    if (calls !== undefined) normalized.tool_calls = calls;
    const needsReasoning = requireReasoning || (bound ? bound.policy.thinking === "enabled" : calls !== undefined);
    if (!excluded && needsReasoning && (typeof thinking !== "string" || !thinking.length)) gaps.add("REASONING_MISSING");
    if (!excluded && (value.stopReason === "error" || value.stopReason === "aborted" || value.stopReason === "length")) gaps.add("ASSISTANT_INCOMPLETE");
  } else if (thinking !== undefined || calls !== undefined) gaps.add("MESSAGE_FORMAT");
  try { return readMessage(normalized); } catch { gaps.add("MESSAGE_FORMAT"); return; }
}
export function mapSession(session: Session, scope: Pick<Scope, "sourceId" | "agentId" | "requireReasoning"> & Partial<Pick<Scope, "profile" | "reasoningReplay">>, prepared?: ImagePreparation): Mapped {
  const gaps = new Set<string>(prepared?.gaps), branch = uid(scope.sourceId, scope.agentId, session.id, "branch");
  if (scope.reasoningReplay !== undefined) check(scope.profile, "REPLAY_POLICY_INVALID");
  const replay = scope.reasoningReplay !== undefined ? bindReplay(scope.reasoningReplay, scope.profile!) : undefined;
  const entryId = (id: string) => uid(scope.sourceId, scope.agentId, session.id, id);
  const entries: Entry[] = session.entries.map((raw: RawEntry) => {
    const base = { id: entryId(raw.id), parentId: raw.parentId ? entryId(raw.parentId) : null, branchId: branch };
    if (raw.type === "message") {
      const excluded = excludeInterrupted(raw.message);
      const localGaps = new Set<string>();
      const payload = message(raw.message, localGaps, scope.requireReasoning, excluded, prepared, raw.id, replay);
      if (replay?.declaration.deferHistoricalReplay && !excluded && payload?.role === "assistant" && localGaps.size > 0
        && [...localGaps].every(code => deferredReplayCodes.includes(code as typeof deferredReplayCodes[number]))) {
        return { ...base, kind: "custom", payload: { sourceType: deferredReplayType, replay: "blocked",
          reviewCodes: [...localGaps].sort(), profileSha256: replay.declaration.profileSha256, message: payload } };
      }
      localGaps.forEach(code => gaps.add(code));
      if (excluded && payload?.role === "assistant")
        return { ...base, kind: "custom", payload: interruptedPayload(payload, (raw.message as { stopReason: "error" | "aborted" }).stopReason, (raw.message as { api: "openai-completions" | "openai-responses" }).api) };
      return { ...base, kind: payload ? "message" : "unknown", payload: payload ?? { sourceType: "message" } };
    }
    if (raw.type === "compaction") {
      const ancestors = chain(session, raw.parentId), keep = ancestors.findIndex(e => e.id === raw.firstKeptEntryId);
      check(typeof raw.summary === "string" && raw.summary.length > 0 && keep > 0 && Number.isSafeInteger(raw.tokensBefore) && Number(raw.tokensBefore) >= 0, "COMPACTION_INVALID");
      return { ...base, kind: "compaction", payload: { summary: raw.summary, firstKeptEntryId: entryId(ancestors[keep]!.id), sourceIds: ancestors.slice(0, keep).map(e => entryId(e.id)), tokensBefore: raw.tokensBefore } };
    }
    if (raw.type === "branch_summary") {
      check(typeof raw.summary === "string", "SUMMARY_INVALID");
      return { ...base, kind: "branch_summary", payload: { text: raw.summary } };
    }
    if (raw.type === "custom_message") {
      const content = raw.content;
      check(typeof content === "string" || Array.isArray(content), "CUSTOM_MESSAGE_INVALID");
      let text: string;
      if (typeof content === "string") text = content;
      else {
        const normalized = message({ role: "user", content }, gaps, false);
        text = typeof normalized?.content === "string" ? normalized.content : "";
      }
      // display仅控制旧UI，不能拿它关闭模型上下文。
      return { ...base, kind: "custom_message", payload: { text, includeInContext: true } };
    }
    if (["custom", "model_change", "thinking_level_change", "session_info", "label"].includes(raw.type))
      return { ...base, kind: "custom", payload: { sourceType: raw.type } };
    gaps.add("UNKNOWN_ENTRY");
    return { ...base, kind: "unknown", payload: { sourceType: "unrecognized" } };
  });
  return { session, entries, images: [...prepared?.images.values() ?? []], gaps };
}
