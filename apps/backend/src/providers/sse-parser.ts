import { RunFailure } from "../conversations/types.js";
// 上游data-only SSE解析，与公开RunEvent合同分开；每次网络块可含半个或多个帧。
export class ProviderSseParser {
  #decoder = new TextDecoder("utf-8", { fatal: true });
  #encoder = new TextEncoder();
  #line = ""; #data: string[] = []; #skipLF = false; #frameBytes = 0; #total = 0;
  constructor(readonly maxFrame = 2 * 1024 * 1024, readonly maxTotal = 16 * 1024 * 1024) {}
  *push(chunk: Uint8Array): Generator<string> {
    this.#total += chunk.byteLength;
    if (this.#total > this.maxTotal) throw new RunFailure("OUTPUT_LIMIT");
    let decoded: string; try { decoded = this.#decoder.decode(chunk, { stream: true }); } catch { throw new RunFailure("UPSTREAM_INCOMPLETE"); }
    for (const char of decoded) {
      if (this.#skipLF) { this.#skipLF = false; if (char === "\n") continue; }
      if (char === "\r" || char === "\n") {
        this.#skipLF = char === "\r";
        const line = this.#line; this.#line = "";
        if (line === "") {
          const data = this.#data; this.#data = []; this.#frameBytes = 0;
          if (data.length) yield data.join("\n");
        } else {
          if (++this.#frameBytes > this.maxFrame) throw new RunFailure("OUTPUT_LIMIT");
          if (line === "data") this.#data.push("");
          else if (line.startsWith("data:")) this.#data.push(line.slice(5).replace(/^ /, ""));
        }
      } else {
        this.#frameBytes += this.#encoder.encode(char).length;
        if (this.#frameBytes > this.maxFrame) throw new RunFailure("OUTPUT_LIMIT");
        this.#line += char;
      }
    }
  }
  end(): void { try { this.#decoder.decode(); } catch { throw new RunFailure("UPSTREAM_INCOMPLETE"); } }
}
