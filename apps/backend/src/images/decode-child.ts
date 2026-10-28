import sharp from "sharp";
import { imageFraming } from "./framing.js";
import { ImageFailure, imageLimits } from "./types.js";

// 仅由可信父进程启动；输入是原始字节，stdout只允许固定结构，不写图片或异常正文。
async function main() {
  sharp.cache(false); sharp.concurrency(1);
  sharp.block({ operation: ["VipsForeignLoad"] });
  sharp.unblock({ operation: ["VipsForeignLoadJpegBuffer", "VipsForeignLoadPngBuffer"] });
  const parts: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > imageLimits.bytes) throw new ImageFailure("IMAGE_TOO_LARGE");
    parts.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(parts), mimeType = imageFraming(bytes);
  const input = sharp(bytes, { failOn: "warning", limitInputPixels: imageLimits.pixels, limitInputChannels: 4, sequentialRead: true, animated: false });
  const metadata = await input.metadata();
  if (metadata.format !== (mimeType === "image/png" ? "png" : "jpeg") || (metadata.pages ?? 1) !== 1
    || !metadata.width || !metadata.height || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)) throw new ImageFailure("IMAGE_INVALID");
  if (metadata.width > imageLimits.edge || metadata.height > imageLimits.edge || metadata.width * metadata.height > imageLimits.pixels) throw new ImageFailure("IMAGE_TOO_LARGE");
  // stats遍历全部像素，避免metadata成功就把截断/损坏图片当作可解码；不产生重编码原件。
  await input.stats();
  process.stdout.write(JSON.stringify({ ok: true, mimeType, width: metadata.width, height: metadata.height }) + "\n");
}
try { await main(); }
catch (error) {
  const code = error instanceof ImageFailure ? error.code : "IMAGE_INVALID";
  process.stdout.write(JSON.stringify({ ok: false, code }) + "\n"); process.exitCode = 1;
}
