// 展示层提醒：只认服务端终态，不从 EOF、文字动画或历史正文推断完成。
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
export class ChatAttention {
  constructor() { this.scope = null; this.known = new Map(); this.unread = new Map(); }
  observe({ scope, authenticated, runs, receipts = [], reading = null, enabled = true }) {
    if (scope !== this.scope || !authenticated) {
      this.scope = scope; this.known.clear(); this.unread.clear();
    }
    if (!authenticated) return [];
    // 已接受回执可能先于一个已完成的快照，快速回复也须保留提醒。
    for (const receipt of receipts) if (receipt && !this.known.has(receipt.runId)) {
      this.known.set(receipt.runId, { status: 'accepted', sequence: 0 });
    }
    for (const run of runs) {
      const previous = this.known.get(run.runId);
      if (previous && (run.lastSequence < previous.sequence || terminal(previous.status))) continue;
      this.known.set(run.runId, { status: run.status, sequence: run.lastSequence });
      const hasReply = !!run.reply?.content?.trim() || !!run.reply?.attachments?.length;
      if (enabled && previous && !terminal(previous.status) &&
          (run.status === 'failed' || run.status === 'completed' && hasReply)) {
        this.unread.set(run.runId, { conversationId: run.conversationId, status: run.status });
      }
    }
    if (!enabled) this.unread.clear();
    if (reading) for (const [id, note] of this.unread) if (note.conversationId === reading) this.unread.delete(id);
    const conversations = new Map();
    for (const note of this.unread.values()) {
      const current = conversations.get(note.conversationId);
      conversations.set(note.conversationId, { ...note, failed: note.status === 'failed' || !!current?.failed });
    }
    return [...conversations.values()];
  }
}
