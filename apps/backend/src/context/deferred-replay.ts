import { object, readMessage } from "../providers/messages.js";
import type { ProtocolMessage } from "../providers/types.js";
import type { Entry } from "./types.js";
import { RunFailure } from "../conversations/types.js";

export const deferredReplayType = "openclaw-deferred-replay-v1";
export const deferredReplayCodes = ["CROSS_MODEL_REPLAY_REVIEW", "REASONING_MISSING"] as const;
// 这是保留历史、禁止回放的标记。读取它只能恢复原可见消息/验证配对，不能取得可发送历史。
export function readDeferredReplay(entry: Entry): ProtocolMessage | undefined {
  const p = entry.payload;
  if (entry.kind !== "custom" || !object(p) || typeof p.sourceType !== "string" || !p.sourceType.startsWith("openclaw-deferred-replay")) return;
  if (p.sourceType !== deferredReplayType || Object.keys(p).some(k => !["sourceType", "replay", "reviewCodes", "profileSha256", "message"].includes(k))
    || p.replay !== "blocked" || typeof p.profileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.profileSha256)
    || !Array.isArray(p.reviewCodes) || p.reviewCodes.length === 0
    || p.reviewCodes.some(c => !deferredReplayCodes.includes(c as typeof deferredReplayCodes[number]))
    || new Set(p.reviewCodes).size !== p.reviewCodes.length) throw new RunFailure("CONTEXT_INVALID");
  const message = readMessage(p.message);
  if (message.role !== "assistant") throw new RunFailure("CONTEXT_INVALID");
  return structuredClone(message);
}
