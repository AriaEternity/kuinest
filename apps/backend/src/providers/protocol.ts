import type { ProviderEvent } from "../ports.js";
import { RunFailure } from "../conversations/types.js";
import type { AssistantMessage, CallArchive, ToolCall, Usage } from "./types.js";
import { readTool } from "./messages.js";
export class ProtocolAccumulator {
  #content = ""; #reasoning: string | undefined;
  #calls = new Map<number, { id: string; name: string; arguments: string }>();
  #finish: string | undefined; #usage: Usage | undefined;
  #bytes = 0;
  constructor(readonly limit = 16 * 1024 * 1024) {}
  add(event: ProviderEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.#bytes + bytes > this.limit) throw new RunFailure("OUTPUT_LIMIT");
    if (event.type === "error") throw new RunFailure("UPSTREAM_UNAVAILABLE");
    if (event.type === "usage") {
      if (this.#usage || !Number.isSafeInteger(event.inputTokens) || !Number.isSafeInteger(event.outputTokens) || event.inputTokens < 0 || event.outputTokens < 0) throw new RunFailure("UPSTREAM_INCOMPLETE");
      this.#usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, ...(event.details ? { details: structuredClone(event.details) } : {}) };
    } else if (event.type === "finish") {
      if (this.#finish) throw new RunFailure("UPSTREAM_INCOMPLETE");
      this.#finish = event.reason;
    } else {
      if (this.#finish) throw new RunFailure("UPSTREAM_INCOMPLETE");
      if (event.type === "text_delta" || event.type === "reasoning_delta") {
        if (typeof event.text !== "string" || [...event.text].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })) throw new RunFailure("UPSTREAM_INCOMPLETE");
        if (event.type === "text_delta") this.#content += event.text;
        else this.#reasoning = (this.#reasoning ?? "") + event.text;
      } else if (event.type === "tool_call_delta") {
        if (!Number.isSafeInteger(event.index) || event.index < 0 || event.index >= 8) throw new RunFailure("TOOL_LIMIT");
        const call = this.#calls.get(event.index) ?? { id: "", name: "", arguments: "" };
        for (const name of ["id", "name", "arguments"] as const) if (event[name] !== undefined) {
          if (typeof event[name] !== "string") throw new RunFailure("UPSTREAM_INCOMPLETE");
          call[name] += event[name];
        }
        if (call.id.length > 256 || call.name.length > 128) throw new RunFailure("UPSTREAM_INCOMPLETE");
        this.#calls.set(event.index, call);
      }
    }
    this.#bytes += bytes;
  }
  snapshot(): CallArchive {
    const assistant: AssistantMessage = { role: "assistant", content: this.#content,
      ...(this.#reasoning !== undefined ? { reasoning_content: this.#reasoning } : {}) };
    if (this.#calls.size) assistant.tool_calls = [...this.#calls].sort(([a], [b]) => a - b).map(([, value]) => ({ id: value.id, type: "function", function: { name: value.name, arguments: value.arguments } }));
    return { assistant, ...(this.#finish ? { finish_reason: this.#finish } : {}), ...(this.#usage ? { usage: structuredClone(this.#usage) } : {}) };
  }
  close(): CallArchive {
    if (this.#finish === "length") throw new RunFailure("OUTPUT_LIMIT");
    if (["content_filter", "refusal"].includes(this.#finish ?? "")) throw new RunFailure("UPSTREAM_REFUSED");
    if (this.#finish !== "stop" && this.#finish !== "tool_calls") throw new RunFailure("UPSTREAM_INCOMPLETE");
    if (this.#finish === "stop" && this.#calls.size || this.#finish === "tool_calls" && !this.#calls.size) throw new RunFailure("UPSTREAM_INCOMPLETE");
    const snapshot = this.snapshot(), calls = snapshot.assistant.tool_calls ?? [];
    if (calls.length) {
      if ([...this.#calls.keys()].sort((a, b) => a - b).some((index, i) => index !== i)) throw new RunFailure("UPSTREAM_INCOMPLETE");
      try { calls.forEach(readTool); } catch { throw new RunFailure("UPSTREAM_INCOMPLETE"); }
      if (new Set(calls.map(call => call.id)).size !== calls.length) throw new RunFailure("UPSTREAM_INCOMPLETE");
    }
    return snapshot;
  }
}
