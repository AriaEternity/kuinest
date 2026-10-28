import type { ContextRuntime } from "../context/types.js";
import { ProtocolLoop } from "./protocol-loop.js";
import type { ProtocolStorage, ToolExecutor } from "../providers/types.js";
import type { Clock, IdFactory, ProviderAdapter, ProviderEvent } from "../ports.js";
import { ApplicationError } from "../application/errors.js";
import { StorageError } from "../storage/errors.js";
import { RunFailure, type Claim, type FailureCode, type RunStorage } from "./types.js";
export interface WorkerOptions { context?: ContextRuntime; protocol?: ProtocolStorage; tools?: ToolExecutor; pollMs?: number; flushMs?: number; timeoutMs?: number; abortDrainMs?: number; onFault?: () => void; }
async function drain(promises: Promise<unknown>[], milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.allSettled(promises).then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}
export class Worker {
  #started = false; #closed = false; #failed = false;
  #ticker: ReturnType<typeof setInterval> | undefined;
  #cycle: Promise<void> | undefined;
  #active: { claim: Claim; controller: AbortController } | undefined;
  constructor(readonly store: RunStorage, readonly provider: ProviderAdapter, readonly clock: Clock, readonly ids: IdFactory, readonly options: WorkerOptions = {}) {}
  get ready(): boolean { return this.#started && !this.#closed && !this.#failed; }
  start(): void {
    if (this.#started || this.#closed) throw new ApplicationError("SERVICE_NOT_READY");
    try { this.store.recover(this.clock.now(), this.ids); } catch (error) { this.#fault(); throw error; }
    this.#started = true;
    this.#ticker = setInterval(() => this.wake(), this.options.pollMs ?? 1000); this.#ticker.unref();
    this.wake();
  }
  #fault(): void {
    if (this.#failed) return;
    this.#failed = true; if (this.#ticker) clearInterval(this.#ticker);
    this.options.onFault?.();
  }
  wake(): void {
    if (!this.ready || this.#cycle) return;
    this.#cycle = this.#run().catch(() => this.#fault()).finally(() => { this.#cycle = undefined; });
  }
  cancel(id: string): void { if (this.#active?.claim.id === id) this.#active.controller.abort("cancelled"); }
  async close(): Promise<void> {
    this.#closed = true; if (this.#ticker) clearInterval(this.#ticker);
    this.#active?.controller.abort("shutdown"); await this.#cycle;
  }
  async #run(): Promise<void> {
    while (this.ready) {
      const claim = this.store.claim(this.clock.now(), this.ids); if (!claim) return;
      await this.#execute(claim);
    }
  }
  async #execute(claim: Claim): Promise<void> {
    const controller = new AbortController(), signal = controller.signal;
    this.#active = { claim, controller };
    let iterator: AsyncIterator<ProviderEvent> | undefined, pending: Promise<IteratorResult<ProviderEvent>> | undefined;
    let buffer = "", full = "", bytes = 0, finished = false, failure: FailureCode | undefined, fatal = false;
    const aborted = Symbol("aborted");
    const interrupt = new Promise<typeof aborted>(resolve => signal.addEventListener("abort", () => resolve(aborted), { once: true }));
    const flush = () => {
      if (claim.origin === "heartbeat" || !buffer) return;
      if (!this.store.append(claim, buffer, this.clock.now())) { controller.abort("cancelled"); return; }
      buffer = "";
    };
    const timeout = setTimeout(() => controller.abort("timeout"), this.options.timeoutMs ?? 900000);
    const tick = setInterval(() => {
      if (signal.aborted) return;
      try {
        const state = this.store.control(claim);
        if (state !== "running") controller.abort("cancelled");
        else flush();
      } catch { fatal = true; controller.abort("fault"); }
    }, this.options.flushMs ?? 50);
    try {
      if (this.options.context) iterator = this.options.context.stream(claim, signal)[Symbol.asyncIterator]();
      else {
        const request = this.store.context(claim);
        const provider = this.options.protocol ? new ProtocolLoop(claim, this.options.protocol, this.provider, this.options.tools, this.clock, this.ids) : this.provider;
        iterator = provider.stream(request, signal)[Symbol.asyncIterator]();
      }
      while (!signal.aborted) {
        pending = Promise.resolve().then(() => iterator!.next());
        const result = await Promise.race([pending, interrupt]);
        if (result === aborted) break;
        if (result.done) break;
        const value = result.value;
        if (value.type === "text_delta") {
          if (finished || typeof value.text !== "string" || [...value.text].some(char => { const n = char.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })) throw new RunFailure("UPSTREAM_INCOMPLETE");
          bytes += Buffer.byteLength(value.text);
          if (bytes > 128 * 1024) throw new RunFailure("OUTPUT_LIMIT");
          full += value.text; if (claim.origin !== "heartbeat") buffer += value.text; if (Buffer.byteLength(buffer) >= 1024) flush();
        } else if (value.type === "finish") {
          if (finished || value.reason !== "stop") throw new RunFailure(value.reason === "length" ? "OUTPUT_LIMIT" : "UPSTREAM_INCOMPLETE");
          finished = true;
        } else if (value.type !== "usage") {
          // 未注入协议模块的工厂保持旧边界；协议循环只向这里交付公开文本和最终stop。
          throw new RunFailure("UPSTREAM_INCOMPLETE");
        }
      }
      if (!signal.aborted && !finished) failure = "UPSTREAM_INCOMPLETE";
      else if (!signal.aborted && !full.trim()) failure = "EMPTY_REPLY";
    } catch (error) {
      if (error instanceof StorageError || error instanceof ApplicationError) fatal = true;
      else failure = error instanceof RunFailure ? error.code : "UPSTREAM_UNAVAILABLE";
    } finally {
      clearInterval(tick); clearTimeout(timeout);
      try {
        if (!fatal) {
          const reason: unknown = signal.reason;
          if (reason !== "cancelled") flush();
          const state = signal.reason === "cancelled" ? "cancelled" : signal.aborted || failure ? "failed" : "completed";
          const code = signal.reason === "timeout" ? "RUN_TIMEOUT" : signal.reason === "shutdown" ? "RUN_INTERRUPTED" : failure;
          this.store.finish(claim, state, code, this.clock.now(), this.ids, claim.origin === "heartbeat" ? full : undefined);
        }
      } catch { fatal = true; }
      controller.abort("cleanup");
      const cleanup: Promise<unknown>[] = [];
      if (pending) cleanup.push(pending);
      if (iterator?.return) { try { cleanup.push(Promise.resolve(iterator.return())); } catch { fatal = true; } }
      // 无法确认旧适配器停止时关闭执行能力，不与下一次生成重叠。
      if (!(await drain(cleanup, this.options.abortDrainMs ?? 1000))) fatal = true;
      this.#active = undefined;
      if (fatal) this.#fault();
    }
  }
}
