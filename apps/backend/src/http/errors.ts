import type { IncomingMessage, ServerResponse } from "node:http";
import type { IdFactory } from "../ports.js";
import type { FastifyInstance } from "fastify";
import type { ApiError } from "@kuinest/contracts";
import { ApplicationError, type ErrorCode } from "../application/errors.js";
import { ImageFailure, type ImageCode } from "../images/types.js";
import { StorageError } from "../storage/errors.js";
const safe: Record<ErrorCode, [number, string]> = {
  CONVERSATION_BUSY: [409, "会话仍有正在处理的回复，请停止回复或等待结束后再删除。"],
  MEMORY_REVIEW_CONFLICT: [409,"候选内容或状态已经改变，请重新读取后确认。"], MEMORY_REVIEW_LIMIT: [413,"记忆候选或有效记忆已达到容量上限。"],
  INPUT_INVALID: [400, "请求不符合接口要求。"], CURSOR_INVALID: [400, "查询游标无效，请重新加载。"],
  AUTH_INVALID: [401, "账号或口令不正确。"], AUTH_REQUIRED: [401, "请先登录。"], DEVICE_AUTH_INVALID: [401, "设备鉴权失败。"],
  CSRF_INVALID: [403, "请求验证失败。"], ORIGIN_FORBIDDEN: [403, "请求来源不被允许。"],
  NOT_FOUND: [404, "请求的资源不存在。"], RATE_LIMITED: [429, "请求过于频繁，请稍后再试。"],
  IDEMPOTENCY_CONFLICT: [409, "相同提交编号已用于不同内容。"], QUEUE_FULL: [429, "待处理消息已达上限，请稍后再试。"],
  EVENT_WINDOW_EXPIRED: [410, "事件保留窗口已过期，请使用运行快照恢复。"],
  SERVICE_NOT_READY: [503, "所需服务尚未就绪。"],
};

const imageErrors: Record<ImageCode, [number, string]> = {
  IMAGE_INVALID: [400, "图片内容无效或损坏。"], IMAGE_UNSUPPORTED: [415, "图片格式暂不支持。"],
  IMAGE_TOO_LARGE: [413, "图片超过大小或像素限制。"], IMAGE_TIMEOUT: [503, "图片校验超时，请稍后重试。"],
  IMAGE_BUSY: [429, "正在处理其他图片，请稍后重试。"], IMAGE_UNAVAILABLE: [503, "图片暂时无法读取或处理。"],
  IMAGE_STORAGE_FULL: [413, "图片存储空间已达上限。"],
};
function body(code: string, message: string, requestId: string): ApiError {
  return { error: { code, message }, requestId };
}
export function registerErrors(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => reply.code(404).send(body("NOT_FOUND", "请求的资源不存在。", request.id)));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ImageFailure) {
      const [status, message] = imageErrors[error.code];
      if (error.code === "IMAGE_BUSY") reply.header("Retry-After", "1");
      request.log.warn({ code: error.code, requestId: request.id }, "图片请求未能完成。");
      return reply.code(status).send(body(error.code, message, request.id));
    }
    if (error instanceof ApplicationError || error instanceof StorageError) {
      const code = error instanceof ApplicationError ? error.code : "SERVICE_NOT_READY";
      const [status, message] = safe[code];
      if (error instanceof ApplicationError && error.retryAfter !== undefined) reply.header("Retry-After", String(Math.max(1, Math.ceil(error.retryAfter))));
      request.log.warn({ code, requestId: request.id }, "请求未能完成。");
      return reply.code(status).send(body(code, message, request.id));
    }
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
    const validation = typeof error === "object" && error !== null && "validation" in error;
    const status = statusCode === 413 ? 413 : (statusCode === 400 || statusCode === 415 || validation ? 400 : 500);
    const code = status === 413 ? "BODY_TOO_LARGE" : status === 400 ? "INPUT_INVALID" : "INTERNAL_ERROR";
    request.log.error({ code, requestId: request.id }, "请求处理失败。");
    reply.code(status).send(body(code, status === 500 ? "服务暂时无法处理请求。" : "请求不符合接口要求。", request.id));
  });
}

export function routingError(ids: IdFactory) {
  // 路由解码发生在应用钩子之前，必须在这里覆盖框架会回显 URL 的默认响应。
  return (_path: string, _request: IncomingMessage, response: ServerResponse): void => {
    response.statusCode = 400;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(JSON.stringify(body("INPUT_INVALID", "请求地址不符合接口要求。", ids.next())));
  };
}
