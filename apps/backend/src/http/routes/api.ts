import { registerMemoryReview } from "./memory-review.js";
import type { MemoryReviewAccess } from "../../storage/memory-review.js";
import { registerImages } from "./images.js";
import type { ImageService } from "../../images/service.js";
import type { Scheduler } from "../../scheduler/tick.js";
import type { EventStreams } from "./events.js";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { allSchemas, imageUploadLimits } from "@kuinest/contracts";
import type { RunService } from "../../conversations/service.js";
import type { SubmitMessageRequest } from "@kuinest/contracts";
import type { ApiServices } from "../../application/service.js";
import type { SessionRecord } from "../../application/ports.js";
import { ensure } from "../../application/errors.js";
import { publicSession } from "../../auth/sessions.js";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const id = { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\u0000]+$" };
const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" };
const cursor = { type: "string", minLength: 1, maxLength: 256 };
const decimal = { type: "string", pattern: "^(?:0|[1-9][0-9]{0,15})$" };
const pageQuery = object({ cursor, limit: { type: "string", pattern: "^(?:[1-9]|[1-9][0-9]|100)$" } });
const ref = (name: string) => ({ $ref: "urn:kuinest:0.3:" + name + "#" });
const errors = Object.fromEntries([400, 401, 403, 404, 409, 410, 413, 429, 500, 503].map(status => [status, ref("apiError")]));
const response = (name: string, status = 200) => ({ ...errors, [status]: ref(name) });
const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name]; return typeof value === "string" ? value : undefined;
};
function number(value: string): number { const n = Number(value); ensure(Number.isSafeInteger(n) && n >= 0, "CURSOR_INVALID"); return n; }
function emptyBody(request: FastifyRequest): void {
  ensure(request.body === undefined || (request.body !== null && typeof request.body === "object" && !Array.isArray(request.body) && Object.keys(request.body).length === 0), "INPUT_INVALID");
}
export function registerApi(app: FastifyInstance, api: ApiServices, runs?: RunService, events?: EventStreams, scheduler?: Scheduler, images?: ImageService, memoryReview?: MemoryReviewAccess): void {
  app.register(async scope => {
    await scope.register(cookie);
    allSchemas.forEach(schema => scope.addSchema(schema));
    scope.addHook("onRoute", route => { route.schema = { querystring: object({}), ...route.schema }; });
    const sessions = new WeakMap<FastifyRequest, SessionRecord>();
    const authenticate = async (request: FastifyRequest, touch = true) => {
      const raw = header(request, "cookie") ?? "";
      const occurrences = raw.split(";").filter(part => part.trim().split("=")[0] === api.sessions.cookieName).length;
      ensure(occurrences === 1, "AUTH_REQUIRED");
      const value = request.cookies[api.sessions.cookieName];
      const session = api.sessions.authenticate(value, true, touch);
      sessions.set(request, session);
      if (!["GET", "HEAD"].includes(request.method)) {
        api.sessions.origin(header(request, "origin"));
        api.sessions.csrf(session, header(request, "x-csrf-token"));
      }
    };
    const authenticateStream = async (request: FastifyRequest) => authenticate(request, false);
    const authenticateRequest = async (request: FastifyRequest) => authenticate(request);
    const owner = (request: FastifyRequest) => sessions.get(request)!.ownerId;
    registerImages(scope, api, authenticateRequest, request => sessions.get(request)!, images);
    const secure = { httpOnly: true, sameSite: "strict" as const, secure: api.sessions.secure, path: "/" };
    const jsonRequest = async (request: FastifyRequest) => { ensure(header(request, "content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json", "INPUT_INVALID"); };

    registerMemoryReview(scope,api,authenticateRequest,jsonRequest,owner,memoryReview);
    scope.post<{ Body: { username: string; password: string } }>("/api/v1/auth/login", {
      schema: { body: ref("loginRequest"), response: response("authSession") },
      onRequest: async request => { api.sessions.origin(header(request, "origin")); await jsonRequest(request); },
    }, async (request, reply) => {
      const { token, session } = await api.sessions.login(request.body.username, request.body.password, request.ip);
      reply.setCookie(api.sessions.cookieName, token, { ...secure, maxAge: 7 * 86400 });
      return publicSession(session);
    });
    scope.get("/api/v1/auth/session", { preHandler: authenticateRequest, schema: { response: response("authSession") } }, async request => publicSession(sessions.get(request)!));
    scope.post("/api/v1/auth/logout", { preHandler: authenticateRequest, schema: { response: errors } }, async (request, reply) => {
      emptyBody(request); api.sessions.logout(sessions.get(request)!); reply.clearCookie(api.sessions.cookieName, secure); return reply.code(204).send();
    });
    scope.get("/api/v1/meta", { preHandler: authenticateRequest, schema: { response: response("apiMeta") } }, async () => ({
      apiVersion: "0.3", mode: api.sessions.config.mode,
      capabilities: { chat: runs?.ready ?? false, history: true, resumableEvents: events?.ready ?? false, messageChanges: true, webSearch: !!runs?.ready && runs.webSearch, proactiveMessages: !!runs?.ready && (scheduler?.ready ?? false), imageAttachments: !!runs?.ready && runs.imageAttachments && (images?.ready ?? false) },
      imageLimits: imageUploadLimits,
    }));
    scope.get<{ Querystring: { cursor?: string; limit?: string } }>("/api/v1/conversations", {
      preHandler: authenticateRequest, schema: { querystring: pageQuery, response: response("conversationPage") },
    }, async request => api.queries.conversations(owner(request), request.query.cursor, Number(request.query.limit ?? 50)));
    scope.post<{ Body: { title?: string } }>("/api/v1/conversations", {
      onRequest: jsonRequest, preHandler: authenticateRequest,
      schema: { body: object({ title: { type: "string", maxLength: 100 } }), response: response("publicConversation", 201) },
    }, async (request, reply) => reply.code(201).send(api.queries.createConversation(owner(request), request.body.title)));
    scope.get<{ Params: { id: string } }>("/api/v1/conversations/:id", {
      preHandler: authenticateRequest, schema: { params: object({ id }, ["id"]), response: response("publicConversation") },
    }, async request => api.queries.conversation(owner(request), request.params.id));
    scope.patch<{ Params: { id: string }; Body: { title: string } }>("/api/v1/conversations/:id", {
      onRequest: jsonRequest, preHandler: authenticateRequest,
      schema: { params: object({ id }, ["id"]), body: ref("renameConversationRequest"), response: response("publicConversation") },
    }, async request => api.queries.renameConversation(owner(request), request.params.id, request.body.title));
    scope.delete<{ Params: { id: string } }>("/api/v1/conversations/:id", {
      preHandler: authenticateRequest, schema: { params: object({ id }, ["id"]), response: errors },
    }, async (request, reply) => {
      emptyBody(request); api.queries.deleteConversation(owner(request), request.params.id); return reply.code(204).send();
    });
    scope.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>("/api/v1/conversations/:id/messages", {
      preHandler: authenticateRequest, schema: { params: object({ id }, ["id"]), querystring: pageQuery, response: response("historyPage") },
    }, async request => api.queries.history(owner(request), request.params.id, request.query.cursor, Number(request.query.limit ?? 50)));
    scope.get<{ Params: { id: string }; Querystring: { afterRevision: string } }>("/api/v1/conversations/:id/changes", {
      preHandler: authenticateRequest, schema: { params: object({ id }, ["id"]), querystring: object({ afterRevision: decimal }, ["afterRevision"]), response: response("messageChanges") },
    }, async request => api.queries.changes(owner(request), request.params.id, number(request.query.afterRevision)));
    scope.get<{ Params: { id: string; client: string } }>("/api/v1/conversations/:id/submissions/:client", {
      preHandler: authenticateRequest, schema: { params: object({ id, client: uuid }, ["id", "client"]), response: response("submissionLookup") },
    }, async request => api.queries.submission(owner(request), request.params.id, request.params.client));
    scope.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", {
      preHandler: authenticateRequest, schema: { params: object({ runId: id }, ["runId"]), response: response("runSnapshot") },
    }, async request => api.queries.run(owner(request), request.params.runId));
    scope.post<{ Params: { id: string }; Body: SubmitMessageRequest }>("/api/v1/conversations/:id/messages", {
      onRequest: jsonRequest, preHandler: authenticateRequest, schema: { params: object({ id }, ["id"]), body: ref("submitMessageRequest"), response: response("acceptedSubmission", 202) },
    }, async (request, reply) => {
      ensure(Buffer.byteLength(request.body.text) <= 128 * 1024, "INPUT_INVALID");
      api.queries.requireConversation(owner(request), request.params.id);
      ensure(runs, "SERVICE_NOT_READY");
      return reply.code(202).send(runs.submit(owner(request), request.params.id, request.body));
    });
    scope.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/cancel", {
      preHandler: authenticateRequest, schema: { params: object({ runId: id }, ["runId"]), response: response("cancelAccepted", 202) },
    }, async (request, reply) => { emptyBody(request); api.queries.run(owner(request), request.params.runId); ensure(runs, "SERVICE_NOT_READY"); return reply.code(202).send(runs.cancel(owner(request), request.params.runId)); });
    scope.get<{ Params: { runId: string }; Querystring: { afterSequence?: string } }>("/api/v1/runs/:runId/events", {
      preHandler: authenticateStream, schema: { params: object({ runId: id }, ["runId"]), querystring: object({ afterSequence: decimal }), response: errors },
    }, async (request, reply) => {
      const run = api.queries.run(owner(request), request.params.runId), last = header(request, "last-event-id");
      const input = last || request.query.afterSequence || "0";
      ensure(/^(?:0|[1-9][0-9]{0,15})$/.test(input) && number(input) <= run.lastSequence, "CURSOR_INVALID");
      ensure(events, "SERVICE_NOT_READY");
      events.open(sessions.get(request)!, request.params.runId, number(input), reply);
      return reply;
    });
  });
}
