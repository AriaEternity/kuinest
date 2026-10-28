import { object } from "../providers/messages.js";
import type { ToolExecutor } from "../providers/types.js";
import type { ContextDependencies, ContextRuntime } from "./types.js";
import type { Claim } from "../conversations/types.js";
import { RunFailure } from "../conversations/types.js";
import { compile } from "./compiler.js";
import { splitForCompaction } from "./branches.js";
import { compact, compactionRequest } from "./compaction.js";
import { ProtocolLoop } from "../conversations/protocol-loop.js";
import { measure } from "./budget.js";
import { hash } from "./profile.js";
import { boundOptions } from "../providers/policy.js";
export class CharacterRuntime implements ContextRuntime {
  constructor(readonly deps: ContextDependencies) {}
  get supportsImages(): boolean { return this.deps.counter?.supportsImages === true; }
  async *stream(claim: Claim, signal: AbortSignal) {
    signal.throwIfAborted();
    const d = this.deps, input = d.storage.load(claim), executor = d.toolsForRun?.(claim, input) ?? d.tools, definitions = structuredClone(executor?.definitions ?? []);
    const names = new Set(definitions.map(def => {
      if (def.type !== "function" || !object(def.function) || typeof def.function.name !== "string") throw new RunFailure("PROFILE_INVALID");
      return def.function.name;
    }));
    const tools: ToolExecutor | undefined = executor ? { definitions, invoke: (tool, abort, execution) => names.has(tool.function.name) ? executor.invoke(tool, abort, execution) : Promise.resolve({
      message: { role: "tool", tool_call_id: tool.id, content: JSON.stringify({ ok: false, error: { code: "TOOL_DENIED", message: "工具不在本轮固定能力中。" } }) }, failed: true,
    }) } : undefined;
    const compiled = compile(input, definitions, d.counter);
    let request = compiled.request, manifest = compiled.manifest;
    const upstream = d.resolve(compiled.profile, "reply", claim);
    if (upstream.description?.model !== compiled.profile.model || upstream.description.provider !== compiled.profile.provider) throw new RunFailure("PROFILE_INVALID");
    boundOptions(request.options, upstream.description);
    let saved: { id: string; payload: unknown; callId: string } | undefined;
    if (!compiled.budget.fits) {
      const split = splitForCompaction(compiled.branch.selected);
      const output = Math.min(8192, Number(compiled.profile.options.maxTokens ?? 32768));
      const summaryRequest = compactionRequest(compiled.profile, split.before, compiled.branch.summary);
      if (!measure(summaryRequest, compiled.config, { ...compiled.profile, options: { ...compiled.profile.options, maxTokens: output } }, d.counter).fits) throw new RunFailure("CONTEXT_TOO_LARGE");
      const result = await compact(d, claim, compiled.profile, split.before, compiled.branch.summary, signal);
      signal.throwIfAborted();
      request = compiled.build(split.tail, result.result);
      const budget = measure(request, compiled.config, compiled.profile, d.counter);
      if (!budget.fits) throw new RunFailure("CONTEXT_TOO_LARGE");
      saved = { id: d.ids.next(), callId: result.callId, payload: { summary: result.result.text, sourceIds: result.result.sourceIds, firstKeptEntryId: split.firstKeptEntryId, providerCallId: result.callId, tokensBefore: compiled.budget.input } };
      manifest = { ...manifest, selectedEntryIds: split.tail.map(e => e.id), summaryEntryId: saved.id, budget, requestHash: hash(JSON.stringify(request)) };
    }
    signal.throwIfAborted(); d.storage.save(claim, manifest, d.clock.now(), saved);
    const loop = new ProtocolLoop(claim, d.protocol, upstream, tools, d.clock, d.ids, next => {
      if (!measure(next, compiled.config, compiled.profile, d.counter).fits) throw new RunFailure("CONTEXT_TOO_LARGE");
    });
    yield* loop.stream(request, signal);
  }
}
