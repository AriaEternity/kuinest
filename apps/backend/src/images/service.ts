import type { Clock } from "../ports.js";
import type { SessionRecord } from "../application/ports.js";
import type { ImageStorage } from "./storage.js";
import { ImageValidator } from "./validate.js";
import { ImageFailure, type ImageInspection, type ImageMime } from "./types.js";

export interface ImageInspector {
  inspect(bytes: Uint8Array, declared?: ImageMime, signal?: AbortSignal): Promise<ImageInspection>;
}
export class ImageService {
  #closing = false;
  #pending = new Map<AbortController, Promise<unknown>>();
  constructor(readonly store: ImageStorage, readonly clock: Clock, readonly inspector: ImageInspector = new ImageValidator()) {}
  get ready(): boolean { return !this.#closing; }
  upload(session: SessionRecord, conversationId: string, id: string, mime: ImageMime, content: Buffer, signal: AbortSignal) {
    if (this.#closing) return Promise.reject(new ImageFailure("IMAGE_UNAVAILABLE"));
    this.store.requireConversation(session.ownerId, conversationId);
    // 固定原件；校验与持久化使用同一副本，避免await期间被调用者改写。
    const bytes = Buffer.from(content), controller = new AbortController();
    const abort = () => controller.abort(new ImageFailure("IMAGE_UNAVAILABLE"));
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const work = Promise.resolve().then(async () => {
      try {
        const inspection = await this.inspector.inspect(bytes, mime, controller.signal);
        controller.signal.throwIfAborted();
        if (this.#closing) throw new ImageFailure("IMAGE_UNAVAILABLE");
        return this.store.putUpload({ id, ownerId: session.ownerId, conversationId, content: bytes, inspection, createdAt: this.clock.now(), sessionTokenHash: session.tokenHash });
      } finally {
        signal.removeEventListener("abort", abort); this.#pending.delete(controller);
      }
    });
    this.#pending.set(controller, work);
    return work;
  }
  async close(): Promise<void> {
    this.#closing = true;
    const work = [...this.#pending.entries()];
    for (const [controller] of work) controller.abort(new ImageFailure("IMAGE_UNAVAILABLE"));
    await Promise.allSettled(work.map(([, promise]) => promise));
  }
}
