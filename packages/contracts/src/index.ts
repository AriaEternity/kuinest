export type { MemoryProposal, MemoryProposalPage, ProposeMemoryRequest, ReviewMemoryRequest, EditMemoryRequest } from "./memory.js";
// 葵栖公开接口设计草案 0.3；不代表服务已实现。
export type RunStatus = "accepted" | "running" | "completed" | "failed" | "cancelled";

export interface AuthSession {
  ownerId: string;
  expiresAt: string;
  csrfToken: string;
}
export interface LoginRequest {
  username: string;
  password: string;
}
export interface ApiMeta {
  apiVersion: "0.3";
  mode: "synthetic" | "private";
  capabilities: {
    chat: boolean;
    history: boolean;
    resumableEvents: boolean;
    messageChanges: boolean;
    webSearch: boolean;
    proactiveMessages: boolean;
    imageAttachments: boolean;
  };
  imageLimits: typeof imageUploadLimits;
}
export const imageUploadLimits = Object.freeze({
  mimeTypes: Object.freeze(["image/png", "image/jpeg"] as const),
  maxBytesPerImage: 10 * 1024 * 1024, maxImagesPerMessage: 8, maxBytesPerMessage: 20 * 1024 * 1024,
  maxPixels: 64000000, maxEdge: 16384,
});
export interface ImageAttachment {
  id: string;
  mimeType: "image/png" | "image/jpeg";
  bytes: number;
  width: number;
  height: number;
}
export interface ConversationMessage {
  id: string;
  conversationId: string;
  // 葵栖运行产生的消息必须携带；无运行关联的导入历史省略。
  runId?: string;
  role: "user" | "assistant";
  content: string;
  // 仅用户消息允许附件；隐藏工具图片不属于公开消息。
  attachments?: ImageAttachment[];
  status: "complete" | "partial";
  createdAt: string;
  revision: number;
}
export interface SubmitMessageRequest {
  clientMessageId: string;
  text: string;
  allowWebSearch?: boolean;
  imageIds?: string[];
}
export interface RenameConversationRequest { title: string; }
export interface AcceptedSubmission {
  conversationId: string;
  clientMessageId: string;
  messageId: string;
  replyId: string;
  runId: string;
  acceptedAt: string;
}
export interface RunSnapshot {
  runId: string;
  origin: "user" | "heartbeat";
  conversationId: string;
  status: RunStatus;
  lastSequence: number;
  reply?: ConversationMessage;
  error?: { code: string; message: string };
}
export interface CancelAccepted {
  accepted: true;
  run: RunSnapshot;
}
export interface HistoryPage {
  items: ConversationMessage[];
  nextCursor: string | null;
  revision: number;
}
export interface MessageChanges {
  items: ConversationMessage[];
  throughRevision: number;
  hasMore: boolean;
}
export interface PublicConversation {
  id: string;
  title: string;
  updatedAt: string;
  revision: number;
}
export interface ConversationPage {
  items: PublicConversation[];
  nextCursor: string | null;
}
export interface SubmissionLookup {
  submission: AcceptedSubmission;
  run: RunSnapshot;
}

export interface KuiSenseContextPacket {
  schema_version: 1;
  [key: string]: unknown;
}
export interface KuiSenseUploadReceipt {
  status: "ok";
  received_at: string;
}
export interface ApiError {
  error: { code: string; message: string };
  requestId: string;
}
type EventEnvelope = {
  runId: string;
  sequence: number;
  occurredAt: string;
};
export type RunEvent = EventEnvelope & (
  | { type: "run.accepted"; origin: "user"; submission: AcceptedSubmission }
  | { type: "run.accepted"; origin: "heartbeat"; conversationId: string; replyId: string; acceptedAt: string }
  | { type: "run.started" }
  | { type: "reply.delta"; replyId: string; text: string; revision: number }
  | { type: "run.completed"; reply?: ConversationMessage }
  | { type: "run.failed"; code: string; message: string; partialReply?: ConversationMessage }
  | { type: "run.cancelled"; partialReply?: ConversationMessage }
);
// 普通用户运行的 completed 必须有 reply；省略仅用于静默主动任务。
// 后台完整模型消息采用独立结构，不能以本文件替代。

export { kuisenseMcp } from "./kuisense-mcp.js";

export { schemas, allSchemas } from "./schemas/index.js";

export { readContract } from "./validate.js";

export { luckinMcp, luckinTools } from "./luckin-mcp.js";
export type { LuckinToolName, LuckinArguments } from "./luckin-mcp.js";

export {luckinPreviewMcp,luckinPreviewTools} from "./luckin-preview-mcp.js";
export type {LuckinPreviewToolName} from "./luckin-preview-mcp.js";
export * from "./luckin-orders-mcp.js";
export * from "./mcd-mcp.js";
