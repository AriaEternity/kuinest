import type { ImageAttachment } from "@kuinest/contracts";
import type { ImageInspection } from "./types.js";
export type ImageOrigin = "upload" | "import-user" | "import-tool";
export type StoredImage = ImageInspection & { id: string; ownerId: string; conversationId: string; origin: ImageOrigin; content: Buffer };
export type ImagePut = {
  id: string; ownerId: string; conversationId: string; content: Uint8Array; inspection: ImageInspection; createdAt: number;
  // HTTP上传在解码完成后由提交事务再次核对有效登录；离线合成端口可省略。
  sessionTokenHash?: string;
};
export interface ImageStorage {
  requireConversation(ownerId: string, conversationId: string): void;
  putUpload(input: ImagePut): { image: ImageAttachment; replay: boolean };
  getPublic(ownerId: string, conversationId: string, id: string): StoredImage;
  getProtocol(ownerId: string, conversationId: string, id: string, expectedHash: string): StoredImage;
}
