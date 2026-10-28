export type ErrorCode = "CONVERSATION_BUSY" | "MEMORY_REVIEW_CONFLICT" | "MEMORY_REVIEW_LIMIT" | "INPUT_INVALID" | "AUTH_INVALID" | "AUTH_REQUIRED" | "DEVICE_AUTH_INVALID" | "CSRF_INVALID" | "ORIGIN_FORBIDDEN" | "NOT_FOUND" | "CURSOR_INVALID" | "RATE_LIMITED" | "SERVICE_NOT_READY" | "IDEMPOTENCY_CONFLICT" | "QUEUE_FULL" | "EVENT_WINDOW_EXPIRED";
export class ApplicationError extends Error {
  constructor(readonly code: ErrorCode, readonly retryAfter?: number) {
    super("请求未能完成。"); this.name = "ApplicationError";
  }
}
export function ensure(ok: unknown, code: ErrorCode): asserts ok {
  if (!ok) throw new ApplicationError(code);
}
