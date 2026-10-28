import { readContract, type ConversationMessage, type RunEvent, type RunSnapshot, type HistoryPage, type MessageChanges } from "@kuinest/contracts";

export const isTerminal = (status: RunSnapshot["status"]): boolean => !["accepted", "running"].includes(status);
export class RunState {
  #value: RunSnapshot | undefined;
  get value(): RunSnapshot { if (!this.#value) throw new Error("RUN_SNAPSHOT_REQUIRED"); return structuredClone(this.#value); }
  reconcile(input: RunSnapshot): void {
    const snapshot = readContract("runSnapshot", input), old = this.#value;
    if (old && (snapshot.runId !== old.runId || snapshot.conversationId !== old.conversationId || snapshot.origin !== old.origin)) throw new Error("RUN_IDENTITY_INVALID");
    if (snapshot.reply && (snapshot.reply.runId !== snapshot.runId || snapshot.reply.conversationId !== snapshot.conversationId || snapshot.reply.role !== "assistant")) throw new Error("RUN_REPLY_INVALID");
    if (snapshot.origin === "user" && (!snapshot.reply || (snapshot.status === "completed" && snapshot.reply.status !== "complete"))) throw new Error("RUN_REPLY_INVALID");
    if (old && (snapshot.lastSequence < old.lastSequence || (old.reply && snapshot.reply && snapshot.reply.revision < old.reply.revision))) return;
    // 全文与游标原子替换，不能先跳序号再沿用旧历史正文。
    this.#value = structuredClone(snapshot);
  }
  apply(input: RunEvent): boolean {
    const event = readContract("runEvent", input), current = this.value;
    if (event.runId !== current.runId) throw new Error("RUN_IDENTITY_INVALID");
    if (event.sequence <= current.lastSequence) return false;
    if (event.sequence !== current.lastSequence + 1 || isTerminal(current.status)) throw new Error("STREAM_SEQUENCE_GAP");
    if (event.type === "reply.delta") {
      if (!current.reply || event.replyId !== current.reply.id) throw new Error("RUN_REPLY_INVALID");
      if (event.revision > current.reply.revision) current.reply = { ...current.reply, content: current.reply.content + event.text, revision: event.revision, status: "partial" };
    } else if (event.type === "run.started") current.status = "running";
    else if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
      const reply = event.type === "run.completed" ? event.reply : event.partialReply;
      if (reply && (reply.id !== current.reply?.id && current.reply !== undefined || reply.runId !== current.runId || reply.conversationId !== current.conversationId || reply.role !== "assistant")) throw new Error("RUN_REPLY_INVALID");
      if (event.type === "run.completed" && current.origin === "user" && reply?.status !== "complete") throw new Error("RUN_REPLY_INVALID");
      if (reply && (!current.reply || reply.revision > current.reply.revision)) current.reply = reply;
      current.status = event.type === "run.completed" ? "completed" : event.type === "run.failed" ? "failed" : "cancelled";
      if (event.type === "run.failed") current.error = { code: event.code, message: event.message };
    } else if (event.type === "run.accepted") {
      if (event.origin !== current.origin) throw new Error("RUN_IDENTITY_INVALID");
      if (event.origin === "user" && (event.submission.runId !== current.runId || event.submission.conversationId !== current.conversationId || event.submission.replyId !== current.reply?.id)) throw new Error("RUN_REPLY_INVALID");
      if (event.origin === "heartbeat" && event.conversationId !== current.conversationId) throw new Error("RUN_IDENTITY_INVALID");
    }
    current.lastSequence = event.sequence;
    this.#value = structuredClone(current); return true;
  }
}

// 历史分页不推进变化基线；运行事件只更新消息，不能替代会话级变化游标。
export class ConversationState {
  #items = new Map<string, ConversationMessage>();
  #revision: number | undefined;
  constructor(readonly conversationId: string) {}
  get revision(): number { if (this.#revision === undefined) throw new Error("HISTORY_REQUIRED"); return this.#revision; }
  get items(): ConversationMessage[] { return structuredClone([...this.#items.values()]); }
  upsert(message: ConversationMessage): void {
    const item = readContract("conversationMessage", message);
    if (item.conversationId !== this.conversationId) throw new Error("CONVERSATION_IDENTITY_INVALID");
    const old = this.#items.get(item.id);
    if (!old || item.revision > old.revision) this.#items.set(item.id, structuredClone(item));
  }
  history(input: HistoryPage): void {
    const page = readContract("historyPage", input);
    const older = page.items.filter(item => !this.#items.has(item.id));
    page.items.forEach(item => this.upsert(item));
    // 后续历史页是更旧的消息；保留服务端给出的顺序，放到已知消息之前。
    if (this.#revision !== undefined) this.#items = new Map([...older.map(item => [item.id, this.#items.get(item.id)!] as const), ...this.#items]);
    this.#revision ??= page.revision;
  }
  changes(input: MessageChanges): void {
    const page = readContract("messageChanges", input), baseline = this.revision;
    if (page.throughRevision < baseline) return;
    if (page.items.some(item => item.revision > page.throughRevision) || page.hasMore && page.throughRevision === baseline) throw new Error("CHANGES_REVISION_INVALID");
    page.items.forEach(item => this.upsert(item)); this.#revision = page.throughRevision;
  }
}
