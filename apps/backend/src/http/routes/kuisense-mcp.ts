import type { McpAuthorization } from "../../mcp/authorization.js";
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { kuisenseMcp } from "@kuinest/contracts";
import type { AppConfig } from "../../config.js";
import type { KuiSenseLatestReader } from "../../mcp/kuisense.js";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", id: null, error: { code, message } });

export function registerKuiSenseMcp(app: FastifyInstance, config: AppConfig, reader?: KuiSenseLatestReader, oauth?: McpAuthorization): void {
  const token = config.kuisenseMcpReadToken;
  // 默认不注册入口，不加载 SDK，不影响已有设备上传及聊天服务。
  if (token === undefined && oauth === undefined) return;
  const expected = digest(token ?? "");
  app.register(async scope => {
    scope.addHook("onRequest", async (request, reply) => {
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== config.publicOrigin)
        return reply.code(403).send(rpcError(-32000, "Origin 不被允许。"));
      if (oauth) {
        try { await oauth.authorize(request.headers.authorization); }
        catch { return reply.header("WWW-Authenticate",oauth.challenge).code(401).send(rpcError(-32000,"只读OAuth授权无效或已过期。")); }
      } else {
        const candidate = request.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "";
        if (!candidate || Buffer.byteLength(candidate, "utf8") > 512 || !timingSafeEqual(digest(candidate), expected))
          return reply.header("WWW-Authenticate", 'Bearer realm="kuisense-mcp-readonly"').code(401).send(rpcError(-32000, "只读入口鉴权失败。"));
      }
      if (Object.keys(request.query as object).length !== 0)
        return reply.code(400).send(rpcError(-32600, "MCP 入口不接受查询参数。"));
      if (request.method !== "POST")
        return reply.header("Allow", "POST").code(405).send(rpcError(-32000, "本入口使用 POST；不提供 SSE 订阅或会话删除。"));
    });
    await scope.register(rateLimit, {
      max: config.limits.apiPerMinute, timeWindow: 60000,
      keyGenerator: () => "kuisense-mcp-single-owner",
      errorResponseBuilder: () => Object.assign(new Error("MCP_RATE_LIMITED"), { statusCode: 429 }),
    });
    scope.setErrorHandler((error, _request, reply) => {
      const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
      if (status === 413) return reply.code(413).send(rpcError(-32000, "MCP 请求过大。"));
      if (status === 415) return reply.code(415).send(rpcError(-32000, "需要 application/json。"));
      if (status === 400) return reply.code(400).send(rpcError(-32700, "JSON 解析失败。"));
      if (status === 429) return reply.code(429).send(rpcError(-32000, "请求过于频繁，请稍后再试。"));
      return reply.code(500).send(rpcError(-32603, "MCP 服务暂时不可用。"));
    });
    const { createKuiSenseMcpServer } = await import("../../mcp/kuisense.js");
    const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
    scope.route({
      method: ["POST", "GET", "DELETE", "PUT", "PATCH", "OPTIONS", "HEAD"], url: kuisenseMcp.path,
      bodyLimit: 8 * 1024,
      async handler(request, reply) {
        if (request.method !== "POST") return reply.header("Allow", "POST").code(405).send(rpcError(-32000, "本入口使用 POST；不提供 SSE 订阅或会话删除。"));
        if (!reader) return reply.code(503).send(rpcError(-32000, "KuiSense latest 读取服务未装配。"));
        // 当前协议不接受 batch；防止多次调用绕过每请求限流。
        if (Array.isArray(request.body)) return reply.code(400).send(rpcError(-32600, "不支持批量 JSON-RPC。"));
        // 在 SDK 解析前规范化无参数工具的错误，避免库的 schema 错误回显输入。
        const body = request.body as { method?: unknown; params?: unknown; id?: unknown } | null;
        if (body && typeof body === "object" && body.method === "tools/call") {
          const params = body.params as { name?: unknown; arguments?: unknown } | null;
          if (!params || typeof params !== "object" || params.name !== kuisenseMcp.tool.name
            || (params.arguments !== undefined && (params.arguments === null || typeof params.arguments !== "object" || Array.isArray(params.arguments) || Object.keys(params.arguments).length !== 0))) {
            const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
            return reply.code(200).send({ ...rpcError(-32602, "只支持不带参数的 get_latest_context。"), id });
          }
        }
        // 无状态 JSON 响应：每个请求独占 server/transport，避免跨客户端共享响应。
        const server = createKuiSenseMcpServer(reader, oauth?.securitySchemes);
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        try {
          await server.connect(transport);
          const headers = new Headers();
          for (const name of ["accept", "content-type", "mcp-protocol-version"]) {
            const value = request.headers[name];
            if (typeof value === "string") headers.set(name, value);
          }
          const response = await transport.handleRequest(new Request(config.publicOrigin + kuisenseMcp.path, { method: "POST", headers }), { parsedBody: request.body });
          // 交回 Fastify 发送，继续应用现有 no-store / nosniff 安全响应头。
          reply.code(response.status);
          const contentType = response.headers.get("content-type");
          if (contentType) reply.header("Content-Type", contentType);
          return reply.send(await response.text());
        } finally { await server.close(); }
      },
    });
  });
}
