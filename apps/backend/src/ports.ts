import type { ThinkingOptions } from "./providers/policy.js";
export interface Clock { now(): number; }
export interface IdFactory { next(): string; }
export interface ProviderRequest {
  readonly system: string;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly tools: readonly Readonly<Record<string, unknown>>[];
  readonly options: Readonly<Record<string, unknown>>;
}
export type ProviderEvent =
  | { type: "text_delta" | "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "finish"; reason: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; details?: Readonly<Record<string, unknown>> }
  | { type: "error"; code: string };
export interface ProviderAdapter {
  readonly description?: Readonly<{ provider: string; model: string; maxTokens: number; imageInput?: boolean } & ThinkingOptions>;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
export interface StorageReadiness {
  runtimeReady?: boolean;
  connected: boolean;
  schemaCompatible: boolean;
  sqliteVersion: string | null;
  lease: { held: boolean; expiresAt: number };
}
export interface Storage {
  getReadiness(): Promise<StorageReadiness>;
  close(): Promise<void>;
}
export interface BackendPorts {
  clock: Clock;
  ids: IdFactory;
  provider: ProviderAdapter;
  storage: Storage;
}
