import type { MessageContent } from "../images/content.js";
import type { ThinkingOptions } from "./policy.js";
import type { Claim } from "../conversations/types.js";
import type { ProviderRequest } from "../ports.js";
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type AssistantMessage = { role: "assistant"; content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] };
export type ToolMessage = { role: "tool"; tool_call_id: string; content: MessageContent };
export type ProtocolMessage = { role: "user"; content: MessageContent } | AssistantMessage | ToolMessage;
export type Usage = { inputTokens: number; outputTokens: number; details?: Readonly<Record<string, unknown>> };
export type CallArchive = { assistant: AssistantMessage; finish_reason?: string; usage?: Usage; error?: { code: string; retryAfterSeconds?: number } };
export type CallRef = { id: string; runId: string; ordinal: number };
export interface ProtocolStorage {
  begin(claim: Claim, id: string, request: ProviderRequest, now: number, purpose?: "reply" | "compaction"): CallRef;
  checkpoint(claim: Claim, call: CallRef, archive: CallArchive, status: "started" | "completed" | "failed", now: number): void;
  beginTool(claim: Claim, call: CallRef, id: string, tool: ToolCall, now: number): { id: string; result?: ToolMessage };
  finishTool(claim: Claim, id: string, result: ToolMessage, failed: boolean, now: number): void;
}
export interface ToolExecutor {
  readonly definitions: readonly Readonly<Record<string, unknown>>[];
  invoke(tool: ToolCall, signal: AbortSignal, execution?: { toolCallId: string }): Promise<{ message: ToolMessage; failed: boolean }>;
}
export type DeepSeekProfile = ThinkingOptions & {
  mode: "synthetic" | "private"; endpoint: string; allowedOrigin: string; model: string;
  maxTokens?: number; allowLive?: boolean; imageInput?: boolean; wireFormat?: "deepseek" | "mimo";
};
