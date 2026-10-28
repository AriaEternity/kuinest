import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiServices } from "../../application/service.js";
import type { SessionRecord } from "../../application/ports.js";
import { ensure } from "../../application/errors.js";
import type { ImageService } from "../../images/service.js";
import { ImageFailure, imageLimits, type ImageMime } from "../../images/types.js";

type Params = { id: string; imageId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ref = (name: string) => ({ $ref: "urn:kuinest:0.3:" + name + "#" });
const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map(code => [code, ref("apiError")]));
export function registerImages(app: FastifyInstance, api: ApiServices, authenticate: (request: FastifyRequest) => Promise<void>, session: (request: FastifyRequest) => SessionRecord, images?: ImageService): void {
  app.register(async scope => {
    let busy = false;
    const held = new WeakSet<FastifyRequest>();
    const release = (request: FastifyRequest) => { if (held.delete(request)) busy = false; };
    const authorize = async (request: FastifyRequest) => {
      await authenticate(request);
      const p = request.params as Params;
      ensure(typeof p.id === "string" && p.id.length > 0 && p.id.length <= 256 && !p.id.includes("\u0000") && typeof p.imageId === "string" && uuid.test(p.imageId), "INPUT_INVALID");
      api.queries.requireConversation(session(request).ownerId, p.id);
    };
    scope.addContentTypeParser(["image/png", "image/jpeg"], { parseAs: "buffer", bodyLimit: imageLimits.bytes }, (_request, body, done) => done(null, body));
    scope.put<{ Params: Params; Body: Buffer }>("/api/v1/conversations/:id/images/:imageId", {
      bodyLimit: imageLimits.bytes, schema: { response: { ...errors, 200: ref("imageAttachment"), 201: ref("imageAttachment") } },
      onRequest: async request => {
        await authorize(request);
        const mime = request.headers["content-type"];
        if (mime !== "image/png" && mime !== "image/jpeg") throw new ImageFailure("IMAGE_UNSUPPORTED");
        ensure(request.headers["content-encoding"] === undefined || request.headers["content-encoding"] === "identity", "INPUT_INVALID");
        ensure(images, "SERVICE_NOT_READY");
        if (busy) throw new ImageFailure("IMAGE_BUSY");
        busy = true; held.add(request);
        request.raw.once("aborted", () => release(request));
      },
      onError: async request => release(request),
      onResponse: async request => release(request),
    }, async (request, reply) => {
      ensure(images && Buffer.isBuffer(request.body), "INPUT_INVALID");
      const controller = new AbortController();
      const abort = () => controller.abort();
      const disconnected = () => { if (!reply.raw.writableEnded) abort(); };
      request.raw.once("aborted", abort); reply.raw.once("close", disconnected);
      if (request.raw.aborted || reply.raw.destroyed) abort();
      try {
        const result = await images.upload(session(request), request.params.id, request.params.imageId, request.headers["content-type"] as ImageMime, request.body, controller.signal);
        return reply.code(result.replay ? 200 : 201).send(result.image);
      } finally {
        request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", disconnected); release(request);
      }
    });
    scope.get<{ Params: Params }>("/api/v1/conversations/:id/images/:imageId", {
      onRequest: authorize, schema: { response: errors },
    }, async (request, reply) => {
      ensure(images, "SERVICE_NOT_READY");
      const image = images.store.getPublic(session(request).ownerId, request.params.id, request.params.imageId);
      return reply.type(image.mimeType).header("Content-Length", String(image.bytes))
        .header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox").header("Referrer-Policy", "no-referrer").send(image.content);
    });
    scope.addHook("preClose", async () => { await images?.close(); });
  });
}
