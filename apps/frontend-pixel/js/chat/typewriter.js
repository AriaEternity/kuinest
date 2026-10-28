// 只保存展示进度；原始消息与运行状态仍由共享客户端维护。
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const pauses = { '，': 55, ',': 55, '。': 100, '.': 100, '！': 100, '!': 100, '？': 100, '?': 100, '\n': 70 };

export class Typewriter {
  constructor(text = '') {
    this.target = text; this.visible = text; this.queue = []; this.index = 0;
    this.nextAt = 0; this.deadline = 0;
  }
  get pending() { return this.visible !== this.target; }
  setText(text, { animate = false, now = 0 } = {}) {
    if (!animate || !text.startsWith(this.target)) { this.target = text; this.flush(); return; }
    if (text === this.target) return;
    const pending = this.pending;
    this.target = text;
    // 对全文分字素，避免把 emoji、组合字符或家庭表情切成碎片。
    this.queue = [...segmenter.segment(text)].map(part => ({ text: part.segment, end: part.index + part.segment.length }));
    this.index = this.queue.findIndex(part => part.end > this.visible.length);
    if (this.index < 0) this.index = this.queue.length;
    if (!pending) this.nextAt = now + 28;
    // 每次接收后的展示积压最多保留 900ms，不让长回复排队许久。
    this.deadline = now + 900;
  }
  advance(now) {
    if (!this.pending) return false;
    if (now >= this.deadline) { this.flush(); return true; }
    const remaining = this.queue.length - this.index;
    const interval = Math.min(28, Math.max(1, (this.deadline - now) / Math.max(1, remaining)));
    const before = this.visible;
    while (this.index < this.queue.length && now >= this.nextAt) {
      const part = this.queue[this.index++];
      this.visible = this.target.slice(0, part.end);
      this.nextAt += interval + (remaining <= 32 ? pauses[part.text] || 0 : 0);
    }
    return this.visible !== before;
  }
  flush() {
    this.visible = this.target; this.queue = []; this.index = 0;
    this.nextAt = 0; this.deadline = 0;
  }
}
