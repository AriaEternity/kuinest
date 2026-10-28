import type { FastifyInstance, FastifyRequest } from "fastify";
import type { KuiSenseContextPacket } from "@kuinest/contracts";
import { schemas } from "@kuinest/contracts";
import type { KuiSenseService } from "../../application/kuisense.js";
import { ensure } from "../../application/errors.js";

const ref = (name: string) => ({ $ref: "urn:kuinest:0.3:" + name + "#" });
const emptyQuery = { type: "object", properties: {}, required: [], additionalProperties: false };
const errors = Object.fromEntries([400, 401, 404, 413, 500, 503].map(status => [status, ref("apiError")]));
const response = (name: string, status = 200) => ({ ...errors, [status]: ref(name) });
const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
};

export function registerKuiSense(app: FastifyInstance, service?: KuiSenseService): void {
  app.register(async scope => {
    scope.addSchema(schemas.apiError);
    scope.addSchema(schemas.kuisenseContextPacket);
    scope.addSchema(schemas.kuisenseUploadReceipt);

    const authenticate = async (request: FastifyRequest) => {
      ensure(service, "SERVICE_NOT_READY");
      service.authorize(header(request, "authorization"));
    };
    const authenticateJson = async (request: FastifyRequest) => {
      await authenticate(request);
      ensure(header(request, "content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json", "INPUT_INVALID");
    };

    scope.post<{ Body: KuiSenseContextPacket }>("/api/kuisense/context", {
      onRequest: authenticateJson,
      schema: { querystring: emptyQuery, body: ref("kuisenseContextPacket"), response: response("kuisenseUploadReceipt") },
    }, async request => service!.upload(request.body));

    scope.get("/api/kuisense/context/latest", {
      onRequest: authenticate,
      schema: { querystring: emptyQuery, response: response("kuisenseContextPacket") },
    }, async () => service!.latest());
  });
}
