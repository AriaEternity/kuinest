import type { Clock, IdFactory, ProviderAdapter, ProviderEvent, ProviderRequest } from "../ports.js";
import { RunFailure, type Claim } from "./types.js";
import { ProtocolAccumulator } from "../providers/protocol.js";
import type { ProtocolStorage, ToolExecutor } from "../providers/types.js";
import { validateHistory } from "../providers/messages.js";
import { boundOptions } from "../providers/policy.js";

export class ProtocolLoop implements ProviderAdapter {
  constructor(readonly claim: Claim, readonly store: ProtocolStorage, readonly upstream: ProviderAdapter, readonly tools: ToolExecutor | undefined, readonly clock: Clock, readonly ids: IdFactory, readonly checkRequest?: (request: ProviderRequest) => void) {}
  async *stream(initial: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const messages = validateHistory(initial.messages);
    const tools = this.tools?.definitions ?? initial.tools;
    const description = this.upstream.description;
    const options = boundOptions(initial.options, description);
    for (let turn = 0; turn < 8; turn++) {
      signal.throwIfAborted();
      const request: ProviderRequest = structuredClone({ system: initial.system, messages, tools, options });
      this.checkRequest?.(request);
      const call = this.store.begin(this.claim, this.ids.next(), request, this.clock.now()), accumulator = new ProtocolAccumulator();
      let complete = false;
      try {
        for await (const event of this.upstream.stream(request, signal)) {
          signal.throwIfAborted(); accumulator.add(event);
          this.store.checkpoint(this.claim, call, accumulator.snapshot(), "started", this.clock.now());
          // 只有普通可见文本交给既有worker批量提交；私有协议不进入公开SSE。
          if (event.type === "text_delta") yield event;
        }
        signal.throwIfAborted();
        const archive = accumulator.close();
        this.store.checkpoint(this.claim, call, archive, "completed", this.clock.now()); complete = true;
        messages.push(archive.assistant);
        if (archive.finish_reason === "stop") { yield { type: "finish", reason: "stop" }; return; }
        const pendingTools = archive.assistant.tool_calls!;
        // 超过循环预算时不执行无法接续的新一批工具。
        if (turn === 7) throw new RunFailure("TOOL_LIMIT");
        for (const tool of pendingTools) {
          signal.throwIfAborted();
          const entry = this.store.beginTool(this.claim, call, this.ids.next(), tool, this.clock.now());
          if (entry.result) { messages.push(entry.result); continue; }
          const result = this.tools ? await this.tools.invoke(tool, signal, { toolCallId: entry.id }) : {
            message: { role: "tool" as const, tool_call_id: tool.id, content: JSON.stringify({ ok: false, error: { code: "TOOL_DENIED", message: "工具未获授权。" } }) }, failed: true,
          };
          signal.throwIfAborted();
          this.store.finishTool(this.claim, entry.id, result.message, result.failed, this.clock.now());
          messages.push(result.message);
        }
        validateHistory(messages);
      } catch (error) {
        if (!signal.aborted && !complete) {
          const code = error instanceof RunFailure ? error.code : "UPSTREAM_UNAVAILABLE";
          this.store.checkpoint(this.claim, call, { ...accumulator.snapshot(), error: { code, ...(error instanceof RunFailure && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) } }, "failed", this.clock.now());
        }
        throw error;
      }
    }
    throw new RunFailure("TOOL_LIMIT");
  }
}
