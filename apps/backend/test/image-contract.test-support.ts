import { test } from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { allSchemas, readContract, imageUploadLimits } from "@kuinest/contracts";
const image = { id: "10000000-0000-4000-8000-000000000001", mimeType: "image/png", bytes: 256, width: 31, height: 19 };
test("IMG05：Ajv与公开解释器一致校验图文/仅图、数量/去重及隐藏附件", () => {
  const ajv = new Ajv({ strict: true }); allSchemas.forEach(s => ajv.addSchema(s));
  const clientMessageId = "10000000-0000-4000-8000-000000000002", images = [image.id];
  const message = { id: "synthetic-user", conversationId: "synthetic-conversation", role: "user", content: "", attachments: [image], status: "complete", createdAt: "2026-09-13T00:00:00Z", revision: 1 };
  const meta = { apiVersion: "0.3", mode: "synthetic", capabilities: { chat: false, history: true, resumableEvents: false, messageChanges: true, webSearch: false, proactiveMessages: false, imageAttachments: false }, imageLimits: imageUploadLimits };
  const cases: [Parameters<typeof readContract>[0], unknown, boolean][] = [
    ["submitMessageRequest", { clientMessageId, text: "图文", imageIds: images }, true],
    ["submitMessageRequest", { clientMessageId, text: "", imageIds: images }, true],
    ["submitMessageRequest", { clientMessageId, text: " \n", imageIds: images }, true],
    ["submitMessageRequest", { clientMessageId, text: "" }, false],
    ["submitMessageRequest", { clientMessageId, text: "文字", imageIds: [] }, false],
    ["submitMessageRequest", { clientMessageId, text: "", imageIds: [image.id, image.id] }, false],
    ["submitMessageRequest", { clientMessageId, text: "合成", imageIds: Array.from({ length: 9 }, (_, i) => "10000000-0000-4000-8000-" + String(i).padStart(12, "0")) }, false],
    ["conversationMessage", message, true],
    ["conversationMessage", { ...message, role: "assistant" }, false],
    ["conversationMessage", { ...message, attachments: [{ ...image, path: "synthetic-private" }] }, false],
    ["conversationMessage", { ...message, attachments: Array(9).fill(image) }, false],
    ["imageAttachment", { ...image, bytes: 10485761 }, false],
    ["imageAttachment", { ...image, mimeType: "image/svg+xml" }, false],
    ["apiMeta", meta, true],
    ["apiMeta", { ...meta, imageLimits: { ...imageUploadLimits, mimeTypes: ["image/png"] } }, false],
  ];
  for (const [name, value, valid] of cases) {
    assert.equal(ajv.getSchema("urn:kuinest:0.3:" + name)!(value), valid, name + " Ajv");
    if (valid) assert.deepEqual(readContract(name, value), value);
    else assert.throws(() => readContract(name, value), /PUBLIC_CONTRACT_INVALID/);
  }
});
