// 仅导出仓库维护的 JSON Schema Draft 7；不接受外部 schema 或编译代码。
type Schema = Record<string, unknown>;
const id: Schema = { type: "string", minLength: 1, maxLength: 256 };
const text: Schema = { type: "string" };
const time: Schema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$" };
const integer: Schema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const revision: Schema = { ...integer, minimum: 1 };
const bool: Schema = { type: "boolean" };
const uuid: Schema = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" };
const ref = (name: string): Schema => ({ $ref: "urn:kuinest:0.3:" + name + "#" });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", additionalProperties: false, properties, required });
const array = (items: Schema): Schema => ({ type: "array", items });
const named = (name: string, value: Schema): Schema => ({ $schema: "http://json-schema.org/draft-07/schema#", $id: "urn:kuinest:0.3:" + name, ...value });
const nullableCursor: Schema = { anyOf: [id, { type: "null" }] };
const runStatus: Schema = { enum: ["accepted", "running", "completed", "failed", "cancelled"] };
const image = object({ id: uuid, mimeType: { enum: ["image/png", "image/jpeg"] }, bytes: { type: "integer", minimum: 1, maximum: 10485760 },
  width: { type: "integer", minimum: 1, maximum: 16384 }, height: { type: "integer", minimum: 1, maximum: 16384 } });
const images: Schema = { type: "array", items: image, minItems: 1, maxItems: 8 };
const imageIds: Schema = { type: "array", items: uuid, minItems: 1, maxItems: 8, uniqueItems: true };
const messageBase = { id, conversationId: id, runId: id, content: text, status: { enum: ["complete", "partial"] }, createdAt: time, revision };
const messageRequired = ["id", "conversationId", "role", "content", "status", "createdAt", "revision"];
const message: Schema = { oneOf: [
  object({ ...messageBase, role: { const: "user" }, attachments: images }, messageRequired),
  object({ ...messageBase, role: { const: "assistant" } }, messageRequired),
] };
const errorDetail = object({ code: id, message: text });
const envelope = { runId: id, sequence: revision, occurredAt: time };
const event = (type: string, extra: Record<string, Schema>, optional: string[] = []): Schema => {
  const props = { ...envelope, type: { const: type }, ...extra };
  return object(props, Object.keys(props).filter(key => !optional.includes(key)));
};
export const schemas = {
  memoryProposal: named("memoryProposal", object({id,characterId:id,revision,content:{type:"string",minLength:1,maxLength:16000},contentSha256:{type:"string",pattern:"^[0-9a-f]{64}$"},status:{enum:["pending","confirmed","rejected"]},source:{enum:["user","tool"]},createdAt:time,updatedAt:time,decidedAt:{anyOf:[time,{type:"null"}]},memoryKey:nullableCursor})),
  memoryProposalPage: named("memoryProposalPage",object({items:{type:"array",items:ref("memoryProposal"),maxItems:50},nextCursor:nullableCursor})),
  proposeMemoryRequest: named("proposeMemoryRequest",object({clientRequestId:uuid,content:{type:"string",minLength:1,maxLength:16000,pattern:"\\S"}})),
  reviewMemoryRequest: named("reviewMemoryRequest",object({revision,contentSha256:{type:"string",pattern:"^[0-9a-f]{64}$"}})),
  editMemoryRequest: named("editMemoryRequest",object({revision,contentSha256:{type:"string",pattern:"^[0-9a-f]{64}$"},content:{type:"string",minLength:1,maxLength:16000,pattern:"\\S"}})),
  healthOk: named("healthOk", object({ status: { const: "ok" } })),
  healthUnavailable: named("healthUnavailable", object({ status: { const: "unavailable" } })),
  authSession: named("authSession", object({ ownerId: id, expiresAt: time, csrfToken: id })),
  loginRequest: named("loginRequest", object({ username: { type: "string", minLength: 1, maxLength: 128 }, password: { type: "string", minLength: 1, maxLength: 1024 } })),
  apiMeta: named("apiMeta", object({
    apiVersion: { const: "0.3" }, mode: { enum: ["synthetic", "private"] },
    capabilities: object({ chat: bool, history: bool, resumableEvents: bool, messageChanges: bool, webSearch: bool, proactiveMessages: bool, imageAttachments: bool }),
    imageLimits: object({ mimeTypes: { const: ["image/png", "image/jpeg"] }, maxBytesPerImage: { const: 10485760 }, maxImagesPerMessage: { const: 8 }, maxBytesPerMessage: { const: 20971520 }, maxPixels: { const: 64000000 }, maxEdge: { const: 16384 } }),
  })),
  imageAttachment: named("imageAttachment", image),
  conversationMessage: named("conversationMessage", message),
  submitMessageRequest: named("submitMessageRequest", { oneOf: [
    object({ clientMessageId: uuid, text: { type: "string", minLength: 1, maxLength: 32000, pattern: "\\S" }, allowWebSearch: bool, imageIds }, ["clientMessageId", "text"]),
    object({ clientMessageId: uuid, text: { type: "string", maxLength: 32000, pattern: "^\\s*$" }, allowWebSearch: bool, imageIds }, ["clientMessageId", "text", "imageIds"]),
  ] }),
  acceptedSubmission: named("acceptedSubmission", object({ conversationId: id, clientMessageId: uuid, messageId: id, replyId: id, runId: id, acceptedAt: time })),
  runSnapshot: named("runSnapshot", object({ runId: id, origin: { enum: ["user", "heartbeat"] }, conversationId: id, status: runStatus, lastSequence: integer, reply: ref("conversationMessage"), error: errorDetail }, ["runId", "origin", "conversationId", "status", "lastSequence"])),
  cancelAccepted: named("cancelAccepted", object({ accepted: { const: true }, run: ref("runSnapshot") })),
  historyPage: named("historyPage", object({ items: array(ref("conversationMessage")), nextCursor: nullableCursor, revision: integer })),
  messageChanges: named("messageChanges", object({ items: array(ref("conversationMessage")), throughRevision: integer, hasMore: bool })),
  publicConversation: named("publicConversation", object({ id, title: { type: "string", maxLength: 100 }, updatedAt: time, revision: integer })),
  renameConversationRequest: named("renameConversationRequest", object({ title: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" } })),
  conversationPage: named("conversationPage", object({ items: array(ref("publicConversation")), nextCursor: nullableCursor })),
  submissionLookup: named("submissionLookup", object({ submission: ref("acceptedSubmission"), run: ref("runSnapshot") })),
  kuisenseContextPacket: named("kuisenseContextPacket", { type: "object", additionalProperties: true, properties: { schema_version: { const: 1 } }, required: ["schema_version"] }),
  kuisenseUploadReceipt: named("kuisenseUploadReceipt", object({ status: { const: "ok" }, received_at: time })),
  apiError: named("apiError", object({ error: errorDetail, requestId: id })),
  runEvent: named("runEvent", { oneOf: [
    event("run.accepted", { origin: { const: "user" }, submission: ref("acceptedSubmission") }),
    event("run.accepted", { origin: { const: "heartbeat" }, conversationId: id, replyId: id, acceptedAt: time }),
    event("run.started", {}),
    event("reply.delta", { replyId: id, text, revision }),
    event("run.completed", { reply: ref("conversationMessage") }, ["reply"]),
    event("run.failed", { code: id, message: text, partialReply: ref("conversationMessage") }, ["partialReply"]),
    event("run.cancelled", { partialReply: ref("conversationMessage") }, ["partialReply"]),
  ] }),
} as const;
export const allSchemas = Object.values(schemas);
// Schema 只校验形状；归属、字节数、消息与运行的语义关联由后续服务层负责。
