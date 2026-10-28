import { registerLuckinMcp,registerLuckinPreviewMcp,registerLuckinOrdersMcp } from "./http/routes/luckin-mcp.js";
import type { LuckinMcpOptions } from "./http/routes/luckin-mcp.js";
import type { McpAuthorization } from "./mcp/authorization.js";
import { registerKuiSenseMcp } from "./http/routes/kuisense-mcp.js";
import type { KuiSenseService } from "./application/kuisense.js";
import { registerKuiSense } from "./http/routes/kuisense.js";
import type { MemoryReviewAccess } from "./storage/memory-review.js";
import type { ImageService } from "./images/service.js";
import type { Scheduler } from "./scheduler/tick.js";
import type { EventStreams } from "./http/routes/events.js";
import Fastify, { LogController } from "fastify";
import type { Writable } from "node:stream";
import type { AppConfig } from "./config.js";
import type { BackendPorts } from "./ports.js";
import { loggerOptions } from "./logging.js";
import type { RunService } from "./conversations/service.js";
import type { ApiServices } from "./application/service.js";
import { registerApi } from "./http/routes/api.js";
import { registerErrors, routingError } from "./http/errors.js";
import { registerHealth } from "./http/health.js";

export function createApp(config: AppConfig, ports: BackendPorts, options: { luckinOrdersMcp?:LuckinMcpOptions; luckinPreviewMcp?: LuckinMcpOptions; luckinMcp?: LuckinMcpOptions; mcpAuthorization?: McpAuthorization; memoryReview?: MemoryReviewAccess; logStream?: Writable; api?: ApiServices; runs?: RunService; events?: EventStreams; scheduler?: Scheduler; images?: ImageService; kuisense?: KuiSenseService } = {}) {
  const app = Fastify({
    logger: loggerOptions(options.logStream),
    logController: new LogController({ disableRequestLogging: true }), requestIdHeader: false, genReqId: () => ports.ids.next(),
    routerOptions: { onBadUrl: routingError(ports.ids), onMaxParamLength: routingError(ports.ids), maxParamLength: 256 },
    trustProxy: config.trustProxy ? ["127.0.0.1", "::1"] : false, bodyLimit: config.limits.bodyBytes, requestTimeout: 30000,
    connectionTimeout: 10000, keepAliveTimeout: 5000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: false } },
  });
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
  });
  registerErrors(app);
  registerHealth(app, ports);
  registerKuiSense(app, options.kuisense);
  registerKuiSenseMcp(app, config, options.kuisense ? { latest: () => options.kuisense!.latest() } : undefined, options.mcpAuthorization);
  registerLuckinMcp(app, config, options.luckinMcp);
  registerLuckinPreviewMcp(app,config,options.luckinPreviewMcp);
  registerLuckinOrdersMcp(app,config,options.luckinOrdersMcp);
  if (options.api) registerApi(app, options.api, options.runs, options.events, options.scheduler, options.images, options.memoryReview);
  app.addHook("onReady", async () => { options.events?.start(); });
  app.addHook("preClose", async () => { options.scheduler?.close(); options.events?.close(); });
  app.addHook("onClose", async () => { await options.runs?.close(); await ports.storage.close(); });
  return app;
}
