import { requestImages } from "../images/content.js";
import { imageTransfer, imageRequestLimits } from "../images/wire.js";
import type { ProviderRequest } from "../ports.js";
import { RunFailure } from "../conversations/types.js";
import type { CharacterConfig, Profile, TokenCounter } from "./types.js";
export function measure(request: ProviderRequest, c: CharacterConfig, p: Profile, counter?: TokenCounter) {
  const images = requestImages(request.messages), transfer = imageTransfer(images);
  // 文本计数器不能冒充视觉计数器；适配计数器必须覆盖同一模型和完整多模态发送投影。
  if (images.length && (p.options.imageInput !== true || counter?.supportsImages !== true)) throw new RunFailure("PROFILE_INVALID");
  if (counter && counter.model !== p.model) throw new RunFailure("PROFILE_INVALID");
  const textBytes = Buffer.byteLength(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools }));
  const input = counter ? counter.count(request) : textBytes + request.messages.length * 128 + 1024;
  if (!Number.isSafeInteger(input) || input < 0) throw new RunFailure("PROFILE_INVALID");
  const output = Number(p.options.maxTokens ?? 32768), available = c.windowTokens - output - c.reserveTokens;
  if (available <= 0) throw new RunFailure("CONTEXT_TOO_LARGE");
  const transferFits = transfer.fits && textBytes + transfer.base64Bytes + 1024 * images.length <= imageRequestLimits.wireBytes;
  return { input, output, reserve: c.reserveTokens, window: c.windowTokens, available, fits: input <= available && transferFits,
    counter: counter?.id ?? "utf8-plus-overhead-v1", verified: counter?.verified ?? false,
    ...(images.length ? { images: { count: transfer.count, originalBytes: transfer.originalBytes, base64Bytes: transfer.base64Bytes }, transferFits } : {}) };
}
