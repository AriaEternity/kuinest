import type { FastifyServerOptions } from "fastify";
import type { Writable } from "node:stream";

export function loggerOptions(stream?: Writable): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  return {
    level: "info", base: null, ...(stream ? { stream } : {}),
    // 请求、响应和错误只留下固定白名单；不序列化路径、查询串、Cookie 或堆栈。
    serializers: {
      req: () => ({}), res: (res: { statusCode?: number }) => (res.statusCode === undefined ? {} : { statusCode: res.statusCode }),
      err: () => ({ type: "Error", message: "内部错误。", stack: "", code: "INTERNAL_ERROR" }),
    },
    redact: { paths: ["luckinToken", "LUCKIN_TOKEN", "LUCKIN_MCP_TOKEN", "credential", "password", "token", "apiKey", "cursorHmacKey", "kuisenseDeviceToken", "kuisenseMcpReadToken", "KUISENSE_MCP_READ_TOKEN", "authorization", "config", "env", "body", "headers", "context", "reasoning_content"], remove: true },
  };
}
