import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { ImageValidator } from "../dist/images/validate.js";
import { imageFraming } from "../dist/images/framing.js";
import { imageLimits } from "../dist/images/types.js";

const code = (expected: string) => (e: unknown) => (e as { code?: string }).code === expected;
async function picture(format: "png" | "jpeg", progressive = false) {
  const image = sharp({ create: { width: 31, height: 19, channels: 3, background: { r: 12, g: 67, b: 199 } } }).withMetadata();
  return format === "png" ? image.png().toBuffer() : image.jpeg({ progressive }).toBuffer();
}
test("IMG01：PNG/JPEG及渐进JPEG全像素解码，原件与元数据字节不重编码", async () => {
  const validator = new ImageValidator();
  for (const format of ["png", "jpeg"] as const) for (const progressive of [false, true]) {
    const bytes = await picture(format, progressive), before = Buffer.from(bytes);
    const result = await validator.inspect(bytes, format === "png" ? "image/png" : "image/jpeg");
    assert.equal(result.width, 31); assert.equal(result.height, 19); assert.equal(result.bytes, bytes.length);
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex")); assert.equal(result.decoder, "sharp-0.35.4");
    assert.ok(Object.isFrozen(result)); assert.ok(bytes.equals(before));
    assert.equal(Object.hasOwn(result, "content"), false); assert.equal(Object.hasOwn(result, "exif"), false);
  }
});
test("IMG02：伪MIME、空/截断/尾随/拼接图片与SVG/GIF拒绝，不回显字节", async () => {
  const validator = new ImageValidator(), png = await picture("png"), jpeg = await picture("jpeg");
  for (const bytes of [Buffer.alloc(0), png.subarray(0, -3), jpeg.subarray(0, -2), Buffer.concat([png, Buffer.from("SYNTHETIC_PRIVATE_SENTINEL")]),
    Buffer.concat([jpeg, jpeg]), Buffer.from("<svg>SYNTHETIC_PRIVATE_SENTINEL</svg>"), Buffer.from("GIF89aSYNTHETIC_PRIVATE_SENTINEL")]) {
    await assert.rejects(validator.inspect(bytes), error => {
      assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE_SENTINEL|svg|GIF89/); return true;
    });
  }
  await assert.rejects(validator.inspect(png, "image/jpeg"), code("IMAGE_INVALID"));
  await assert.rejects(validator.inspect(jpeg, "image/png"), code("IMAGE_INVALID"));
});
test("IMG02：魔数/容器可通过但像素损坏仍由完整解码拦截", async () => {
  const png = await picture("png"), damaged = Buffer.from(png);
  let at = 8, changed = false;
  while (at + 12 <= damaged.length) {
    const size = damaged.readUInt32BE(at), type = damaged.toString("ascii", at + 4, at + 8);
    if (type === "IDAT" && size > 2) { damaged[at + 8] = 0; damaged[at + 9] = 0; changed = true; break; }
    at += size + 12;
  }
  assert.ok(changed); assert.equal(imageFraming(damaged), "image/png");
  await assert.rejects(new ImageValidator().inspect(damaged), code("IMAGE_INVALID"));
});
test("IMG03：字节/像素超额和动画PNG明确拒绝，不默认缩小或取首帧", async () => {
  const validator = new ImageValidator();
  await assert.rejects(validator.inspect(Buffer.alloc(imageLimits.bytes + 1)), code("IMAGE_TOO_LARGE"));
  const png = await picture("png"), huge = Buffer.from(png); huge.writeUInt32BE(20000, 16);
  await assert.rejects(validator.inspect(huge), code("IMAGE_TOO_LARGE"));
  const chunk = Buffer.alloc(20); chunk.writeUInt32BE(8, 0); chunk.write("acTL", 4, "ascii");
  const animated = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
  await assert.rejects(validator.inspect(animated), code("IMAGE_UNSUPPORTED"));
});
test("IMG04：单并发、取消与超时等待子进程退出，之后可再次验证", async () => {
  const bytes = await picture("png"), validator = new ImageValidator(), controller = new AbortController();
  const first = validator.inspect(bytes, "image/png", controller.signal);
  await assert.rejects(validator.inspect(bytes), code("IMAGE_BUSY"));
  const reason = new Error("synthetic-cancel"); controller.abort(reason);
  await assert.rejects(first, error => error === reason);
  assert.equal((await validator.inspect(bytes)).width, 31);
  await assert.rejects(new ImageValidator(1).inspect(bytes), code("IMAGE_TIMEOUT"));
  const already = AbortSignal.abort(reason); await assert.rejects(validator.inspect(bytes, undefined, already), error => error === reason);
});
test("IMG04：输入在异步解码期间变化，不改变已固定原件的哈希", async () => {
  const bytes = await picture("png"), expected = createHash("sha256").update(bytes).digest("hex");
  const promise = new ImageValidator().inspect(bytes); bytes.fill(0);
  assert.equal((await promise).sha256, expected);
});
