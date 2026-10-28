import type { RunStatus, ImageAttachment } from "@kuinest/contracts";
export interface OwnerCredential { id: string; username: string; passwordHash: string; }
export interface SessionRecord {
  ownerId: string; tokenHash: string; csrfToken: string; createdAt: number; lastSeenAt: number; expiresAt: number;
}
export interface ConversationRow { id: string; title: string; createdAt: number; updatedAt: number; revision: number; }
export interface MessageRow {
  id: string; conversationId: string; runId: string | null; role: "user" | "assistant"; content: string;
  attachments?: ImageAttachment[];
  status: "complete" | "partial"; createdAt: number; revision: number; seq: number;
}
export interface RunRow {
  id: string; conversationId: string; origin: "user" | "heartbeat"; status: RunStatus;
  requestKey: string; userMessageId: string | null; replyMessageId: string; createdAt: number; lastSequence: number; errorCode: string | null;
}
export interface OwnerInitialization extends OwnerCredential {
  createdAt: number; characterId: string; versionId: string; profileId: string;
}
export interface ApiStorage {
  owner(username: string): OwnerCredential | undefined;
  initializeOwner(record: OwnerInitialization): void;
  changePassword(ownerId: string, expectedHash: string, passwordHash: string, now: number): void;
  unlockLogin(): void;
  reserveLogin(ipKey: string, now: number): number;
  failedLogin(now: number): void;
  createSession(record: SessionRecord, expectedPasswordHash: string): void;
  session(tokenHash: string, now: number, touch?: boolean): SessionRecord | undefined;
  revokeSession(tokenHash: string, now: number): void;
  conversations(ownerId: string, before: readonly [number, string] | undefined, limit: number): ConversationRow[];
  createConversation(ownerId: string, id: string, title: string, now: number): ConversationRow;
  renameConversation(ownerId: string, id: string, title: string, now: number): ConversationRow;
  deleteConversation(ownerId: string, id: string, now: number): void;
  conversation(ownerId: string, id: string): ConversationRow | undefined;
  history(ownerId: string, conversationId: string, beforeSeq: number | undefined, limit: number): { rows: MessageRow[]; revision: number };
  changes(ownerId: string, conversationId: string, after: number, limit: number): { rows: MessageRow[]; revision: number };
  run(ownerId: string, runId: string): { run: RunRow; reply?: MessageRow } | undefined;
  submission(ownerId: string, conversationId: string, clientMessageId: string): { run: RunRow; reply?: MessageRow } | undefined;
}
