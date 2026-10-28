import type { AssistantMessage } from "../../../apps/backend/dist/providers/types.js";
import type { Entry } from "../../../apps/backend/dist/context/types.js";
import { readMessage } from "../../../apps/backend/dist/providers/messages.js";
import { object } from "./safe.js";

// 固定版本completions与responses均经同一请求变换排除error/aborted；原档与公开partial另行保留。
// 先只支持文本/思考且没有工具的明确子集，不能用排除规则掩盖未知多模态或工具配对问题。
export function excludeInterrupted(value: unknown): value is Record<string, unknown> & { stopReason: "error" | "aborted"; api: "openai-completions" | "openai-responses" } {
  if (!object(value) || value.role !== "assistant" || !["openai-completions", "openai-responses"].includes(String(value.api))
    || (value.stopReason !== "error" && value.stopReason !== "aborted") || value.tool_calls !== undefined) return false;
  return value.content === null || typeof value.content === "string" || Array.isArray(value.content)
    && value.content.every(b => object(b) && (b.type === "text" || b.type === "thinking"));
}
export function interruptedPayload(message: AssistantMessage, stopReason: "error" | "aborted", sourceApi: "openai-completions" | "openai-responses") {
  return { sourceType: "openclaw-incomplete-assistant", sourceApi, stopReason, replay: "excluded", message };
}
export function readInterrupted(entry: Entry): AssistantMessage | undefined {
  const p = entry.payload;
  if (entry.kind !== "custom" || !object(p) || p.sourceType !== "openclaw-incomplete-assistant"
    || !["openai-completions", "openai-responses"].includes(String(p.sourceApi)) || p.replay !== "excluded" || !["error", "aborted"].includes(String(p.stopReason))
    || Object.keys(p).some(k => !["sourceType", "sourceApi", "stopReason", "replay", "message"].includes(k))) return;
  const message = readMessage(p.message);
  return message.role === "assistant" && message.tool_calls === undefined ? message : undefined;
}
