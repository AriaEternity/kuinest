import type { CancelAccepted, SubmitMessageRequest } from "@kuinest/contracts";
import type { AppConfig } from "../config.js";
import type { Clock, IdFactory, ProviderAdapter } from "../ports.js";
import type { Queries } from "../application/queries.js";
import { ensure } from "../application/errors.js";
import type { RunStorage } from "./types.js";
import { submission } from "./submit.js";
import { Worker, type WorkerOptions } from "./worker.js";
export class RunService {
  readonly worker: Worker;
  readonly webSearch: boolean;
  readonly imageAttachments: boolean;
  constructor(readonly store: RunStorage, readonly queries: Queries, readonly clock: Clock, readonly ids: IdFactory, readonly config: AppConfig, provider: ProviderAdapter, options?: WorkerOptions & { webSearch?: boolean; imageAttachments?: boolean }) {
    ensure(config.mode === "synthetic" || config.allowLiveModel && !!options?.context, "SERVICE_NOT_READY");
    this.webSearch = options?.webSearch ?? false;
    this.imageAttachments = options?.imageAttachments === true;
    ensure(!this.imageAttachments || store.supportsImages === true && options?.context?.supportsImages === true, "SERVICE_NOT_READY");
    this.worker = new Worker(store, provider, clock, ids, { timeoutMs: config.limits.runTimeoutMs, ...options });
  }
  get ready() { return this.worker.ready; }
  start() { this.worker.start(); }
  submit(owner: string, conversation: string, input: SubmitMessageRequest) {
    ensure(this.ready, "SERVICE_NOT_READY");
    const result = this.store.submit(owner, conversation, submission(input), this.clock.now(), this.ids, this.config.limits);
    this.worker.wake(); return result;
  }
  cancel(owner: string, runId: string): CancelAccepted {
    ensure(this.ready, "SERVICE_NOT_READY");
    this.store.cancel(owner, runId, this.clock.now(), this.ids);
    const result: CancelAccepted = { accepted: true, run: this.queries.run(owner, runId) };
    // 持久标志和快照先完成，适配器停止只负责加速，不代替存储检查。
    this.worker.cancel(runId); return result;
  }
  close(): Promise<void> { return this.worker.close(); }
}
