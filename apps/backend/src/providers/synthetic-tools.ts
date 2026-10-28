import type { ToolCall, ToolExecutor } from "./types.js";
import { object } from "./messages.js";
export class SyntheticTools implements ToolExecutor {
  readonly definitions = Object.freeze([
    { type: "function", function: { name: "synthetic_echo", description: "仅返回合成测试输入，没有外部操作。", parameters: { type: "object", properties: { text: { type: "string", maxLength: 1000 } }, required: ["text"], additionalProperties: false } } },
    { type: "function", function: { name: "synthetic_add", description: "仅进行合成数字加法。", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false } } },
  ]);
  constructor(readonly allowed = true) {}
  async invoke(tool: ToolCall, signal: AbortSignal) {
    signal.throwIfAborted();
    let code: string | undefined, value: unknown;
    if (!this.allowed) code = "TOOL_DENIED";
    else if (!["synthetic_echo", "synthetic_add"].includes(tool.function.name)) code = "TOOL_UNKNOWN";
    else {
      let args: unknown; try { args = JSON.parse(tool.function.arguments); } catch { code = "TOOL_ARGUMENTS_INVALID"; }
      if (!code) {
        if (tool.function.name === "synthetic_echo" && object(args) && Object.keys(args).length === 1 && typeof args.text === "string" && args.text.length <= 1000) value = args.text;
        else if (tool.function.name === "synthetic_add" && object(args) && Object.keys(args).length === 2 && typeof args.a === "number" && typeof args.b === "number" && Number.isFinite(args.a + args.b)) value = args.a + args.b;
        else code = "TOOL_ARGUMENTS_INVALID";
      }
    }
    signal.throwIfAborted();
    return { message: { role: "tool" as const, tool_call_id: tool.id, content: JSON.stringify(code ? { ok: false, error: { code, message: "合成工具请求未执行。" } } : { ok: true, value }) }, failed: !!code };
  }
}
