import { ImageFailure, imageLimits, type ImageMime } from "./types.js";
const invalid = (): never => { throw new ImageFailure("IMAGE_INVALID"); };
// 只检查完整容器和格式边界；不以此代替子进程中的完整像素解码。
export function imageFraming(bytes: Uint8Array): ImageMime {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!data.length) return invalid();
  if (data.length > imageLimits.bytes) throw new ImageFailure("IMAGE_TOO_LARGE");
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let at = 8, first = true;
    while (at + 12 <= data.length) {
      const size = data.readUInt32BE(at), type = data.toString("ascii", at + 4, at + 8), end = at + 12 + size;
      if (end > data.length || first && (type !== "IHDR" || size !== 13)) return invalid();
      if (first) {
        const width = data.readUInt32BE(at + 8), height = data.readUInt32BE(at + 12);
        if (!width || !height) return invalid();
        if (width > imageLimits.edge || height > imageLimits.edge || width * height > imageLimits.pixels) throw new ImageFailure("IMAGE_TOO_LARGE");
      }
      if (["acTL", "fcTL", "fdAT"].includes(type)) throw new ImageFailure("IMAGE_UNSUPPORTED");
      if (type === "IEND") { if (size !== 0 || end !== data.length) return invalid(); return "image/png"; }
      first = false; at = end;
    }
    return invalid();
  }
  if (data.length >= 4 && data[0] === 255 && data[1] === 216) {
    let at = 2, entropy = false;
    while (at < data.length) {
      if (entropy) { at = data.indexOf(255, at); if (at < 0) return invalid(); }
      if (data[at++] !== 255) return invalid();
      while (at < data.length && data[at] === 255) at++;
      const marker = data[at++]; if (marker === undefined) return invalid();
      if (marker === 0) { if (!entropy) return invalid(); continue; }
      if (marker >= 208 && marker <= 215) { if (!entropy) return invalid(); continue; }
      if (marker === 217) { if (at !== data.length) return invalid(); return "image/jpeg"; }
      if (marker === 216 || marker === 1 || at + 2 > data.length) return invalid();
      const size = data.readUInt16BE(at);
      if (size < 2 || at + size > data.length) return invalid();
      at += size; entropy = marker === 218;
    }
    return invalid();
  }
  throw new ImageFailure("IMAGE_UNSUPPORTED");
}
