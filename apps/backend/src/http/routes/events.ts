import type { FastifyReply } from "fastify";
import type { ServerResponse } from "node:http";
import type { SessionRecord } from "../../application/ports.js";
import { ensure } from "../../application/errors.js";
import type { Sessions } from "../../auth/sessions.js";
import type { Clock } from "../../ports.js";
import { terminal, type EventPage, type EventStorage } from "../../conversations/events.js";

export interface StreamOptions { heartbeatMs?: number; sessionMs?: number; pollMs?: number; backpressureMs?: number; maxBytes?: number; }
export class EventStreams {
  #connections = new Set<{ owner: string; close(): void }>();
  #closed = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #peak = 0;
  #slow = 0;
  readonly limits: Required<StreamOptions>;
  constructor(readonly store: EventStorage, readonly subscribe: (wake: () => void) => () => void, readonly sessions: Sessions, readonly clock: Clock, options: StreamOptions = {}) {
    this.limits = Object.freeze({ heartbeatMs: 15000, sessionMs: 30000, pollMs: 1000, backpressureMs: 30000, maxBytes: 256 * 1024, ...options });
    ensure(Object.values(this.limits).every(value => Number.isSafeInteger(value) && value > 0) && this.limits.maxBytes <= 256 * 1024, "SERVICE_NOT_READY");
  }
  get ready() { return !this.#closed; }
  get diagnostics() { return { connections: this.#connections.size, peakWritableBytes: this.#peak, backpressureClosures: this.#slow }; }
  start(): void {
    ensure(!this.#closed && !this.#timer, "SERVICE_NOT_READY");
    this.store.prune(this.clock.now());
    this.#timer = setInterval(() => { try { this.store.prune(this.clock.now()); } catch { this.close(); } }, 3600000);
    this.#timer.unref();
  }
  close(): void {
    this.#closed = true; clearInterval(this.#timer);
    for (const connection of [...this.#connections]) connection.close();
  }
  open(session: SessionRecord, runId: string, initial: number, reply: FastifyReply): void {
    ensure(!this.#closed, "SERVICE_NOT_READY");
    this.sessions.validateStream(session);
    ensure([...this.#connections].filter(c => c.owner === session.ownerId).length < 4, "RATE_LIMITED");
    let pending = false, resume: (() => void) | undefined;
    const wake = () => { pending = true; resume?.(); resume = undefined; };
    // 先订阅后读持久快照，通知在订阅期间到来会留下唤醒标记。
    const unsubscribe = this.subscribe(wake);
    let page: EventPage;
    try {
      page = this.store.read(session.ownerId, runId, initial);
      if (terminal(page.status) && initial === page.lastSequence) { unsubscribe(); reply.code(204).send(); return; }
    } catch (error) { unsubscribe(); throw error; }
    const response = reply.raw, abort = new AbortController();
    let ended = false;
    const timers: ReturnType<typeof setInterval>[] = [];
    const cleanup = () => {
      if (ended) return; ended = true;
      timers.forEach(clearInterval); unsubscribe(); abort.abort(); wake(); this.#connections.delete(connection);
    };
    const finish = (destroy: boolean) => {
      if (ended) return;
      if (destroy) { cleanup(); response.destroy(); } else response.end();
    };
    const connection = { owner: session.ownerId, close: () => finish(true) };
    this.#connections.add(connection);
    response.once("finish", cleanup);
    response.once("close", () => finish(true));
    response.once("error", () => finish(true));
    reply.hijack();
    // hijack 跳过 onSend，安全响应头必须显式补齐；此连接单独关闭空闲 socket 超时。
    response.socket?.setTimeout(0);
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
    response.flushHeaders();
    const interval = (callback: () => void, milliseconds: number) => { const timer = setInterval(callback, milliseconds); timer.unref(); timers.push(timer); };
    interval(wake, this.limits.pollMs);
    interval(() => { try { this.sessions.validateStream(session); } catch { finish(true); } }, this.limits.sessionMs);
    let heartbeat = false;
    interval(() => { heartbeat = true; wake(); }, this.limits.heartbeatMs);
    const send = async (text: string) => {
      const bytes = Buffer.byteLength(text);
      if (response.writableLength + bytes + 32 > this.limits.maxBytes) { this.#slow++; finish(true); return false; }
      if (ended) return false;
      // 等待这次写入完成；write 返回 true 也可能还有少量待发送数据。
      const drained = await this.#write(response, text, abort.signal);
      if (!drained && !ended) { this.#slow++; finish(true); }
      return drained && !ended;
    };
    const pump = async () => {
      let cursor = initial, count = 0;
      while (!ended) {
        if (page.event) {
          const event = page.event;
          if (!await send("id: " + event.sequence + "\nevent: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n")) return;
          cursor = event.sequence;
          if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) { finish(false); return; }
          // 大量重放期间让出事件循环，使撤销检查、其他账号和生成器都有机会执行。
          if (++count % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        } else {
          if (terminal(page.status)) { finish(false); return; }
          if (heartbeat) { heartbeat = false; if (!await send(": heartbeat\n\n")) return; }
          if (!pending) await new Promise<void>(resolve => { resume = resolve; });
          pending = false;
          if (ended) return;
        }
        // 每次回到数据库重新核对 lastSequence；不把内存通知当作事件内容。
        page = this.store.read(session.ownerId, runId, cursor);
      }
    };
    void pump().catch(() => finish(true));
  }
  #write(response: ServerResponse, text: string, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal.removeEventListener("abort", aborted); resolve(ok);
      };
      const aborted = () => done(false);
      const timer = setTimeout(() => done(false), this.limits.backpressureMs); timer.unref();
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted || response.destroyed) { done(false); return; }
      response.write(text, error => done(!error));
      this.#peak = Math.max(this.#peak, response.writableLength);
    });
  }
}
