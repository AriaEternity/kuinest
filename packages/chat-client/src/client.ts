import { imageUploadLimits, readContract, type RunSnapshot, type ImageAttachment, type SubmitMessageRequest } from "@kuinest/contracts";
import { readEvents } from "./stream.js";
import { RunState, ConversationState, isTerminal } from "./state.js";

export class HttpError extends Error {
  constructor(readonly status: number) { super("HTTP_" + status); }
}
async function json(response: Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || !response.body) { await response.body?.cancel(); throw new Error("JSON_RESPONSE_INVALID"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > 16 * 1024 * 1024) throw new Error("JSON_RESPONSE_TOO_LARGE");
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export class ChatClient {
  constructor(readonly base = "/api/v1", readonly request: typeof fetch = fetch) {}
  #get(path: string, signal?: AbortSignal, headers?: Record<string, string>) {
    return this.request(this.base.replace(/\/$/, "") + path, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      ...(signal ? { signal } : {}), ...(headers ? { headers } : {}),
    });
  }
  async meta(signal?: AbortSignal) {
    return readContract("apiMeta", await json(await this.#get("/meta", signal)));
  }
  #write(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body: string | Blob, type: string, csrfToken: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(csrfToken)) throw new Error("CSRF_TOKEN_INVALID");
    return this.request(this.base.replace(/\/$/, "") + path, {
      method, body, headers: { "Content-Type": type, "X-CSRF-Token": csrfToken },
      credentials: "same-origin", cache: "no-store", redirect: "error", ...(signal ? { signal } : {}),
    });
  }
  async conversation(id: string, signal?: AbortSignal) {
    const value = readContract("publicConversation", await json(await this.#get("/conversations/" + encodeURIComponent(id), signal)));
    if (value.id !== id) throw new Error("CONVERSATION_IDENTITY_INVALID");
    return value;
  }
  async renameConversation(id: string, title: string, csrfToken: string, signal?: AbortSignal) {
    const input = readContract("renameConversationRequest", { title });
    const response = await this.#write("/conversations/" + encodeURIComponent(id), "PATCH", JSON.stringify(input), "application/json", csrfToken, signal);
    const value = readContract("publicConversation", await json(response));
    if (value.id !== id) throw new Error("CONVERSATION_IDENTITY_INVALID");
    return value;
  }
  async deleteConversation(id: string, csrfToken: string, signal?: AbortSignal): Promise<void> {
    const response = await this.#write("/conversations/" + encodeURIComponent(id), "DELETE", "{}", "application/json", csrfToken, signal);
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
    if (response.status !== 204) { await response.body?.cancel(); throw new Error("CONVERSATION_DELETE_UNCONFIRMED"); }
  }
  async uploadImage(conversation: string, imageId: string, original: Blob, csrfToken: string, signal?: AbortSignal): Promise<ImageAttachment> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(imageId)
      || !["image/png", "image/jpeg"].includes(original.type) || original.size < 1 || original.size > imageUploadLimits.maxBytesPerImage) throw new Error("IMAGE_INPUT_INVALID");
    if (!(await this.meta(signal)).capabilities.imageAttachments) throw new Error("IMAGE_CAPABILITY_UNAVAILABLE");
    const response = await this.#write("/conversations/" + encodeURIComponent(conversation) + "/images/" + encodeURIComponent(imageId), "PUT", original, original.type, csrfToken, signal);
    const image = readContract("imageAttachment", await json(response));
    if (![200, 201].includes(response.status) || image.id !== imageId || image.mimeType !== original.type || image.bytes !== original.size) throw new Error("IMAGE_IDENTITY_INVALID");
    return image;
  }
  async image(conversation: string, attachment: ImageAttachment, signal?: AbortSignal): Promise<Blob> {
    const expected = readContract("imageAttachment", structuredClone(attachment));
    const response = await this.#get("/conversations/" + encodeURIComponent(conversation) + "/images/" + encodeURIComponent(expected.id), signal);
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
    if (response.status !== 200 || response.headers.get("content-type") !== expected.mimeType
      || response.headers.get("content-length") !== String(expected.bytes) || !response.body) {
      await response.body?.cancel(); throw new Error("IMAGE_RESPONSE_INVALID");
    }
    const reader = response.body.getReader(), bytes = new Uint8Array(expected.bytes); let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        if (next.value.length > bytes.length - size) throw new Error("IMAGE_RESPONSE_TOO_LARGE");
        bytes.set(next.value, size); size += next.value.length;
      }
      if (size !== expected.bytes) throw new Error("IMAGE_RESPONSE_INCOMPLETE");
      return new Blob([bytes], { type: expected.mimeType });
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async submit(conversation: string, input: SubmitMessageRequest, csrfToken: string, signal?: AbortSignal) {
    // 固定本次输入，不因等待能力查询、断线或调用者改动而更换ID/图片顺序。
    const value = readContract("submitMessageRequest", structuredClone(input)), payload = JSON.stringify(value);
    if (value.imageIds?.length && !(await this.meta(signal)).capabilities.imageAttachments) throw new Error("IMAGE_CAPABILITY_UNAVAILABLE");
    const response = await this.#write("/conversations/" + encodeURIComponent(conversation) + "/messages", "POST", payload, "application/json", csrfToken, signal);
    const accepted = readContract("acceptedSubmission", await json(response));
    if (response.status !== 202) throw new Error("SUBMISSION_RESPONSE_INVALID");
    if (accepted.conversationId !== conversation || accepted.clientMessageId !== value.clientMessageId) throw new Error("SUBMISSION_IDENTITY_INVALID");
    return accepted;
  }
  async submission(conversation: string, clientMessageId: string, signal?: AbortSignal) {
    const value = readContract("submissionLookup", await json(await this.#get("/conversations/" + encodeURIComponent(conversation) + "/submissions/" + encodeURIComponent(clientMessageId), signal)));
    if (value.submission.conversationId !== conversation || value.submission.clientMessageId !== clientMessageId) throw new Error("SUBMISSION_IDENTITY_INVALID");
    return value;
  }
  async run(id: string, signal?: AbortSignal) {
    const snapshot = readContract("runSnapshot", await json(await this.#get("/runs/" + encodeURIComponent(id), signal)));
    if (snapshot.runId !== id) throw new Error("RUN_IDENTITY_INVALID");
    return snapshot;
  }
  async history(conversation: string, options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return readContract("historyPage", await json(await this.#get("/conversations/" + encodeURIComponent(conversation) + "/messages?" + query, options.signal)));
  }
  async changes(conversation: string, revision: number, signal?: AbortSignal) {
    return readContract("messageChanges", await json(await this.#get("/conversations/" + encodeURIComponent(conversation) + "/changes?afterRevision=" + revision, signal)));
  }
  async sync(state: ConversationState, signal?: AbortSignal): Promise<void> {
    while (true) { const page = await this.changes(state.conversationId, state.revision, signal); state.changes(page); if (!page.hasMore) return; }
  }
  async *watch(id: string, options: { signal: AbortSignal; initial?: RunSnapshot; retries?: number; retryMs?: number } ): AsyncGenerator<RunSnapshot> {
    let state = new RunState();
    const signal = options.signal;
    state.reconcile(options.initial ?? await this.run(id, signal));
    if (state.value.runId !== id) throw new Error("RUN_IDENTITY_INVALID");
    yield state.value;
    let attempts = 0;
    const recoverable = (error: unknown) => !(error instanceof HttpError) || [400, 410, 429, 500, 502, 503, 504].includes(error.status);
    while (!isTerminal(state.value.status)) {
      signal.throwIfAborted();
      let invalidCursor = false;
      try {
        const response = await this.#get("/runs/" + encodeURIComponent(id) + "/events", signal, { "Last-Event-ID": String(state.value.lastSequence), Accept: "text/event-stream" });
        if (response.status !== 200) { await response.body?.cancel(); if (response.status !== 204) throw new HttpError(response.status); }
        else {
          if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/event-stream" || !response.body) { await response.body?.cancel(); throw new Error("STREAM_RESPONSE_INVALID"); }
          for await (const event of readEvents(response.body)) {
            if (state.apply(event)) { attempts = 0; yield state.value; }
            if (isTerminal(state.value.status)) return;
          }
        }
      } catch (error) {
        signal.throwIfAborted(); if (!recoverable(error)) throw error;
        invalidCursor = error instanceof HttpError && error.status === 400;
      }
      // EOF、410、过大的帧或序号缺口都回到同一快照全文对账，不能自行设 completed。
      try {
        const current = await this.run(id, signal);
        // 服务端已拒绝旧游标时，丢弃对应失效基线，允许用真实快照重新建立。
        if (invalidCursor) state = new RunState();
        state.reconcile(current); yield state.value;
      }
      catch (error) { signal.throwIfAborted(); if (!recoverable(error)) throw error; }
      if (isTerminal(state.value.status)) return;
      if (++attempts > (options.retries ?? 8)) throw new Error("STREAM_RECOVERY_EXHAUSTED");
      await pause(Math.min(10000, (options.retryMs ?? 500) * 2 ** Math.min(attempts - 1, 5)), signal);
    }
  }
}
