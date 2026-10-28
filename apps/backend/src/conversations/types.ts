import type { AcceptedSubmission } from "@kuinest/contracts";
import type { IdFactory, ProviderRequest } from "../ports.js";
export interface Submission {
  readonly clientMessageId: string; readonly text: string; readonly allowWebSearch: boolean; readonly imageIds: readonly string[];
  readonly inputJson: string; readonly inputHash: string;
}
export interface Claim {
  readonly id: string; readonly conversationId: string; readonly ownerId: string;
  readonly fence: number; readonly claimOwner: string; readonly contextUserEntryId: string | null;
  readonly origin?: "user" | "heartbeat"; readonly contextBoundaryId?: string;
}
export type FailureCode = "RUN_INTERRUPTED" | "UPSTREAM_INCOMPLETE" | "OUTPUT_LIMIT" | "EMPTY_REPLY" | "CONTEXT_TOO_LARGE" | "RUN_TIMEOUT" | "UPSTREAM_UNAVAILABLE" | "TOOL_LIMIT" | "UPSTREAM_AUTH" | "UPSTREAM_RATE_LIMIT" | "UPSTREAM_TIMEOUT" | "UPSTREAM_REFUSED" | "PROTOCOL_HISTORY_INCOMPLETE" | "CONTEXT_INVALID" | "CONTEXT_UNVERIFIED" | "PROFILE_INVALID" | "MEMORY_INDEX_REQUIRED" | "COMPACTION_FAILED";
export class RunFailure extends Error {
  constructor(readonly code: FailureCode, readonly retryAfterSeconds?: number) { super("本次生成未能完成。"); }
}
export interface RunStorage {
  readonly supportsImages?: boolean;
  submit(owner: string, conversation: string, input: Submission, now: number, ids: IdFactory, limits: { perConversationQueue: number; globalQueue: number }): AcceptedSubmission;
  claim(now: number, ids: IdFactory): Claim | undefined;
  context(claim: Claim): ProviderRequest;
  append(claim: Claim, text: string, now: number): boolean;
  finish(claim: Claim, status: "completed" | "failed" | "cancelled", code: FailureCode | undefined, now: number, ids: IdFactory, candidate?: string): boolean;
  cancel(owner: string, id: string, now: number, ids: IdFactory): void;
  control(claim: Claim): "running" | "cancelled" | "terminal";
  recover(now: number, ids: IdFactory): number;
}
