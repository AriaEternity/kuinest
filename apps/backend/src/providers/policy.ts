import type { ProviderAdapter, ProviderRequest } from "../ports.js";
import { RunFailure } from "../conversations/types.js";

export type ThinkingMode = "enabled" | "disabled" | "provider-default";
export type ReasoningEffort = "low" | "high" | "max";
export interface ThinkingOptions { thinking?: ThinkingMode; reasoning_effort?: ReasoningEffort; }
export type ThinkingPolicy = Readonly<{ thinking: ThinkingMode; reasoning_effort?: ReasoningEffort }>;

// 未配置时保留既有基线；交由服务商处理是单独的传输选择，不能称为关闭思考。
export function thinkingPolicy(options: Readonly<Record<string, unknown>>): ThinkingPolicy {
  const thinking = options.thinking ?? "enabled", effort = options.reasoning_effort;
  if (!["enabled", "disabled", "provider-default"].includes(thinking as string)
    || options.thinking === null || effort === null
    || (effort !== undefined && !["low", "high", "max"].includes(effort as string))
    || thinking !== "enabled" && effort !== undefined) throw new RunFailure("PROFILE_INVALID");
  return Object.freeze({ thinking: thinking as ThinkingMode, ...(thinking === "enabled" ? { reasoning_effort: (effort ?? "high") as ReasoningEffort } : {}) });
}

// 适配器描述来自固定服务器profile；编译请求只能与之相符，不能覆盖它。
// 较小的输出预算可收紧请求，不能提高profile上限；归档与实际发送使用同一结果。
export function boundOptions(options: ProviderRequest["options"], description: ProviderAdapter["description"]) {
  const policy = thinkingPolicy(description ? { ...description } : {});
  if (["thinking", "reasoning_effort"].some(k => Object.hasOwn(options, k))) {
    const requested = thinkingPolicy({ ...policy, ...Object.fromEntries(["thinking", "reasoning_effort"].filter(k => Object.hasOwn(options, k)).map(k => [k, options[k]])) });
    if (requested.thinking !== policy.thinking || requested.reasoning_effort !== policy.reasoning_effort) throw new RunFailure("PROFILE_INVALID");
  }
  if (description && (options.provider !== undefined && options.provider !== description.provider
    || options.model !== undefined && options.model !== description.model)) throw new RunFailure("PROFILE_INVALID");
  if (options.imageInput !== undefined && (typeof options.imageInput !== "boolean" || options.imageInput !== (description?.imageInput ?? false))) throw new RunFailure("PROFILE_INVALID");
  const cap = description?.maxTokens ?? 32768;
  const maxTokens = options.maxTokens ?? cap;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 32768 || !Number.isSafeInteger(maxTokens)
    || Number(maxTokens) < 1 || Number(maxTokens) > cap) throw new RunFailure("PROFILE_INVALID");
  return Object.freeze({
    ...(description?.imageInput ? { imageInput: true } : {}),
    mode: options.mode, provider: description?.provider ?? "synthetic-injected",
    ...(description ? { model: description.model } : {}), ...policy,
    maxTokens: options.purpose === "compaction" ? Math.min(8192, Number(maxTokens)) : Number(maxTokens),
    ...Object.fromEntries(["snapshotId", "purpose", "sourceEntryIds"].filter(k => Object.hasOwn(options, k)).map(k => [k, options[k]])),
  });
}
