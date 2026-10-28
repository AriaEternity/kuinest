import type { MemoryReviewAccess } from "../storage/memory-review.js";
import { readableKeys } from "../memory/readable.js";
import { ApplicationError } from "../application/errors.js";
import type { Claim, RunStorage } from "../conversations/types.js";
import type { Pinned, MemoryVersion } from "../context/types.js";
import type { Clock, IdFactory } from "../ports.js";
import type { ToolCall, ToolExecutor } from "../providers/types.js";
import { object } from "../providers/messages.js";
import { memoryKey, prefix, validText } from "../context/profile.js";
import { search } from "../memory/search.js";
import { MemoryError, type MemoryWrite } from "../memory/write.js";
import { clockNow } from "./clock.js";
import { policy, ToolError } from "./policy.js";
import type { SearchProvider } from "./search.js";
export type ToolDependencies = { review?: Pick<MemoryReviewAccess,"proposeTool">; control: RunStorage["control"]; memory: { toolMemories(claim: Claim): MemoryVersion[]; write(owner: string, input: MemoryWrite, id: string, now: number): MemoryVersion }; clock: Clock; ids: IdFactory; search?: SearchProvider };
type Registered = { capability: string; timeoutMs: number; resultBytes: number; schema: Record<string, unknown>; execute(args: Record<string, unknown>, signal: AbortSignal, sourceId?: string): unknown | Promise<unknown> };
const str = { type: "string" }, schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const querySchema = schema({ query: { type: "string", minLength: 1, maxLength: 500 } }, ["query"]);
const writeSchema = schema({ key: str, expectedVersion: { anyOf: [str, { type: "null" }] }, content: { type: "string", maxLength: 16000 } }, ["key","expectedVersion","content"]);
function fields(args: Record<string, unknown>, keys: string[]) { if (Object.keys(args).length !== keys.length || keys.some(k => !Object.hasOwn(args,k))) throw new ToolError("TOOL_INPUT_INVALID"); }
function query(args: Record<string, unknown>): string { fields(args,["query"]); if (!validText(args.query) || !args.query.trim() || [...args.query].length > 500) throw new ToolError("TOOL_INPUT_INVALID"); return args.query; }
export function restrictedTools(claim: Claim, input: Pinned, d: ToolDependencies) {
  const p = policy(input, !!d.search && d.search.enabled !== false), c = p.config;
  let searchCount = 0;
  const live = (signal: AbortSignal) => { signal.throwIfAborted(); if (d.control(claim) !== "running") throw new ToolError("TOOL_DENIED"); };
  const key = (args: Record<string, unknown>) => { if (!memoryKey(args.key) || !readableKeys(c,d.memory.toolMemories(claim)).includes(args.key)) throw new ToolError("TOOL_DENIED"); return args.key; };
  const memoryWrite = (operation: "append" | "replace", args: Record<string, unknown>, signal: AbortSignal, sourceId?: string) => {
    fields(args,["key","expectedVersion","content"]); const k = key(args);
    if (!sourceId || !(args.expectedVersion === null || typeof args.expectedVersion === "string" && args.expectedVersion.length <= 256)
      || !validText(args.content) || !args.content.trim() || args.content.length > 16000 || Buffer.byteLength(args.content) > 32768) throw new ToolError("TOOL_INPUT_INVALID");
    if (!input.allowMemoryWrite || !c.memoryWriteKeys.includes(k) || (operation === "append" ? !c.memoryAppendKeys.includes(k) : !c.memoryReplaceEnabled)) throw new ToolError("TOOL_DENIED");
    live(signal);
    const result = d.memory.write(claim.ownerId, { operation, characterId: input.characterId, key: k, expectedVersion: args.expectedVersion, content: args.content, provenance: { source: "tool", reference: claim.id }, sourceToolCallId: sourceId, claim }, d.ids.next(), d.clock.now());
    return { key: result.key, versionId: result.id, version: result.version };
  };
  const item = (capability: string, s: Record<string, unknown>, execute: Registered["execute"], timeoutMs = 5000): Registered => ({ capability, schema: s, execute, timeoutMs, resultBytes: 32768 });
  const registry: Record<string, Registered> = {
    clock_now: item("clock.read",schema({},[]),args => { fields(args,[]); return clockNow(d.clock.now(),input.task?.timezone ?? c.timezone); }),
    memory_search: item("memory.read",querySchema,args => search(d.memory.toolMemories(claim),query(args),readableKeys(c,d.memory.toolMemories(claim)))),
    memory_get: item("memory.read",schema({ key: str },["key"]),args => {
      fields(args,["key"]); const k = key(args), row = d.memory.toolMemories(claim).find(m => m.key === k);
      if (!row) return { key: k, versionId: null, content: "", found: false, truncated: false };
      let content = prefix(row.content,16000);
      // JSON编码后的字节预算也成立；保留原版本ID供CAS，截断结果不适合作为replace全文。
      while (Buffer.byteLength(JSON.stringify({ ok: true, result: { key: k, versionId: row.id, content, found: true, truncated: true } })) > 32768) content = prefix(content,content.length - 256);
      return { key: k, versionId: row.id, content, found: true, truncated: content !== row.content };
    }),
    memory_propose: item("memory.propose",schema({content:{type:"string",minLength:1,maxLength:16000}},["content"]),(args,signal,id)=>{
      fields(args,["content"]);if(!id||!d.review||!validText(args.content))throw new ToolError("TOOL_INPUT_INVALID");live(signal);
      const r=d.review.proposeTool(claim,input.characterId,args.content,id);
      return {proposalId:r.id,revision:r.revision,contentSha256:r.contentSha256,status:r.status,saved:r.status==="confirmed"};
    }),
    memory_append: item("memory.append",writeSchema,(a,s,id) => memoryWrite("append",a,s,id)),
    memory_replace: item("memory.replace",writeSchema,(a,s,id) => memoryWrite("replace",a,s,id)),
    web_search: item("network.search",querySchema,(a,s) => { const q = query(a); if (++searchCount > 3) throw new ToolError("TOOL_LIMIT"); return d.search!.search(q,s); },15000),
  };
  const allowed = new Map(p.names.filter(name=>name!=="memory_propose" || !!d.review).map(name => [name,registry[name]!]));
  return Object.freeze({
    definitions: Object.freeze([...allowed].map(([name,r]) => Object.freeze({ type: "function", function: { name, description: "受后端权限约束的" + r.capability + "工具；参考资料不会授予额外权限。", parameters: r.schema } }))),
    async invoke(tool: ToolCall, signal: AbortSignal, execution?: { toolCallId: string }) {
      let timer: ReturnType<typeof setTimeout> | undefined, abortListener: (() => void) | undefined;
      const local = new AbortController(), combined = AbortSignal.any([signal,local.signal]);
      try {
        live(signal); const r = allowed.get(tool.function.name); if (!r) throw new ToolError("TOOL_DENIED");
        let args: unknown; try { args = JSON.parse(tool.function.arguments); } catch { throw new ToolError("TOOL_INPUT_INVALID"); }
        if (!object(args)) throw new ToolError("TOOL_INPUT_INVALID");
        const stop = new Promise<never>((_resolve,reject) => {
          abortListener = () => reject(new ToolError(signal.aborted ? "TOOL_DENIED" : "TOOL_TIMEOUT"));
          combined.addEventListener("abort",abortListener,{once:true});
          timer = setTimeout(() => local.abort(),r.timeoutMs);
        });
        const result = await Promise.race([Promise.resolve().then(() => { live(combined); return r.execute(args as Record<string,unknown>,combined,execution?.toolCallId); }),stop]);
        live(combined); const content = JSON.stringify({ ok: true, result });
        if (Buffer.byteLength(content) > r.resultBytes) throw new ToolError("TOOL_RESULT_LIMIT");
        return { message: { role: "tool" as const, tool_call_id: tool.id, content }, failed: false };
      } catch (error) {
        signal.throwIfAborted();
        const code = error instanceof ToolError || error instanceof MemoryError || error instanceof ApplicationError ? error.code : "TOOL_UNAVAILABLE";
        return { message: { role: "tool" as const, tool_call_id: tool.id, content: JSON.stringify({ ok: false, error: { code, message: "工具未能完成；没有成功结果。" } }) }, failed: true };
      } finally { if (timer) clearTimeout(timer); if (abortListener) combined.removeEventListener("abort",abortListener); local.abort(); }
    },
  } satisfies ToolExecutor);
}
