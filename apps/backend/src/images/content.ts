import type { ImageAttachment } from "@kuinest/contracts";
import { RunFailure } from "../conversations/types.js";
import { imageHashPattern, imageLimits } from "./types.js";

export type ImageReference = Readonly<ImageAttachment & { type: "image"; sha256: string }>;
export type TextPart = Readonly<{ type: "text"; text: string }>;
export type ContentPart = TextPart | ImageReference;
export type MessageContent = string | ContentPart[];
const fail = (): never => { throw new RunFailure("PROTOCOL_HISTORY_INCOMPLETE"); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function readImageReference(value: unknown): ImageReference {
  if (!object(value) || !keys(value, ["type", "id", "sha256", "mimeType", "bytes", "width", "height"]) || value.type !== "image"
    || typeof value.id !== "string" || !uuid.test(value.id) || typeof value.sha256 !== "string" || !imageHashPattern.test(value.sha256)
    || value.mimeType !== "image/png" && value.mimeType !== "image/jpeg"
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > imageLimits.bytes
    || !Number.isSafeInteger(value.width) || Number(value.width) < 1 || Number(value.width) > imageLimits.edge
    || !Number.isSafeInteger(value.height) || Number(value.height) < 1 || Number(value.height) > imageLimits.edge
    || Number(value.width) * Number(value.height) > imageLimits.pixels) return fail();
  return value as ImageReference;
}
export function readContent(value: unknown): MessageContent {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) return fail();
  let pictures = 0, bytes = 0;
  for (const part of value) {
    if (object(part) && part.type === "text" && keys(part, ["type", "text"]) && typeof part.text === "string") continue;
    const image = readImageReference(part); pictures++; bytes += image.bytes;
  }
  if (pictures > 64 || bytes > 64 * 1024 * 1024) throw new RunFailure("CONTEXT_TOO_LARGE");
  return value as ContentPart[];
}
export function contentText(value: MessageContent): string {
  return typeof value === "string" ? value : value.filter((p): p is TextPart => p.type === "text").map(p => p.text).join("\n");
}
export function contentImages(value: MessageContent): ImageReference[] {
  return typeof value === "string" ? [] : value.filter((p): p is ImageReference => p.type === "image");
}
export function requestImages(messages: readonly Readonly<Record<string, unknown>>[]): ImageReference[] {
  return messages.flatMap(message => message.role === "user" || message.role === "tool" ? contentImages(readContent(message.content)) : []);
}
