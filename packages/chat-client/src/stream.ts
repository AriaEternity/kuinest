import { readContract, type RunEvent } from "@kuinest/contracts";

// SSE 使用增量 UTF-8 解码；CR、LF、CRLF 均可跨网络块。
// 未以空行结束的帧在 EOF 丢弃，EOF 本身不改变运行状态。
export class SseParser {
  #encoder = new TextEncoder();
  #decoder = new TextDecoder("utf-8", { fatal: true });
  #line = "";
  #skipLF = false;
  #data: string[] = [];
  #id = "";
  #event = "";
  #bytes = 0;
  constructor(readonly maxBytes = 256 * 1024) {}
  *push(bytes: Uint8Array): Generator<RunEvent> {
    const text = this.#decoder.decode(bytes, { stream: true });
    for (const character of text) {
      if (this.#skipLF) { this.#skipLF = false; if (character === "\n") continue; }
      if (character === "\r" || character === "\n") {
        this.#skipLF = character === "\r";
        const event = this.#finishLine();
        if (event) yield event;
      } else {
        this.#line += character;
        this.#bytes += this.#encoder.encode(character).length;
        if (this.#bytes > this.maxBytes) throw new Error("STREAM_FRAME_TOO_LARGE");
      }
    }
  }
  end(): void { this.#decoder.decode(); this.#reset(); this.#line = ""; }
  #reset() { this.#data = []; this.#id = ""; this.#event = ""; this.#bytes = 0; }
  #finishLine(): RunEvent | undefined {
    const line = this.#line; this.#line = "";
    if (line === "") {
      if (!this.#data.length) { this.#reset(); return; }
      const event = readContract("runEvent", JSON.parse(this.#data.join("\n")));
      if (String(event.sequence) !== this.#id || event.type !== this.#event) throw new Error("STREAM_ENVELOPE_INVALID");
      this.#reset(); return event;
    }
    // 换行也计入帧预算，避免空 data: 字段耗尽内存。
    if (++this.#bytes > this.maxBytes) throw new Error("STREAM_FRAME_TOO_LARGE");
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "data") this.#data.push(value);
    else if (name === "event") this.#event = value;
    else if (name === "id" && !value.includes("\0")) this.#id = value;
    return;
  }
}
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<RunEvent> {
  const reader = body.getReader(), parser = new SseParser();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { parser.end(); return; }
      yield* parser.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
