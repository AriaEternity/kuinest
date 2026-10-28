import type { Clock, IdFactory } from "../ports.js";
export interface SchedulerStorage { tick(now: number, ids: IdFactory, globalQueue?: number): number; }
export class Scheduler {
  #timer: ReturnType<typeof setInterval> | undefined;
  #failed = false;
  constructor(readonly store: SchedulerStorage, readonly clock: Clock, readonly ids: IdFactory, readonly wake: () => void, readonly onFault: () => void = () => {}) {}
  get ready() { return !!this.#timer && !this.#failed; }
  start(): void {
    if (this.#timer || this.#failed) throw new Error("SCHEDULER_NOT_READY");
    this.#timer = setInterval(() => this.tick(), 15000); this.#timer.unref(); this.tick();
  }
  tick(): void {
    if (!this.ready) return;
    try { if (this.store.tick(this.clock.now(), this.ids)) this.wake(); }
    catch { this.#failed = true; this.close(); this.onFault(); }
  }
  close(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
}
