import { wireMessages, imageRequestLimits, type ImageResolver } from "../images/wire.js";
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from "../ports.js";
import { RunFailure } from "../conversations/types.js";
import type { DeepSeekProfile } from "./types.js";
import { object, validateHistory } from "./messages.js";
import { ProviderSseParser } from "./sse-parser.js";
import { thinkingPolicy, boundOptions } from "./policy.js";

export interface TransportOptions { headersMs?: number; idleMs?: number; totalMs?: number; maxFrameBytes?: number; maxResponseBytes?: number; }
export function validateProfile(input: DeepSeekProfile): Readonly<DeepSeekProfile> {
  let url: URL; try { url = new URL(input.endpoint); } catch { throw new RunFailure("UPSTREAM_UNAVAILABLE"); }
  if (input.wireFormat !== undefined && !["deepseek", "mimo"].includes(input.wireFormat) || input.wireFormat === "mimo" && input.thinking !== "provider-default"
    || input.imageInput !== undefined && typeof input.imageInput !== "boolean" || !["synthetic", "private"].includes(input.mode) || url.origin !== input.allowedOrigin || url.username || url.password || url.search || url.hash
    || !["/chat/completions", "/v1/chat/completions"].includes(url.pathname)
    || typeof input.model !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.model)
    || !Number.isSafeInteger(input.maxTokens ?? 32768) || (input.maxTokens ?? 32768) < 1 || (input.maxTokens ?? 32768) > 32768
    || (input.mode === "private" ? url.protocol !== "https:" : url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname))) throw new RunFailure("UPSTREAM_UNAVAILABLE");
  let policy; try { policy = thinkingPolicy({ ...input }); } catch { throw new RunFailure("UPSTREAM_UNAVAILABLE"); }
  return Object.freeze({ ...input, ...policy, endpoint: url.href, maxTokens: input.maxTokens ?? 32768 });
}
export function requestBody(request: ProviderRequest, profile: DeepSeekProfile, resolver?: ImageResolver): Record<string, unknown> {
  const normalized = validateProfile(profile), policy = thinkingPolicy({ ...normalized });
  const options = boundOptions(request.options, { provider: "deepseek", model: normalized.model, maxTokens: normalized.maxTokens!, ...(normalized.imageInput !== undefined ? { imageInput: normalized.imageInput } : {}), ...policy });
  const messages = validateHistory(request.messages), tools = structuredClone(request.tools);
  if (tools.length && policy.thinking === "enabled") {
    for (const message of messages) if (message.role === "assistant" && message.reasoning_content === undefined) throw new RunFailure("PROTOCOL_HISTORY_INCOMPLETE");
  }
  if ((!tools.length && normalized.wireFormat !== "mimo") || policy.thinking === "disabled") {
    for (const message of messages) if (message.role === "assistant") delete message.reasoning_content;
  }
  return {
    // 数据库provider沿用既有适配器标识；wireFormat显式选择供应商字段，不按模型名猜测。
    model: normalized.model, stream: true, ...(normalized.wireFormat === "mimo" ? {} : { stream_options: { include_usage: true } }),
    ...(policy.thinking === "provider-default" ? {} : { thinking: { type: policy.thinking } }),
    ...(policy.reasoning_effort ? { reasoning_effort: policy.reasoning_effort } : {}),
    ...(normalized.wireFormat === "mimo" ? { max_completion_tokens: options.maxTokens } : { max_tokens: options.maxTokens }),
    messages: [{ role: "system", content: request.system }, ...wireMessages(messages, normalized.imageInput === true, resolver)], ...(tools.length ? { tools } : {}),
  };
}

async function credentialWithin(get: () => string | Promise<string>, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return get(); }), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(86400, seconds) : undefined;
}
export class DeepSeekProvider implements ProviderAdapter {
  readonly profile: Readonly<DeepSeekProfile>;
  readonly description: NonNullable<ProviderAdapter["description"]>;
  constructor(profile: DeepSeekProfile, readonly credential: () => string | Promise<string>, readonly transport: typeof fetch = fetch, readonly options: TransportOptions = {}, readonly images?: ImageResolver) {
    this.profile = validateProfile(profile);
    this.description = Object.freeze({ provider: "deepseek", model: this.profile.model, maxTokens: this.profile.maxTokens!, ...(this.profile.imageInput !== undefined ? { imageInput: this.profile.imageInput } : {}), ...thinkingPolicy({ ...this.profile }) });
  }
  async *stream(request: ProviderRequest, external: AbortSignal): AsyncGenerator<ProviderEvent> {
    external.throwIfAborted();
    if (this.profile.mode === "private" && this.profile.allowLive !== true) throw new RunFailure("UPSTREAM_UNAVAILABLE");
    const body = JSON.stringify(requestBody(request, this.profile, this.images));
    if (Buffer.byteLength(body) > imageRequestLimits.wireBytes) throw new RunFailure("CONTEXT_TOO_LARGE");
    const controller = new AbortController(), signal = AbortSignal.any([external, controller.signal]);
    let headers: ReturnType<typeof setTimeout> | undefined, idle: ReturnType<typeof setTimeout> | undefined;
    const total = setTimeout(() => controller.abort("transport-timeout"), this.options.totalMs ?? 900000);
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort("transport-timeout"), this.options.idleMs ?? 180000); };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // 合成请求不读取任何凭据入口；真实模式只在调用时读取，不归档头部。
      const token = this.profile.mode === "private" ? await credentialWithin(this.credential, signal) : undefined;
      signal.throwIfAborted();
      if (token !== undefined && (!token || !/^[\x21-\x7e]+$/.test(token))) throw new RunFailure("UPSTREAM_AUTH");
      headers = setTimeout(() => controller.abort("transport-timeout"), this.options.headersMs ?? 30000);
      const response = await this.transport(this.profile.endpoint, { method: "POST", redirect: "error", cache: "no-store", signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(token ? { Authorization: "Bearer " + token } : {}) }, body });
      clearTimeout(headers);
      if (!response.ok) {
        await response.body?.cancel();
        throw new RunFailure([401, 403].includes(response.status) ? "UPSTREAM_AUTH" : response.status === 429 ? "UPSTREAM_RATE_LIMIT" : "UPSTREAM_UNAVAILABLE", retryAfter(response.headers.get("retry-after")));
      }
      if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/event-stream" || !response.body) { await response.body?.cancel(); throw new RunFailure("UPSTREAM_INCOMPLETE"); }
      reader = response.body.getReader(); touch();
      const parser = new ProviderSseParser(this.options.maxFrameBytes, this.options.maxResponseBytes);
      let finish: string | undefined, identity: string | undefined;
      while (true) {
        const part = await reader.read(); signal.throwIfAborted();
        if (part.done) { parser.end(); throw new RunFailure("UPSTREAM_INCOMPLETE"); }
        touch();
        for (const data of parser.push(part.value)) {
          if (data === "[DONE]") {
            if (!finish) throw new RunFailure("UPSTREAM_INCOMPLETE");
            yield { type: "finish", reason: finish }; return;
          }
          let chunk: unknown; try { chunk = JSON.parse(data); } catch { throw new RunFailure("UPSTREAM_INCOMPLETE"); }
          if (!object(chunk) || chunk.error || !Array.isArray(chunk.choices) || chunk.choices.length > 1) throw new RunFailure("UPSTREAM_INCOMPLETE");
          if (chunk.id !== undefined) {
            if (typeof chunk.id !== "string" || identity !== undefined && identity !== chunk.id) throw new RunFailure("UPSTREAM_INCOMPLETE");
            identity = chunk.id;
          }
          if (chunk.choices.length) {
            const choice: unknown = chunk.choices[0];
            if (!object(choice) || choice.index !== 0 || !object(choice.delta)) throw new RunFailure("UPSTREAM_INCOMPLETE");
            const delta = choice.delta;
            if (delta.refusal) throw new RunFailure("UPSTREAM_REFUSED");
            // DeepSeek与MiMo官方流式样例均允许后续role=null；具体非法角色仍拒绝。
            if (Object.keys(delta).some(key => !["role", "content", "reasoning_content", "tool_calls", "refusal"].includes(key)) || delta.role !== undefined && delta.role !== null && delta.role !== "assistant") throw new RunFailure("UPSTREAM_INCOMPLETE");
            for (const [field, type] of [["reasoning_content", "reasoning_delta"], ["content", "text_delta"]] as const) {
              const value = delta[field];
              if (value !== undefined && value !== null) {
                if (typeof value !== "string" || finish !== undefined) throw new RunFailure("UPSTREAM_INCOMPLETE");
                yield { type, text: value };
              }
            }
            if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
              if (finish || !Array.isArray(delta.tool_calls)) throw new RunFailure("UPSTREAM_INCOMPLETE");
              for (const call of delta.tool_calls as unknown[]) {
                if (!object(call) || Object.keys(call).some(key => !["index", "id", "type", "function"].includes(key)) || !Number.isSafeInteger(call.index) || (call.type !== undefined && call.type !== "function") || (call.function !== undefined && !object(call.function))) throw new RunFailure("UPSTREAM_INCOMPLETE");
                const fn = call.function as Record<string, unknown> | undefined;
                if (fn && Object.keys(fn).some(key => !["name", "arguments"].includes(key))) throw new RunFailure("UPSTREAM_INCOMPLETE");
                if ([call.id, fn?.name, fn?.arguments].some(value => value !== undefined && typeof value !== "string")) throw new RunFailure("UPSTREAM_INCOMPLETE");
                yield { type: "tool_call_delta", index: call.index as number, ...(call.id !== undefined ? { id: call.id as string } : {}), ...(fn?.name !== undefined ? { name: fn.name as string } : {}), ...(fn?.arguments !== undefined ? { arguments: fn.arguments as string } : {}) };
              }
            }
            if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
              if (finish || typeof choice.finish_reason !== "string") throw new RunFailure("UPSTREAM_INCOMPLETE");
              finish = choice.finish_reason;
            }
          }
          if (chunk.usage !== undefined && chunk.usage !== null) {
            const usage = chunk.usage;
            if (!object(usage) || !Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens) || Number(usage.prompt_tokens) < 0 || Number(usage.completion_tokens) < 0) throw new RunFailure("UPSTREAM_INCOMPLETE");
            yield { type: "usage", inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number, details: usage };
          }
        }
      }
    } catch (error) {
      if (external.aborted) throw error;
      if (controller.signal.aborted) throw new RunFailure("UPSTREAM_TIMEOUT");
      throw error instanceof RunFailure ? error : new RunFailure("UPSTREAM_UNAVAILABLE");
    } finally {
      clearTimeout(total); clearTimeout(headers); clearTimeout(idle);
      controller.abort("cleanup");
      await reader?.cancel().catch(() => {}); reader?.releaseLock();
    }
  }
}
