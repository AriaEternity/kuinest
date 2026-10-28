import { createHash } from "node:crypto";
import { validateHistory } from "../providers/messages.js";
import type { ProtocolMessage } from "../providers/types.js";
import { RunFailure } from "../conversations/types.js";
import { contentImages, type ContentPart, type ImageReference } from "./content.js";
import type { ImageInspection } from "./types.js";

// 只由可信装配按claim.ownerId/conversationId创建解析器，不从公开请求接收解析路径或函数。
export type ImageResolver = (image: ImageReference) => ImageInspection & { content: Uint8Array };
export const imageRequestLimits = Object.freeze({ images: 64, originalBytes: 64 * 1024 * 1024, wireBytes: 96 * 1024 * 1024 });
export function imageTransfer(images: readonly ImageReference[]) {
  const originalBytes = images.reduce((sum, image) => sum + image.bytes, 0);
  const base64Bytes = images.reduce((sum, image) => sum + 4 * Math.ceil(image.bytes / 3), 0);
  return { count: images.length, originalBytes, base64Bytes, fits: images.length <= imageRequestLimits.images && originalBytes <= imageRequestLimits.originalBytes };
}
type WireImage = { type: "image_url"; image_url: { url: string } };
type WireText = { type: "text"; text: string };
export function wireMessages(messages: ProtocolMessage[], enabled: boolean, resolver?: ImageResolver): Record<string, unknown>[] {
  messages = validateHistory(messages);
  const images = messages.flatMap(message => message.role === "user" || message.role === "tool" ? contentImages(message.content) : []);
  if (images.length && (!enabled || !resolver)) throw new RunFailure("PROFILE_INVALID");
  if (!imageTransfer(images).fits) throw new RunFailure("CONTEXT_TOO_LARGE");
  const cache = new Map<string, { reference: string; uri: string }>();
  const image = (reference: ImageReference): WireImage => {
    const key = reference.id, canonical = JSON.stringify([reference.id, reference.sha256, reference.mimeType, reference.bytes, reference.width, reference.height]), old = cache.get(key);
    if (old) { if (old.reference !== canonical) throw new RunFailure("PROTOCOL_HISTORY_INCOMPLETE"); return { type: "image_url", image_url: { url: old.uri } }; }
    let resolved: ReturnType<ImageResolver>;
    try { resolved = resolver!(reference); } catch { throw new RunFailure("CONTEXT_INVALID"); }
    if (!resolved || !(resolved.content instanceof Uint8Array)) throw new RunFailure("CONTEXT_INVALID");
    if (resolved.mimeType !== reference.mimeType || resolved.width !== reference.width || resolved.height !== reference.height
      || resolved.bytes !== reference.bytes || resolved.sha256 !== reference.sha256 || resolved.content.byteLength !== reference.bytes) throw new RunFailure("CONTEXT_INVALID");
    const content = Buffer.from(resolved.content);
    if (createHash("sha256").update(content).digest("hex") !== reference.sha256) throw new RunFailure("CONTEXT_INVALID");
    const uri = "data:" + reference.mimeType + ";base64," + content.toString("base64");
    cache.set(key, { reference: canonical, uri }); return { type: "image_url", image_url: { url: uri } };
  };
  const parts = (values: ContentPart[]): (WireImage | WireText)[] => values.map(part => part.type === "image" ? image(part) : { type: "text", text: part.text });
  const result: Record<string, unknown>[] = [];
  for (let at = 0; at < messages.length; at++) {
    const message = messages[at]!;
    if (message.role === "user") { result.push({ role: "user", content: typeof message.content === "string" ? message.content : parts(message.content) }); continue; }
    if (message.role === "assistant") { result.push(message); continue; }
    const group: WireImage[] = [];
    // 完整工具组之后才加图片投影；不把这个传输user消息写进真实对话档案。
    while (at < messages.length) {
      const tool = messages[at]!; if (tool.role !== "tool") break;
      let text: string;
      if (typeof tool.content === "string") text = tool.content;
      else {
        const refs = contentImages(tool.content);
        text = tool.content.filter(part => part.type === "text" && part.text.length > 0).map(part => (part as WireText).text).join("\n");
        if (!text.trim()) text = refs.length ? "(see attached image)" : "(no output)";
        group.push(...refs.map(image));
      }
      result.push({ role: "tool", tool_call_id: tool.tool_call_id, content: text }); at++;
    }
    at--;
    if (group.length) result.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...group] });
  }
  return result;
}
