import type { FastifyInstance } from "fastify";
import { schemas } from "@kuinest/contracts";
import type { BackendPorts } from "../ports.js";

export function sqliteSupported(version: string | null): boolean {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major > 3 || (major === 3 && (minor > 53 || (minor === 53 && patch >= 1)));
}
export function registerHealth(app: FastifyInstance, ports: BackendPorts): void {
  let closing = false;
  app.addHook("preClose", async () => { closing = true; });
  app.get("/health/live", { schema: { response: { 200: schemas.healthOk } } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { schema: { response: { 200: schemas.healthOk, 503: schemas.healthUnavailable } } }, async (_request, reply) => {
    try {
      const state = await ports.storage.getReadiness();
      if (!closing && state.runtimeReady !== false && state.connected && state.schemaCompatible && sqliteSupported(state.sqliteVersion) && state.lease.held && state.lease.expiresAt > ports.clock.now())
        return { status: "ok" };
    } catch {
      app.log.warn({ code: "READINESS_UNAVAILABLE" }, "服务尚未就绪。");
    }
    return reply.code(503).send({ status: "unavailable" });
  });
}
