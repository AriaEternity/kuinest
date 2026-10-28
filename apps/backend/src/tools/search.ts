import { object } from "../providers/messages.js";
import { prefix, validText } from "../context/profile.js";
import { ToolError } from "./policy.js";
export interface SearchProvider { readonly enabled?: boolean; search(query: string, signal: AbortSignal): Promise<unknown>; }
export type SearchConfig = { mode: "synthetic" | "private"; enabled: boolean; endpoint?: string; allowExternalQuery?: boolean; storageRightsConfirmed?: boolean };
const endpoint = "https://api.search.brave.com/res/v1/web/search";
export class BraveSearch implements SearchProvider {
  readonly #config: SearchConfig;
  readonly #url: string;
  constructor(config: SearchConfig, readonly credential: () => string | Promise<string>, readonly transport: typeof fetch = fetch) {
    this.#config = Object.freeze({ ...config }); this.#url = config.endpoint ?? endpoint;
    let url: URL; try { url = new URL(this.#url); } catch { throw new ToolError("SEARCH_CONFIG_INVALID"); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/res/v1/web/search"
      || (config.mode === "private" ? this.#url !== endpoint : url.protocol !== "http:" || !["127.0.0.1","[::1]"].includes(url.hostname))) throw new ToolError("SEARCH_CONFIG_INVALID");
  }
  get enabled(): boolean { return this.#config.enabled === true && (this.#config.mode === "synthetic" || this.#config.allowExternalQuery === true && this.#config.storageRightsConfirmed === true); }
  async search(query: string, signal: AbortSignal): Promise<unknown> {
    if (!this.enabled) throw new ToolError("TOOL_DENIED");
    if (!validText(query) || !query.trim() || [...query].length > 500 || query.trim().split(/\s+/u).length > 75) throw new ToolError("TOOL_INPUT_INVALID");
    const timeout = new AbortController(), abort = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), 15000);
    let stopListener: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve,reject) => {
      stopListener = () => reject(new ToolError("TOOL_TIMEOUT")); abort.addEventListener("abort",stopListener,{once:true});
    });
    try {
      abort.throwIfAborted();
      let token = "";
      if (this.#config.mode === "private") {
        token = await Promise.race([Promise.resolve().then(() => this.credential()),stopped]); abort.throwIfAborted();
        if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new ToolError("SEARCH_UNAVAILABLE");
      }
      const url = new URL(this.#url); url.searchParams.set("q",query); url.searchParams.set("count","5");
      const response = await Promise.race([this.transport(url, { method: "GET", redirect: "error", credentials: "omit", signal: abort, headers: { accept: "application/json", ...(token ? { "X-Subscription-Token": token } : {}) } }),stopped]);
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json") || !response.body) { await response.body?.cancel(); throw new ToolError("SEARCH_UNAVAILABLE"); }
      const reader = response.body.getReader(); let bytes = 0; const parts: Uint8Array[] = [];
      try {
        while (true) {
          abort.throwIfAborted(); const part = await Promise.race([reader.read(),stopped]); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > 256 * 1024) throw new ToolError("TOOL_RESULT_LIMIT"); parts.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value: unknown = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(parts)));
      if (!object(value) || !object(value.web) || !Array.isArray(value.web.results)) throw new ToolError("SEARCH_UNAVAILABLE");
      return { provider: "brave", untrusted: true, results: value.web.results.slice(0,5).map(result => {
        if (!object(result) || !validText(result.title) || !validText(result.description) || typeof result.url !== "string" || result.url.length > 2048) throw new ToolError("SEARCH_UNAVAILABLE");
        const link = new URL(result.url);
        if (!["http:","https:"].includes(link.protocol) || link.username || link.password) throw new ToolError("SEARCH_UNAVAILABLE");
        return { title: prefix(result.title,300), url: link.href, description: prefix(result.description,1000) };
      }) };
    } catch (error) {
      signal.throwIfAborted(); if (timeout.signal.aborted) throw new ToolError("TOOL_TIMEOUT");
      if (error instanceof ToolError) throw error; throw new ToolError("SEARCH_UNAVAILABLE");
    } finally { clearTimeout(timer); if (stopListener) abort.removeEventListener("abort",stopListener); }
  }
}
