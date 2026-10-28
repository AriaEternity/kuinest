import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { imageFraming } from "./framing.js";
import { ImageFailure, imageLimits, type ImageInspection, type ImageMime } from "./types.js";

const codes = ["IMAGE_INVALID", "IMAGE_TOO_LARGE", "IMAGE_UNSUPPORTED"] as const;
export class ImageValidator {
  #busy = false;
  constructor(readonly timeoutMs = 15000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new ImageFailure("IMAGE_UNAVAILABLE");
  }
  async inspect(input: Uint8Array, expectedMime?: ImageMime, signal?: AbortSignal): Promise<ImageInspection> {
    signal?.throwIfAborted();
    if (this.#busy) throw new ImageFailure("IMAGE_BUSY");
    if (!(input instanceof Uint8Array) || input.byteLength > imageLimits.bytes) throw new ImageFailure("IMAGE_TOO_LARGE");
    // 固定原字节，调用者后续修改输入不能改变本次验证或其哈希。
    const bytes = Buffer.from(input), mimeType = imageFraming(bytes);
    if (expectedMime !== undefined && expectedMime !== mimeType) throw new ImageFailure("IMAGE_INVALID");
    this.#busy = true;
    try {
      const result = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { PATH: dirname(process.execPath), UV_THREADPOOL_SIZE: "1", SHARP_IGNORE_GLOBAL_LIBVIPS: "1" };
        if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
        const child = spawn(process.execPath, ["--max-old-space-size=128", fileURLToPath(new URL("./decode-child.js", import.meta.url))],
          { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
        let output = "", outputBytes = 0, failure: ImageFailure | undefined;
        const stop = (error: ImageFailure) => { failure ??= error; child.kill("SIGKILL"); };
        const timer = setTimeout(() => stop(new ImageFailure("IMAGE_TIMEOUT")), this.timeoutMs);
        const abort = () => stop(new ImageFailure("IMAGE_UNAVAILABLE"));
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (part: Buffer) => {
          outputBytes += part.length;
          if (outputBytes > 512) stop(new ImageFailure("IMAGE_UNAVAILABLE"));
          else output += part.toString("utf8");
        });
        // 不透传库加载/原生解码诊断；持续排空，避免管道背压阻塞退出。
        child.stderr.resume();
        child.on("error", () => { failure ??= new ImageFailure("IMAGE_UNAVAILABLE"); });
        child.stdin.on("error", () => { failure ??= new ImageFailure("IMAGE_UNAVAILABLE"); });
        child.once("close", code => {
          clearTimeout(timer); signal?.removeEventListener("abort", abort);
          if (signal?.aborted) { reject(signal.reason); return; }
          if (failure) { reject(failure); return; }
          try {
            const v: unknown = JSON.parse(output);
            if (!v || typeof v !== "object" || Array.isArray(v)) throw new ImageFailure("IMAGE_UNAVAILABLE");
            const r = v as Record<string, unknown>;
            if (r.ok === false && Object.keys(r).length === 2 && codes.includes(r.code as typeof codes[number])) throw new ImageFailure(r.code as typeof codes[number]);
            if (code !== 0 || r.ok !== true || Object.keys(r).sort().join(",") !== "height,mimeType,ok,width" || r.mimeType !== mimeType
              || !Number.isSafeInteger(r.width) || !Number.isSafeInteger(r.height) || Number(r.width) < 1 || Number(r.height) < 1
              || Number(r.width) > imageLimits.edge || Number(r.height) > imageLimits.edge || Number(r.width) * Number(r.height) > imageLimits.pixels) throw new ImageFailure("IMAGE_UNAVAILABLE");
            resolve({ width: Number(r.width), height: Number(r.height) });
          } catch (error) { reject(error instanceof ImageFailure ? error : new ImageFailure("IMAGE_UNAVAILABLE")); }
        });
        if (signal?.aborted) abort(); else child.stdin.end(bytes);
      });
      return Object.freeze({ mimeType, ...result, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), decoder: "sharp-0.35.4" });
    } finally { this.#busy = false; }
  }
}
