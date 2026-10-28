import { object } from "../providers/messages.js";
import { validText } from "../context/profile.js";
export class TaskError extends Error { constructor(readonly code: "TASK_INVALID" | "TASK_REVISION_CONFLICT") { super("主动任务配置无效或版本已变化。"); } }
export type TaskDefinition = { documentVersionId: string; documentName: "HEARTBEAT.md"; allowWebSearch: boolean; allowMemoryWrite: boolean; silenceMarkers: string[]; delivery: "web" };
export type TaskInput = { conversationId: string; intervalSeconds: number; timezone: string; definition: TaskDefinition; nextDueAt: number };
export function definition(value: unknown): TaskDefinition {
  if (!object(value) || Object.keys(value).some(k => !["documentVersionId","documentName","allowWebSearch","allowMemoryWrite","silenceMarkers","delivery"].includes(k))
    || typeof value.documentVersionId !== "string" || !value.documentVersionId || value.documentVersionId.length > 256
    || value.documentName !== "HEARTBEAT.md" || value.delivery !== "web" || typeof value.allowWebSearch !== "boolean" || typeof value.allowMemoryWrite !== "boolean"
    || !Array.isArray(value.silenceMarkers) || value.silenceMarkers.length > 8 || value.silenceMarkers.some(s => !validText(s) || !s.trim() || s !== s.trim() || s.length > 100)
    || new Set(value.silenceMarkers).size !== value.silenceMarkers.length) throw new TaskError("TASK_INVALID");
  return structuredClone(value) as TaskDefinition;
}
export function validateTask(input: TaskInput): void {
  if (!Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds < 60 || input.intervalSeconds > 31536000
    || !Number.isSafeInteger(input.nextDueAt) || input.nextDueAt < 0 || input.nextDueAt > 8640000000000000
    || typeof input.timezone !== "string" || input.timezone.length > 80) throw new TaskError("TASK_INVALID");
  try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(0); } catch { throw new TaskError("TASK_INVALID"); }
  definition(input.definition);
}
export type HeartbeatInput = { taskId: string; revision: number; dueAt: number; timezone: string; definition: TaskDefinition };
export function heartbeatInput(raw: string): HeartbeatInput {
  const input: unknown = JSON.parse(raw);
  if (!object(input) || Object.keys(input).some(k => !["taskId","revision","dueAt","timezone","definition"].includes(k)) || typeof input.taskId !== "string" || !input.taskId
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || !Number.isSafeInteger(input.dueAt) || Number(input.dueAt) < 0 || typeof input.timezone !== "string") throw new TaskError("TASK_INVALID");
  const d = definition(input.definition);
  validateTask({ conversationId: "", intervalSeconds: 60, timezone: input.timezone, nextDueAt: Number(input.dueAt), definition: d });
  return { taskId: input.taskId, revision: Number(input.revision), dueAt: Number(input.dueAt), timezone: input.timezone, definition: d };
}
