import { createHash } from "node:crypto";
import { imageUploadLimits, type SubmitMessageRequest } from "@kuinest/contracts";
import { ensure } from "../application/errors.js";
import type { Submission } from "./types.js";
const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
export function submission(input: SubmitMessageRequest): Submission {
  ensure(input && Object.keys(input).every(key => ["clientMessageId", "text", "allowWebSearch", "imageIds"].includes(key)), "INPUT_INVALID");
  ensure(typeof input.clientMessageId === "string" && uuid.test(input.clientMessageId), "INPUT_INVALID");
  ensure(input.imageIds === undefined || Array.isArray(input.imageIds) && input.imageIds.length > 0 && input.imageIds.length <= imageUploadLimits.maxImagesPerMessage
    && input.imageIds.every(id => typeof id === "string" && uuid.test(id)) && new Set(input.imageIds).size === input.imageIds.length, "INPUT_INVALID");
  const imageIds = Object.freeze([...(input.imageIds ?? [])]);
  ensure(typeof input.text === "string" && (input.text.trim().length > 0 || imageIds.length > 0) && [...input.text].length <= 32000 && Buffer.byteLength(input.text) <= 128 * 1024, "INPUT_INVALID");
  ensure([...input.text].every(char => { const n = char.codePointAt(0)!; return n < 0xd800 || n > 0xdfff; }), "INPUT_INVALID");
  ensure(input.allowWebSearch === undefined || typeof input.allowWebSearch === "boolean", "INPUT_INVALID");
  const allowWebSearch = input.allowWebSearch ?? false;
  // 无图时保持既有JSON字段及顺序，避免旧clientMessageId重试因新空数组产生冲突。
  const inputJson = JSON.stringify({ text: input.text, allowWebSearch, ...(imageIds.length ? { imageIds } : {}) });
  return Object.freeze({ clientMessageId: input.clientMessageId, text: input.text, allowWebSearch, imageIds, inputJson, inputHash: createHash("sha256").update(inputJson, "utf8").digest("hex") });
}
