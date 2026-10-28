import { ConversationState, HttpError } from '@kuinest/chat-client';
import { Api, explain } from './api.js';
import { createDemo } from './demo.js';
import { orderedMessages, isRunTerminal, reconcileRun } from './order.js';
const SELECTED = 'kuinest-pixel-selected-';
const PENDING = 'kuinest-pixel-pending-';
const safeGet = (storage, key, fallback) => { try { return JSON.parse(storage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
const safeSet = (storage, key, value) => { try { storage.setItem(key, JSON.stringify(value)); } catch {} };

export class ChatStore {
  constructor() {
    this.mode = new URLSearchParams(location.search).get('mode') === 'demo' ? 'demo' : 'http';
    this.api = new Api(); this.session = null; this.meta = null;
    this.listeners = new Set(); this.conversations = []; this.states = new Map(); this.runs = new Map();
    this.current = null; this.nextCursor = null; this.busy = false; this.loading = false; this.notice = ''; this.error = '';
    this.conversationBusy = false;
    this.pending = {}; this.drafts = new Map(); this.images = new Map(); this.activeViews = 0;
    this.generation = 0; this.selection = 0; this.syncJobs = new Map(); this.cancelRequests = new Set();
    this.proposals = []; this.proposalCursor = null; this.memoryOpen = false; this.memoryLoading = false; this.memoryError = ''; this.memoryNotice = ''; this.memoryBusy = false; this.pendingProposal = null;
    this.onVisibility = () => { if (this.activeViews) { clearTimeout(this.timer); this.poll(); } };
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onVisibility);
    window.addEventListener('offline', () => { if (this.mode === 'http') { this.error = '网络已断开。未确认的操作将保留，请联网后对账。'; this.emit(); } });
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }
  async init() { return this.switchMode(this.mode); }
  clearRuntime() {
    this.generation++; this.selection++; this.watchController?.abort(); this.loadController?.abort(); clearTimeout(this.timer);
    for (const { url } of this.images.values()) if (url) URL.revokeObjectURL(url);
    this.images.clear(); this.states.clear(); this.runs.clear(); this.drafts.clear(); this.syncJobs.clear(); this.cancelRequests.clear();
    this.session = null; this.meta = null; this.current = null; this.conversations = []; this.nextCursor = null; this.pending = {};
    this.proposals = []; this.memoryOpen = false; this.memoryError = ''; this.memoryNotice = ''; this.pendingProposal = null; this.watchId = null;
    this.memoryLoading = false; this.memoryBusy = false; this.reconciling = false;
    this.conversationBusy = false;
  }
  async switchMode(mode) {
    this.clearRuntime(); this.mode = mode; this.error = ''; this.notice = ''; this.loading = true; this.busy = false; this.emit();
    const epoch = this.generation;
    const url = new URL(location.href); url.searchParams.set('mode', mode); history.replaceState(null, '', url);
    try {
      if (mode === 'demo') { this.demo = await createDemo(); this.api = new Api(this.demo.request); }
      else { this.demo = null; this.api = new Api(); }
      const session = await this.api.session(); if (epoch !== this.generation) return;
      await this.acceptSession(session, epoch);
    } catch (error) { if (epoch === this.generation && error.status !== 401) this.error = explain(error); }
    finally { if (epoch === this.generation) { this.loading = false; this.emit(); } }
  }
  async acceptSession(session, epoch = this.generation) {
    this.session = session;
    this.pending = safeGet(sessionStorage, PENDING + this.mode + ':' + session.ownerId, {});
    this.pendingProposal = safeGet(sessionStorage, PENDING + 'memory:' + this.mode + ':' + session.ownerId, null);
    const meta = await this.api.chat.meta(); if (epoch !== this.generation) return;
    this.meta = meta; await this.loadConversations(false, epoch);
    if (epoch !== this.generation) return;
    const selected = safeGet(localStorage, SELECTED + this.mode + ':' + session.ownerId, null);
    if (selected && !this.conversations.some(c => c.id === selected)) {
      // 已选会话可能位于后续列表页；先直接读公开历史，不能因首屏未列出就丢失。
      try { await this.select(selected); } catch {}
    } else if (selected || this.conversations.length) await this.select(selected || this.conversations[0].id);
    this.schedule();
  }
  async login(username, password) {
    if (this.busy) return;
    this.busy = true; this.error = ''; this.emit(); const epoch = this.generation;
    try { const session = await this.api.login(username, password); if (epoch === this.generation) await this.acceptSession(session, epoch); }
    catch (error) { if (epoch === this.generation) this.error = explain(error); }
    finally { if (epoch === this.generation) { this.busy = false; this.emit(); } }
  }
  async logout() {
    if (this.busy) return;
    this.busy = true; this.error = ''; this.emit(); const epoch = this.generation;
    try {
      await this.api.logout(this.session.csrfToken);
      if (epoch !== this.generation) return;
      const mode = this.mode; this.clearRuntime(); this.mode = mode; this.notice = '已退出登录。';
    } catch (error) { this.fail(error); }
    finally { this.busy = false; this.emit(); }
  }
  fail(error, context = '') {
    if (error?.status === 401 || error?.code === 'CSRF_INVALID') {
      this.watchController?.abort(); this.loadController?.abort(); clearTimeout(this.timer); this.session = null; this.meta = null;
      this.generation++; this.selection++; this.states.clear(); this.runs.clear(); this.proposals = []; this.current = null; this.conversations = []; this.drafts.clear();
      for (const image of this.images.values()) if (image.url) URL.revokeObjectURL(image.url); this.images.clear(); this.watchId = null;
      this.error = '登录已过期，请重新登录。未确认的提交会在同账号登录后对账。';
      this.busy = false; this.loading = false; this.memoryBusy = false; this.memoryLoading = false; this.conversationBusy = false;
    } else this.error = (context ? context + '：' : '') + explain(error);
    this.emit();
  }
  async loadConversations(more = false, epoch = this.generation) {
    const page = await this.api.conversations(more ? this.nextCursor : undefined);
    if (epoch !== this.generation) return;
    this.conversations = more ? [...new Map([...this.conversations, ...page.items].map(c => [c.id, c])).values()] : page.items;
    this.nextCursor = page.nextCursor; this.emit();
  }
  async create(title = '') {
    if (!this.session || this.busy || this.conversationBusy) return;
    this.busy = true; this.error = ''; this.emit(); const epoch = this.generation;
    try { const item = await this.api.create([...title.trim()].slice(0, 100).join(''), this.session.csrfToken); if (epoch !== this.generation) return; this.conversations.push(item); await this.select(item.id); }
    catch (error) { if (epoch === this.generation) this.fail(error, '新建会话'); }
    finally { if (epoch === this.generation) { this.busy = false; this.emit(); } }
  }
  updateConversation(item) {
    const index = this.conversations.findIndex(existing => existing.id === item.id);
    if (index < 0) this.conversations.push(item); else this.conversations[index] = item;
    this.emit();
  }
  deletionBlocked(id) {
    return [...this.runs.values()].some(run => run.conversationId === id && !isRunTerminal(run))
      || !!this.pending[id] && this.pending[id].phase !== 'rejected'
      || this.memoryBusy || this.pendingProposal?.conversationId === id;
  }
  async renameConversation(id, input) {
    if (!this.session || this.conversationBusy) return false;
    const title = input.trim();
    if (!title || [...title].length > 100 || /[\u0000-\u001f\u007f]/u.test(title)) { this.error = '会话名请输入 1—100 个字符，不能包含换行。'; this.emit(); return false; }
    const epoch = this.generation;
    this.conversationBusy = true; this.error = ''; this.notice = ''; this.emit();
    try {
      const item = await this.api.chat.renameConversation(id, title, this.session.csrfToken);
      if (epoch !== this.generation) return false;
      this.updateConversation(item); this.notice = '会话名已保存。'; return true;
    } catch (error) {
      if (epoch !== this.generation) return false;
      if (!error.status || error.status >= 500) {
        try {
          const item = await this.api.chat.conversation(id);
          if (epoch !== this.generation) return false;
          this.updateConversation(item);
          if (item.title === title) { this.notice = '已重新读取，确认会话名已保存。'; return true; }
        } catch (lookup) { if (lookup.status === 401) { this.fail(lookup); return false; } }
      }
      this.fail(error, '修改会话名未能确认'); return false;
    } finally { if (epoch === this.generation) { this.conversationBusy = false; this.emit(); } }
  }
  forgetConversation(id) {
    if (id === this.current) {
      this.selection++; this.watchController?.abort(); this.loadController?.abort(); this.watchId = null;
      this.current = null; this.loading = false; this.proposals = []; this.proposalCursor = null;
      this.memoryError = ''; this.memoryNotice = '';
      if (this.session) safeSet(localStorage, SELECTED + this.mode + ':' + this.session.ownerId, null);
    }
    this.conversations = this.conversations.filter(item => item.id !== id);
    this.states.delete(id); this.syncJobs.delete(id); this.drafts.delete(id);
    for (const [runId, run] of this.runs) if (run.conversationId === id) { this.runs.delete(runId); this.cancelRequests.delete(runId); }
    for (const [key, image] of this.images) if (key.startsWith(id + ':')) { if (image.url) URL.revokeObjectURL(image.url); this.images.delete(key); }
    delete this.pending[id]; this.persistPending(); this.emit();
  }
  async afterConversationDeleted(id, epoch, notice = '会话已删除，已确认的长期记忆保留。') {
    if (epoch !== this.generation) return;
    this.forgetConversation(id);
    try { await this.loadConversations(false, epoch); }
    catch (error) { if (epoch === this.generation) this.fail(error, '会话已删除，列表暂未刷新'); }
    if (epoch !== this.generation || !this.session) return;
    if (!this.current && this.conversations.length) await this.select(this.conversations[0].id);
    this.notice = notice; this.emit();
  }
  async deleteConversation(id) {
    if (!this.session || this.conversationBusy) return false;
    if (this.deletionBlocked(id)) { this.error = '请先停止回复、完成提交对账或处理待确认的记忆操作，再删除会话。'; this.emit(); return false; }
    const epoch = this.generation;
    this.conversationBusy = true; this.error = ''; this.notice = ''; this.emit();
    try {
      await this.api.chat.deleteConversation(id, this.session.csrfToken);
      if (epoch !== this.generation) return false;
      await this.afterConversationDeleted(id, epoch); return true;
    } catch (error) {
      if (epoch !== this.generation) return false;
      // 写响应丢失时只读回查；没有服务端删除证据，不提前移除本地内容。
      if (!error.status || error.status >= 500 || error.status === 404) {
        try { await this.api.chat.conversation(id); }
        catch (lookup) {
          if (epoch !== this.generation) return false;
          if (lookup.status === 404) { await this.afterConversationDeleted(id, epoch); return true; }
          if (lookup.status === 401) { this.fail(lookup); return false; }
        }
      }
      this.fail(error, '删除会话未能确认'); return false;
    } finally { if (epoch === this.generation) { this.conversationBusy = false; this.emit(); } }
  }
  state(id = this.current) { return this.states.get(id); }
  get messages() { return orderedMessages(this.state()?.items || []); }
  get activeRun() { return [...this.runs.values()].find(r => r.conversationId === this.current && !isRunTerminal(r)); }
  get currentPending() { return this.pending[this.current]; }
  persistPending() { if (this.session) safeSet(sessionStorage, PENDING + this.mode + ':' + this.session.ownerId, this.pending); }
  persistProposal() { if (this.session) safeSet(sessionStorage, PENDING + 'memory:' + this.mode + ':' + this.session.ownerId, this.pendingProposal); }
  async select(id) {
    if (!this.session) return;
    this.selection++; const selection = this.selection, epoch = this.generation;
    this.watchController?.abort(); this.watchId = null; this.loadController?.abort(); this.loadController = new AbortController();
    this.current = id; this.loading = true; this.error = ''; this.notice = ''; this.memoryError = ''; this.proposals = []; this.proposalCursor = null; this.emit();
    for (const [key, image] of this.images) if (!key.startsWith(id + ':')) { if (image.url) URL.revokeObjectURL(image.url); this.images.delete(key); }
    try {
      if (!this.conversations.some(item => item.id === id)) {
        const item = await this.api.chat.conversation(id);
        if (selection !== this.selection || epoch !== this.generation) return;
        this.updateConversation(item);
      }
      const page = await this.api.chat.history(id, { signal: this.loadController.signal });
      if (selection !== this.selection || epoch !== this.generation) return;
      const state = new ConversationState(id); state.history(page); state.cursor = page.nextCursor; this.states.set(id, state);
      safeSet(localStorage, SELECTED + this.mode + ':' + this.session.ownerId, id);
      await this.sync(id); if (selection !== this.selection || epoch !== this.generation) return;
      if (this.pending[id]) await this.reconcileSubmission(id);
      if (selection !== this.selection || epoch !== this.generation) return;
      await this.restoreRuns(id, selection);
      if (this.memoryOpen) await this.loadProposals();
    } catch (error) {
      if (selection === this.selection && epoch === this.generation && !this.loadController.signal.aborted) {
        if (error.status === 404) {
          try { await this.api.chat.conversation(id); this.fail(error, '加载会话'); }
          catch (lookup) { if (lookup.status === 404) await this.afterConversationDeleted(id, epoch, '这段会话已删除，已刷新列表。'); else this.fail(lookup); }
        } else this.fail(error, '加载会话');
      }
    }
    finally { if (selection === this.selection && epoch === this.generation) { this.loading = false; this.emit(); this.schedule(); } }
  }
  async older() {
    const id = this.current, state = this.state(), epoch = this.generation;
    if (!state?.cursor || this.loading) return;
    this.loading = true; this.emit();
    try { const page = await this.api.chat.history(id, { cursor: state.cursor }); if (epoch !== this.generation || id !== this.current) return; state.history(page); state.cursor = page.nextCursor; }
    catch (error) { this.fail(error, '读取更早消息'); }
    finally { if (epoch === this.generation) { this.loading = false; this.emit(); } }
  }
  sync(id = this.current) {
    const state = this.states.get(id); if (!state) return Promise.resolve();
    if (this.syncJobs.has(id)) return this.syncJobs.get(id);
    const api = this.api, epoch = this.generation;
    const job = api.chat.sync(state).then(() => { if (epoch === this.generation) this.emit(); }).finally(() => { if (this.syncJobs.get(id) === job) this.syncJobs.delete(id); });
    this.syncJobs.set(id, job); return job;
  }
  updateRun(snapshot) {
    const next = reconcileRun(this.runs.get(snapshot.runId), snapshot); this.runs.set(next.runId, next);
    if (next.reply) this.states.get(next.conversationId)?.upsert(next.reply);
    if (isRunTerminal(next)) this.cancelRequests.delete(next.runId);
    this.emit();
  }
  async restoreRuns(id, selection = this.selection) {
    const epoch = this.generation;
    const runIds = [...new Set(this.state(id)?.items.filter(m => m.role === 'assistant' && m.status === 'partial' && m.runId).map(m => m.runId) || [])];
    for (const runId of runIds) {
      const snapshot = await this.api.chat.run(runId);
      if (epoch !== this.generation || selection !== this.selection || id !== this.current) return;
      this.updateRun(snapshot);
    }
    if (this.activeViews && this.activeRun) this.watch(this.activeRun);
  }
  async watch(initial) {
    if (this.watchId === initial.runId || !this.session || !this.activeViews) return;
    this.watchController?.abort(); const controller = new AbortController(); this.watchController = controller;
    this.watchId = initial.runId; const epoch = this.generation, selection = this.selection;
    try {
      for await (const snapshot of this.api.chat.watch(initial.runId, { signal: controller.signal, initial })) {
        if (epoch !== this.generation || selection !== this.selection) return;
        this.updateRun(snapshot);
      }
      if (epoch === this.generation && !controller.signal.aborted) { await this.sync(initial.conversationId); this.notice = ''; this.emit(); }
    } catch (error) {
      if (!controller.signal.aborted && epoch === this.generation && selection === this.selection) this.fail(error, '状态待确认');
    } finally { if (this.watchController === controller) this.watchId = null; }
  }
  async send(text, allowWebSearch = false, imageIds = []) {
    const id = this.current; if (!id || !this.session || !this.meta?.capabilities.chat || this.pending[id] || this.activeRun || this.conversationBusy) return;
    if ((!text.trim() && !imageIds.length) || [...text].length > 32000 || new TextEncoder().encode(text).length > 128 * 1024) { this.error = '请输入正文；每条最多 32000 字符、128 KiB。'; this.emit(); return; }
    const input = { clientMessageId: crypto.randomUUID(), text, ...(allowWebSearch ? { allowWebSearch: true } : {}), ...(imageIds.length ? { imageIds: [...imageIds] } : {}) };
    this.pending[id] = { input, phase: 'submitting', createdAt: new Date().toISOString() }; this.persistPending(); this.drafts.set(id, ''); this.error = ''; this.emit();
    await this.submitPending(id);
  }
  async submitPending(id) {
    const pending = this.pending[id], epoch = this.generation; if (!pending || !this.session) return;
    pending.phase = 'submitting'; this.persistPending(); this.emit();
    try {
      const accepted = await this.api.chat.submit(id, pending.input, this.session.csrfToken);
      if (epoch !== this.generation) return;
      await this.accepted(id, accepted);
    } catch (error) {
      if (epoch !== this.generation) return;
      pending.phase = 'unknown'; this.persistPending();
      // 确定性拒绝与响应丢失分开；401也保留原标识，重新登录再对账。
      if (error instanceof HttpError && ![408, 500, 502, 503, 504].includes(error.status)) pending.phase = 'rejected';
      this.fail(error, pending.phase === 'unknown' ? '提交结果待确认' : '提交未被接受');
      if (pending.phase === 'unknown' && this.session) await this.reconcileSubmission(id);
    }
  }
  async accepted(id, receipt, snapshot) {
    const pending = this.pending[id]; if (pending) { pending.phase = 'accepted'; pending.receipt = receipt; this.persistPending(); }
    const epoch = this.generation;
    // 先取事务内的用户消息和回复占位，再合并流快照，保持原始消息顺序。
    await this.sync(id);
    if (epoch !== this.generation) return;
    const run = snapshot || await this.api.chat.run(receipt.runId); if (epoch !== this.generation) return;
    this.updateRun(run);
    delete this.pending[id]; this.persistPending(); this.error = ''; this.emit();
    if (id === this.current && this.activeViews && !isRunTerminal(run)) this.watch(run);
  }
  async reconcileSubmission(id = this.current) {
    const pending = this.pending[id]; if (!pending || !this.session) return;
    const epoch = this.generation;
    try {
      const result = await this.api.chat.submission(id, pending.input.clientMessageId); if (epoch !== this.generation) return;
      await this.accepted(id, result.submission, result.run);
    } catch (error) {
      if (epoch !== this.generation) return;
      if (error.status === 404) { pending.phase = 'unknown'; this.notice = '尚未查到原提交。可以使用原标识和原内容重试；请勿另发同一条。'; this.persistPending(); this.emit(); }
      else this.fail(error, '提交对账');
    }
  }
  async cancel() {
    const run = this.activeRun, epoch = this.generation; if (!run || this.cancelRequests.has(run.runId)) return;
    this.cancelRequests.add(run.runId); this.error = ''; this.emit();
    try {
      const result = await this.api.cancel(run.runId, this.session.csrfToken); if (epoch !== this.generation) return;
      this.updateRun(result);
      if (!isRunTerminal(result)) this.notice = '取消请求已接收，正在等待运行终态。';
    } catch (error) { if (epoch === this.generation) { this.cancelRequests.delete(run.runId); this.fail(error, '取消结果待确认'); } }
    this.emit();
  }
  async reconcile() {
    const id = this.current; if (!id || !this.session || this.reconciling) return;
    this.reconciling = true; this.emit(); const epoch = this.generation;
    try { if (this.pending[id]) await this.reconcileSubmission(id); if (epoch !== this.generation) return; await this.sync(id); await this.restoreRuns(id); const meta = await this.api.chat.meta(); if (epoch !== this.generation) return; this.meta = meta; this.error = ''; }
    catch (error) { this.fail(error, '重新对账'); }
    finally { this.reconciling = false; this.emit(); }
  }
  discardRejected() {
    const pending = this.currentPending; if (pending?.phase !== 'rejected') return;
    if (pending.input.imageIds?.length) {
      this.notice = '已返回正文。此条原输入包含图片；若关闭过窗口，请重新选择原图片，不能把它当作纯文字重发。';
    }
    this.drafts.set(this.current, pending.input.text); delete this.pending[this.current]; this.persistPending(); this.emit();
  }
  attachView() { this.activeViews++; if (this.activeRun) this.watch(this.activeRun); this.schedule(); }
  detachView() { this.activeViews = Math.max(0, this.activeViews - 1); if (!this.activeViews) { this.watchController?.abort(); this.watchId = null; clearTimeout(this.timer); for (const image of this.images.values()) if (image.url) URL.revokeObjectURL(image.url); this.images.clear(); } }
  schedule() { clearTimeout(this.timer); if (this.session && this.activeViews) this.timer = setTimeout(() => this.poll(), document.hidden ? 30000 : 5000); }
  async poll() {
    if (this.polling || !this.session || !this.activeViews) return;
    this.polling = true; const epoch = this.generation, selected = this.current;
    try {
      if (this.current) { await this.sync(); await this.restoreRuns(this.current); }
      if (epoch === this.generation && Date.now() - (this.lastListRefresh || 0) > 30000) {
        await this.loadConversations();
        if (this.current) { const item = await this.api.chat.conversation(this.current); if (epoch === this.generation) this.updateConversation(item); }
        this.lastListRefresh = Date.now();
      }
    } catch (error) {
      if (epoch === this.generation && error.status === 404 && selected && selected === this.current) {
        try { await this.api.chat.conversation(selected); this.fail(error); }
        catch (lookup) {
          if (lookup.status === 404) await this.afterConversationDeleted(selected, epoch, '这段会话已在其他页面删除。');
          else this.fail(lookup);
        }
      } else if (epoch === this.generation) this.fail(error);
    }
    finally { this.polling = false; if (epoch === this.generation) this.schedule(); }
  }
  async loadProposals(more = false) {
    if (!this.current || this.memoryLoading) return;
    const id = this.current, epoch = this.generation; this.memoryLoading = true; this.memoryError = ''; this.emit();
    try {
      const page = await this.api.proposals(id, more ? this.proposalCursor : undefined); if (id !== this.current || epoch !== this.generation) return;
      this.proposals = more ? [...new Map([...this.proposals, ...page.items].map(p => [p.id, p])).values()] : page.items; this.proposalCursor = page.nextCursor;
    } catch (error) { if (epoch === this.generation) { this.memoryError = explain(error); if (error.status === 401) this.fail(error); } }
    finally { if (epoch === this.generation) { this.memoryLoading = false; this.emit(); } }
  }
  async memoryAction(action, item, content) {
    if (this.memoryBusy || !this.session) return;
    const epoch = this.generation, id = this.current;
    this.memoryBusy = true; this.memoryError = ''; this.memoryNotice = ''; this.emit();
    try {
      let result;
      if (action === 'propose') {
        if (!content.trim() || content.length > 16000 || new TextEncoder().encode(content).length > 32768) throw new Error('MEMORY_INPUT_INVALID');
        if (this.pendingProposal && this.pendingProposal.content !== content) { this.memoryError = '上一条候选提出结果待确认。请先用原内容重试。'; return; }
        this.pendingProposal ??= { clientRequestId: crypto.randomUUID(), content, conversationId: id }; this.persistProposal();
        result = await this.api.propose(this.pendingProposal.conversationId, { clientRequestId: this.pendingProposal.clientRequestId, content: this.pendingProposal.content }, this.session.csrfToken);
        if (epoch !== this.generation) return;
        this.pendingProposal = null; this.persistProposal();
      } else if (action === 'edit') {
        if (!content.trim() || content.length > 16000 || new TextEncoder().encode(content).length > 32768) throw new Error('MEMORY_INPUT_INVALID');
        result = await this.api.edit(item, content, this.session.csrfToken);
        // 编辑后的响应必须重新展现；没有自动确认动作。
        this.memoryNotice = '修改已保存为新的待确认版本。请重新阅读后再确认。';
      } else result = await this.api.decide(item, action, this.session.csrfToken);
      if (epoch !== this.generation || id !== this.current) return;
      const index = this.proposals.findIndex(p => p.id === result.id); if (index < 0) this.proposals.push(result); else this.proposals[index] = result;
      this.memoryNotice ||= action === 'confirm' ? '后端已确认并保存这条记忆。' : action === 'reject' ? '后端已拒绝这条候选。' : '已提出候选，尚未写入长期记忆。';
      return result;
    } catch (error) {
      if (epoch !== this.generation) return;
      this.memoryError = error.message === 'MEMORY_INPUT_INVALID' ? '候选不能为空，最多 16000 字符、32 KiB。' : explain(error);
      if (item && (error.status === 409 || !(error instanceof HttpError))) {
        try { const current = await this.api.proposal(item.id); const i = this.proposals.findIndex(p => p.id === item.id); if (i >= 0) this.proposals[i] = current; this.memoryNotice = '已读取后端当前版本，请重新阅读。'; } catch {}
      }
      if (error.status === 401) this.fail(error);
    } finally { if (epoch === this.generation) { this.memoryBusy = false; this.emit(); } }
  }
  async image(message, attachment) {
    const key = message.conversationId + ':' + attachment.id;
    if (this.images.has(key)) return this.images.get(key);
    const item = { loading: true }; this.images.set(key, item); const epoch = this.generation;
    try { const blob = await this.api.chat.image(message.conversationId, attachment); if (epoch !== this.generation || message.conversationId !== this.current || !this.activeViews) { this.images.delete(key); return; } item.url = URL.createObjectURL(blob); }
    catch (error) { item.error = '原图未能加载'; if (error.status === 401) this.fail(error); }
    item.loading = false; this.emit(); return item;
  }
}
export const chatStore = new ChatStore();
