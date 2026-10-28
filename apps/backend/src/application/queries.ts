import { publicRunFailure } from "./run-failure.js";
import type { ConversationMessage, ConversationPage, HistoryPage, MessageChanges, PublicConversation, RunSnapshot, SubmissionLookup } from "@kuinest/contracts";
import type { Clock, IdFactory } from "../ports.js";
import type { ApiStorage, ConversationRow, MessageRow, RunRow } from "./ports.js";
import { ensure } from "./errors.js";
import { Signing } from "../auth/secrets.js";

const publicConversation = (record: ConversationRow): PublicConversation => ({ id: record.id, title: record.title, updatedAt: new Date(record.updatedAt).toISOString(), revision: record.revision });
const publicMessage = (record: MessageRow): ConversationMessage => ({
  id: record.id, conversationId: record.conversationId, ...(record.runId ? { runId: record.runId } : {}),
  ...(record.role === "user" && record.attachments?.length ? { attachments: record.attachments.map(image => ({ id: image.id, mimeType: image.mimeType, bytes: image.bytes, width: image.width, height: image.height })) } : {}),
  role: record.role, content: record.content, status: record.status, createdAt: new Date(record.createdAt).toISOString(), revision: record.revision,
});
function snapshot(value: { run: RunRow; reply?: MessageRow }): RunSnapshot {
  const { run, reply } = value;
  return { runId: run.id, origin: run.origin, conversationId: run.conversationId, status: run.status, lastSequence: run.lastSequence,
    ...(reply ? { reply: publicMessage(reply) } : {}),
    ...(run.status === "failed" ? { error: publicRunFailure(run.errorCode) } : {}),
  };
}
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export class Queries {
  constructor(readonly store: ApiStorage, readonly clock: Clock, readonly ids: IdFactory, readonly signing: Signing) {}
  conversations(owner: string, cursor: string | undefined, limit: number): ConversationPage {
    let before: [number, string] | undefined;
    if (cursor) {
      const value = this.signing.readCursor(["conversations", owner], cursor);
      ensure(value.length === 2 && integer(value[0]) && typeof value[1] === "string" && value[1].length > 0 && value[1].length <= 256, "CURSOR_INVALID");
      before = [value[0], value[1]];
    }
    const all = this.store.conversations(owner, before, limit + 1), page = all.slice(0, limit), last = page.at(-1);
    return { items: page.map(publicConversation), nextCursor: all.length > limit && last ? this.signing.cursor(["conversations", owner], [last.createdAt, last.id]) : null };
  }
  createConversation(owner: string, title: string | undefined): PublicConversation {
    return publicConversation(this.store.createConversation(owner, this.ids.next(), title ?? "新会话", this.clock.now()));
  }
  conversation(owner: string, id: string): PublicConversation {
    const record = this.store.conversation(owner, id); ensure(record, "NOT_FOUND"); return publicConversation(record);
  }
  renameConversation(owner: string, id: string, input: string): PublicConversation {
    const title = input.trim();
    ensure(title.length > 0 && [...title].length <= 100 && !/[\u0000-\u001f\u007f]/u.test(title), "INPUT_INVALID");
    return publicConversation(this.store.renameConversation(owner, id, title, this.clock.now()));
  }
  deleteConversation(owner: string, id: string): void { this.store.deleteConversation(owner, id, this.clock.now()); }
  requireConversation(owner: string, id: string): void { ensure(this.store.conversation(owner, id), "NOT_FOUND"); }
  history(owner: string, id: string, cursor: string | undefined, limit: number): HistoryPage {
    this.requireConversation(owner, id);
    let before: number | undefined;
    if (cursor) {
      const value = this.signing.readCursor(["history", owner, id], cursor);
      ensure(value.length === 1 && integer(value[0]) && value[0] > 0, "CURSOR_INVALID"); before = value[0];
    }
    const { rows, revision } = this.store.history(owner, id, before, limit + 1), page = rows.slice(0, limit), last = page.at(-1);
    return { items: [...page].reverse().map(publicMessage), revision, nextCursor: rows.length > limit && last ? this.signing.cursor(["history", owner, id], [last.seq]) : null };
  }
  changes(owner: string, id: string, after: number): MessageChanges {
    const { rows, revision } = this.store.changes(owner, id, after, 101), page = rows.slice(0, 100);
    return { items: page.map(publicMessage), hasMore: rows.length > 100, throughRevision: rows.length > 100 ? page.at(-1)!.revision : revision };
  }
  run(owner: string, id: string): RunSnapshot {
    const value = this.store.run(owner, id); ensure(value, "NOT_FOUND"); return snapshot(value);
  }
  submission(owner: string, id: string, client: string): SubmissionLookup {
    this.requireConversation(owner, id);
    const value = this.store.submission(owner, id, client); ensure(value && value.run.userMessageId, "NOT_FOUND");
    return { submission: { conversationId: id, clientMessageId: client, messageId: value.run.userMessageId, replyId: value.run.replyMessageId, runId: value.run.id, acceptedAt: new Date(value.run.createdAt).toISOString() }, run: snapshot(value) };
  }
}
