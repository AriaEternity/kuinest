import { ApplicationError } from "../application/errors.js";
export class ApiLimiter {
  #buckets = new Map<string, { minute: number; count: number }>();
  check(ownerId: string, now: number): void {
    const minute = Math.floor(now / 60000);
    for (const [id, bucket] of this.#buckets) if (bucket.minute !== minute) this.#buckets.delete(id);
    const bucket = this.#buckets.get(ownerId) ?? { minute, count: 0 };
    if (bucket.count >= 120) throw new ApplicationError("RATE_LIMITED", Math.max(1, Math.ceil(((minute + 1) * 60000 - now) / 1000)));
    bucket.count++; this.#buckets.set(ownerId, bucket);
  }
}
