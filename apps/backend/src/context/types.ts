import type { Claim } from "../conversations/types.js";
import type { Clock, IdFactory, ProviderAdapter, ProviderRequest } from "../ports.js";
import type { ProtocolStorage, ToolExecutor } from "../providers/types.js";
export type Entry = { id: string; parentId: string | null; branchId: string; kind: string; payload: unknown };
export type Document = { name: string; bytes: Uint8Array; sha256: string };
export type MemoryVersion = { id: string; characterId: string; key: string; version: number; parentId: string | null; content: string; provenance: unknown; sourceToolCallId: string | null; confirmed?: boolean };
export type Profile = { id: string; provider: "mock" | "deepseek"; model: string; endpoint: string | null; options: Record<string, unknown>; status: string };
export type CharacterConfig = {
  compiler: "kuinest-v1"; documentOrder: string[]; memoryReadKeys: string[]; memoryWriteKeys: string[];
  timezone: string; memoryAppendKeys: string[]; memoryReplaceEnabled: boolean; memoryReviewEnabled: boolean; expressionEnabled: boolean; expressionMode: "reference" | "project-instructions";
  fileChars: number; totalChars: number; windowTokens: number; reserveTokens: number;
};
export type Pinned = {
  origin?: "user" | "heartbeat"; allowWebSearch?: boolean; allowMemoryWrite?: boolean; task?: { documentVersionId: string; documentName: string; revision: number; silenceMarkers: string[]; timezone: string };
  snapshotId: string; characterId: string; versionId: string; profile: Profile; config: unknown;
  documents: Document[]; memories: MemoryVersion[]; entries: Entry[]; boundary: string; branchId: string; receivedAt: number;
};
export type Manifest = Record<string, unknown>;
export interface ContextStorage {
  load(claim: Claim): Pinned;
  save(claim: Claim, manifest: Manifest, now: number, compaction?: { id: string; payload: unknown; callId: string }): void;
}
export interface TokenCounter { id: string; model: string; verified: boolean; supportsImages?: boolean; count(request: ProviderRequest): number; }
export interface ContextRuntime {
  readonly supportsImages?: boolean;
  stream(claim: Claim, signal: AbortSignal): AsyncIterable<import("../ports.js").ProviderEvent>;
}
export type ContextDependencies = { storage: ContextStorage; protocol: ProtocolStorage; resolve(profile: Profile, purpose: "reply" | "compaction", claim: Claim): ProviderAdapter; tools?: ToolExecutor; toolsForRun?(claim: Claim, input: Pinned): ToolExecutor; clock: Clock; ids: IdFactory; counter?: TokenCounter };
