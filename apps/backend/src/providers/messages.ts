import { readContent } from "../images/content.js";
import { RunFailure } from "../conversations/types.js";
import type { ProtocolMessage, ToolCall } from "./types.js";
const invalid = (): never => { throw new RunFailure("PROTOCOL_HISTORY_INCOMPLETE"); };
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
export function readTool(value: unknown): ToolCall {
  if (!object(value) || !keys(value, ["id", "type", "function"]) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value.id)
    || value.type !== "function" || !object(value.function) || !keys(value.function, ["name", "arguments"])
    || typeof value.function.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.function.name) || typeof value.function.arguments !== "string") return invalid();
  return value as ToolCall;
}
export function readMessage(value: unknown): ProtocolMessage {
  if (!object(value)) return invalid();
  if (value.role === "user" && keys(value, ["role", "content"]) ){ readContent(value.content); return value as ProtocolMessage; }
  if (value.role === "tool" && keys(value, ["role", "tool_call_id", "content"]) && typeof value.tool_call_id === "string") { readContent(value.content); return value as ProtocolMessage; }
  if (value.role !== "assistant" || !keys(value, ["role", "content", "reasoning_content", "tool_calls"])
    || !(value.content === null || typeof value.content === "string")
    || (value.reasoning_content !== undefined && typeof value.reasoning_content !== "string")) return invalid();
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls) || !value.tool_calls.length || value.tool_calls.length > 8) return invalid();
    value.tool_calls.forEach(readTool);
  }
  return value as ProtocolMessage;
}
export function validateHistory(values: readonly unknown[]): ProtocolMessage[] {
  const messages = values.map(value => structuredClone(readMessage(value)));
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") { if (!pending.delete(message.tool_call_id)) return invalid(); }
    else {
      if (pending.size) return invalid();
      if (message.role === "assistant" && message.tool_calls) {
        pending = new Set(message.tool_calls.map(call => call.id));
        if (pending.size !== message.tool_calls.length) return invalid();
      }
    }
  }
  if (pending.size) return invalid();
  return messages;
}
