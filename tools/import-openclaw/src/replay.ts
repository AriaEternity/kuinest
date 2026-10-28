import type { Profile } from "../../../apps/backend/dist/context/types.js";
import { thinkingPolicy, type ThinkingPolicy } from "../../../apps/backend/dist/providers/policy.js";
import { check, hash, object, hex } from "./safe.js";

export type ReasoningReplay = {
  format: "bound-completions-v1";
  target: { api: "openai-completions"; provider: string; model: string };
  profileSha256: string;
  deferHistoricalReplay?: true;
};
export type BoundReplay = { declaration: ReasoningReplay; policy: ThinkingPolicy };
const closed = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const name = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v);

// 绑定实际请求配置；数据库分配的profile ID、验收status不参与。
// 键排序避免JSON属性顺序改变产生伪差异；既有profile白名单只允许标量options。
export function replayProfileHash(profile: Profile): string {
  return hash(JSON.stringify([profile.provider, profile.model, profile.endpoint,
    Object.keys(profile.options).sort().map(key => [key, profile.options[key]])]));
}
export function bindReplay(value: unknown, profile: Profile): BoundReplay {
  check(object(value) && closed(value, ["format", "target", "profileSha256", "deferHistoricalReplay"])
    && (value.deferHistoricalReplay === undefined || value.deferHistoricalReplay === true)
    && value.format === "bound-completions-v1" && object(value.target)
    && closed(value.target, ["api", "provider", "model"]) && value.target.api === "openai-completions"
    && name(value.target.provider) && name(value.target.model) && hex(value.profileSha256), "REPLAY_POLICY_INVALID");
  check(value.target.model === profile.model && value.profileSha256 === replayProfileHash(profile), "REPLAY_PROFILE_MISMATCH");
  let policy: ThinkingPolicy;
  try { policy = thinkingPolicy(profile.options); } catch { check(false, "REPLAY_POLICY_INVALID"); }
  return { declaration: structuredClone(value) as ReasoningReplay, policy };
}
export function replaySourceMatches(message: Record<string, unknown>, bound: BoundReplay, gaps: Set<string>): boolean {
  if (!name(message.provider) || !name(message.model) || typeof message.api !== "string") {
    gaps.add("REPLAY_SOURCE_IDENTITY_MISSING"); return false;
  }
  const target = bound.declaration.target;
  if (message.provider !== target.provider || message.api !== target.api || message.model !== target.model) {
    // 旧版跨模型可能把私有thinking投影为content。没有独立的显示/发送投影前不能照搬。
    gaps.add("CROSS_MODEL_REPLAY_REVIEW"); return false;
  }
  return true;
}
