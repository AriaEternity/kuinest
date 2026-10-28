import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { imageFraming } from "../../../apps/backend/dist/images/framing.js";
import { ImageFailure, imageLimits, type ImageInspection } from "../../../apps/backend/dist/images/types.js";
import type { ImageReference } from "../../../apps/backend/dist/images/content.js";
import type { Session, Scope } from "./types.js";
import { check, hash, object, uid, ImportError } from "./safe.js";

export type ImportedImage = { entryId: string; block: number; sourceUid: string; origin: "import-user" | "import-tool"; reference: ImageReference; content: Buffer; inspection: ImageInspection; createdAt: number };
export type ImagePreparation = { images: Map<string, ImportedImage>; gaps: Set<string> };
export const imageKey = (entryId: string, block: number) => JSON.stringify([entryId, block]);
export function imageIdentity(scope: Pick<Scope, "sourceId" | "agentId">, sessionId: string, entryId: string, block: number) {
  check(Number.isSafeInteger(block) && block >= 0, "IMAGE_SOURCE_INVALID");
  const sourceUid = uid("openclaw-image-v1", scope.sourceId, scope.agentId, sessionId, entryId, String(block));
  const bytes = Buffer.from(hash(sourceUid).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return { sourceUid, id: [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-") };
}
function inspect(bytes: Buffer, mimeType: "image/png" | "image/jpeg"): ImageInspection {
  check(imageFraming(bytes) === mimeType, "IMAGE_INVALID");
  // 离线分析保持同步；与HTTP使用同一受限全像素解码子程序，不能在SQLite事务里await。
  const env: NodeJS.ProcessEnv = { PATH: dirname(process.execPath), UV_THREADPOOL_SIZE: "1", SHARP_IGNORE_GLOBAL_LIBVIPS: "1" };
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const result = spawnSync(process.execPath, ["--max-old-space-size=128", fileURLToPath(new URL("../../../apps/backend/dist/images/decode-child.js", import.meta.url))],
    { input: bytes, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env, timeout: 15000, killSignal: "SIGKILL", maxBuffer: 512 });
  if (result.error) check(false, (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "IMAGE_TIMEOUT" : "IMAGE_UNAVAILABLE");
  let value: unknown;
  try { value = JSON.parse(result.stdout.toString("utf8")); } catch { check(false, "IMAGE_UNAVAILABLE"); }
  check(object(value), "IMAGE_UNAVAILABLE");
  if (value.ok === false && Object.keys(value).sort().join(",") === "code,ok" && ["IMAGE_INVALID", "IMAGE_UNSUPPORTED", "IMAGE_TOO_LARGE"].includes(String(value.code)))
    check(false, String(value.code));
  check(result.status === 0 && value.ok === true && Object.keys(value).sort().join(",") === "height,mimeType,ok,width" && value.mimeType === mimeType
    && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height) && Number(value.width) > 0 && Number(value.height) > 0
    && Number(value.width) <= imageLimits.edge && Number(value.height) <= imageLimits.edge && Number(value.width) * Number(value.height) <= imageLimits.pixels, "IMAGE_UNAVAILABLE");
  return Object.freeze({ mimeType, width: Number(value.width), height: Number(value.height), bytes: bytes.length, sha256: hash(bytes), decoder: "sharp-0.35.4" });
}
export function imagePreparer() {
  // 限制整个批次的解码工作量；哈希缓存只复用校验证据，身份仍由条目/块序号决定。
  const cache = new Map<string, ImageInspection>(); let count = 0;
  return (session: Session, scope: Pick<Scope, "sourceId" | "agentId">): ImagePreparation => {
    const images = new Map<string, ImportedImage>(), gaps = new Set<string>();
    for (const raw of session.entries) {
      if (raw.type !== "message" || !object(raw.message) || !Array.isArray(raw.message.content)) continue;
      const message = raw.message, content = message.content as unknown[];
      const imageBlocks = content.map((block, position) => ({ block, position })).filter(({ block }) => object(block) && block.type === "image");
      if (!imageBlocks.length) continue;
      let messageBytes = 0;
      for (const { block, position } of imageBlocks) {
        try {
          check(++count <= 4096, "IMAGE_IMPORT_LIMIT");
          check(object(block) && Object.keys(block).sort().join(",") === "data,mimeType,type"
            && (message.role === "user" || message.role === "toolResult" || message.role === "tool")
            && (block.mimeType === "image/png" || block.mimeType === "image/jpeg"), "IMAGE_SOURCE_UNSUPPORTED");
          check(typeof block.data === "string" && block.data.length > 0 && block.data.length <= 4 * Math.ceil(imageLimits.bytes / 3)
            && block.data.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(block.data), "IMAGE_SOURCE_INVALID");
          const bytes = Buffer.from(block.data, "base64");
          check(bytes.length > 0 && bytes.length <= imageLimits.bytes && bytes.toString("base64") === block.data, "IMAGE_SOURCE_INVALID");
          const sha256 = hash(bytes), cached = cache.get(sha256);
          check(!cached || cached.mimeType === block.mimeType, "IMAGE_INVALID");
          const inspection = cached ?? inspect(bytes, block.mimeType); cache.set(sha256, inspection);
          const identity = imageIdentity(scope, session.id, raw.id, position), createdAt = Date.parse(raw.timestamp);
          check(Number.isSafeInteger(createdAt) && createdAt >= 0, "IMAGE_SOURCE_INVALID");
          const reference: ImageReference = { type: "image", id: identity.id, mimeType: inspection.mimeType, bytes: inspection.bytes, width: inspection.width, height: inspection.height, sha256 };
          images.set(imageKey(raw.id, position), { entryId: raw.id, block: position, sourceUid: identity.sourceUid,
            origin: message.role === "user" ? "import-user" : "import-tool", reference: Object.freeze(reference), content: bytes, inspection, createdAt });
          messageBytes += bytes.length;
        } catch (error) {
          gaps.add(error instanceof ImportError || error instanceof ImageFailure ? error.code : "IMAGE_UNAVAILABLE");
        }
      }
      if (message.role === "user" && (imageBlocks.length > imageLimits.perMessage || messageBytes > imageLimits.messageBytes)) gaps.add("IMAGE_MESSAGE_LIMIT");
    }
    return { images, gaps };
  };
}
