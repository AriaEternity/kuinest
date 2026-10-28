import { chatStore as store } from './store.js';
import { explain } from './api.js';
import { isRunTerminal } from './order.js';
import { renderMarkdown } from './markdown.js';
import { Typewriter } from './typewriter.js';
import { displayPreferences as preferences } from '../preferences.js';
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const button = (label, action, className = '') => { const node = el('button', 'xk-btn ' + className, label); node.type = 'button'; node.addEventListener('click', action); return node; };
const date = value => { const time = new Date(value); return Number.isNaN(time.valueOf()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(time); };
const status = { accepted: '已接受 · 等待回复', running: '正在回复', completed: '完整结束', failed: '回复失败', cancelled: '已取消' };

export class ChatView {
  constructor(root) {
    this.root = root; root.classList.add('chat-content'); this.messageNodes = new Map(); this.attachments = [];
    this.surface = ''; this.pane = 'chat'; this.edits = new Map(); this.expandedDecision = null;
    this.followLatest = true;
    this.onPreferences = () => { if (preferences.reducedMotion || !preferences.value.typewriter) this.flushTyping(); this.render(); };
    this.onVisibility = () => { if (document.hidden) this.flushTyping(); };
    this.unsubscribePreferences = preferences.subscribe(this.onPreferences);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver = new ResizeObserver(() => {
      if (this.surface === 'room' && this.followLatest && !this.loadingOlder && this.chatPane.getClientRects().length) this.scroll.scrollTop = this.scroll.scrollHeight;
    });
    this.resizeObserver.observe(root);
    this.imageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        this.imageObserver.unobserve(entry.target);
        store.image(entry.target.imageMessage, entry.target.imageAttachment);
      }
    });
    this.unsubscribe = store.subscribe(() => this.render()); this.render(); store.attachView();
    this.onViewport = () => this.fitKeyboard(); window.visualViewport?.addEventListener('resize', this.onViewport);
  }
  destroy() { this.stopTyping(); this.unsubscribe(); this.unsubscribePreferences(); this.imageObserver.disconnect(); this.resizeObserver.disconnect(); store.detachView(); window.visualViewport?.removeEventListener('resize', this.onViewport); document.removeEventListener('visibilitychange', this.onVisibility); this.attachments.forEach(a => URL.revokeObjectURL(a.preview)); }
  render() {
    const surface = store.session ? 'room' : 'login';
    if (surface !== this.surface) {
      this.stopTyping(); this.surface = surface; this.root.replaceChildren(); this.messageNodes.clear();
      if (surface === 'login') this.buildLogin(); else this.buildRoom();
    }
    if (surface === 'login') this.updateLogin(); else this.updateRoom();
  }
  buildLogin() {
    const panel = el('div', 'chat-login'); const icon = el('div', 'login-seal', '▣');
    const title = el('h1', '', '小葵聊天室'); const copy = el('p', 'muted', '推开这扇小窗，继续我们的对话。');
    this.loginStatus = el('div', 'chat-notice'); this.loginStatus.setAttribute('role', 'status');
    const form = el('form', 'login-form'); this.loginForm = form;
    const userLabel = el('label', '', '账号'); this.username = el('input', 'pixel-input'); this.username.name = 'username'; this.username.autocomplete = 'username'; this.username.required = true; this.username.maxLength = 128; userLabel.append(this.username);
    const passwordLabel = el('label', '', '口令'); this.password = el('input', 'pixel-input'); this.password.name = 'password'; this.password.type = 'password'; this.password.autocomplete = 'current-password'; this.password.required = true; this.password.maxLength = 1024; passwordLabel.append(this.password);
    this.loginButton = button('进入聊天室', () => {}); this.loginButton.type = 'submit';
    form.addEventListener('submit', async e => { e.preventDefault(); const password = this.password.value; this.password.value = ''; await store.login(this.username.value, password); });
    form.append(userLabel, passwordLabel, this.loginButton);
    const choice = el('div', 'login-choice'); this.demoButton = button('看看界面演示', () => store.switchMode('demo'));
    this.connectButton = button('重新连接', () => store.switchMode('http'));
    choice.append(this.demoButton, this.connectButton);
    const note = el('p', 'muted login-note', '仅主人登录。口令只提交给后端，不在本机保存。演示使用独立合成数据。');
    panel.append(icon, title, copy, this.loginStatus, form, choice, note); this.root.append(panel);
  }
  updateLogin() {
    this.loginStatus.textContent = store.loading ? '正在恢复登录状态…' : store.error || store.notice || (store.mode === 'demo' ? '界面演示 · 合成数据' : '连接模式 · 真实 HTTP');
    this.loginForm.hidden = store.mode === 'demo';
    this.demoButton.textContent = store.mode === 'demo' ? '重新进入演示' : '看看界面演示';
    this.loginStatus.classList.toggle('is-error', !!store.error);
    this.loginButton.disabled = store.loading || store.busy;
    this.demoButton.disabled = store.loading || store.busy; this.connectButton.disabled = store.loading || store.busy;
    this.loginButton.textContent = store.busy ? '正在登录…' : '进入聊天室';
  }
  buildRoom() {
    this.room = el('div', 'chat-room');
    const top = el('div', 'chat-toolbar');
    this.modeBadge = el('span', 'mode-badge'); this.modeBadge.setAttribute('role', 'status');
    this.listToggle = button('会话', () => { this.pane = this.pane === 'list' ? 'chat' : 'list'; this.updatePanes(); });
    this.memoryToggle = button('记忆', async () => { store.memoryOpen = !store.memoryOpen; if (store.memoryOpen) { this.pane = 'memory'; await store.loadProposals(); } else this.pane = 'chat'; this.updatePanes(); });
    this.httpButton = button('连接后端', () => { this.attachments.forEach(a => URL.revokeObjectURL(a.preview)); this.attachments = []; store.switchMode('http'); });
    this.logoutButton = button('退出', () => store.logout());
    top.append(this.listToggle, this.modeBadge, this.memoryToggle, this.httpButton, this.logoutButton);
    this.banner = el('div', 'chat-banner'); this.banner.setAttribute('role', 'status');
    this.bannerText = el('span'); this.reconcileButton = button('重新对账', () => store.current ? store.reconcile() : store.switchMode(store.mode)); this.banner.append(this.bannerText, this.reconcileButton);
    this.body = el('div', 'chat-body');
    this.listPane = el('aside', 'conversation-pane'); this.listPane.setAttribute('aria-label', '会话列表');
    const listHeader = el('div', 'pane-heading'); listHeader.append(el('span', '', '我们的会话'), button('新建', () => { this.createForm.hidden = !this.createForm.hidden; if (!this.createForm.hidden) this.titleInput.focus(); }));
    this.createForm = el('form', 'create-form'); this.createForm.hidden = true;
    this.titleInput = el('input', 'pixel-input'); this.titleInput.placeholder = '会话标题（可留空）'; this.titleInput.maxLength = 100; this.titleInput.setAttribute('aria-label', '新会话标题');
    this.createSubmit = button('创建', () => {}); this.createSubmit.type = 'submit';
    this.createForm.addEventListener('submit', async e => { e.preventDefault(); await store.create(this.titleInput.value); if (!store.error) { this.createForm.hidden = true; this.titleInput.value = ''; this.pane = 'chat'; this.updatePanes(); } });
    this.createForm.append(this.titleInput, this.createSubmit); this.conversationList = el('div', 'conversation-list');
    this.moreConversations = button('更多会话', async () => { try { await store.loadConversations(true); } catch (e) { store.fail(e); } });
    this.listPane.append(listHeader, this.createForm, this.conversationList, this.moreConversations);
    this.chatPane = el('main', 'message-pane'); this.chatPane.setAttribute('aria-label', '聊天内容');
    const chatHeader = el('div', 'chat-heading'); this.conversationTitle = el('span'); this.runStatus = el('span', 'run-status'); this.runStatus.setAttribute('role', 'status');
    const conversationActions = el('div', 'conversation-actions');
    this.renameButton = button('改名', () => this.openConversationAction('rename'));
    this.deleteButton = button('删除', () => this.openConversationAction('delete'), 'conversation-delete');
    conversationActions.append(this.renameButton, this.deleteButton); chatHeader.append(this.conversationTitle, this.runStatus, conversationActions);
    this.managementTarget = null;
    this.managementPanel = el('form', 'conversation-management'); this.managementPanel.hidden = true; this.managementPanel.setAttribute('aria-label', '管理当前会话');
    this.managementHeading = el('strong'); this.managementCopy = el('p', 'muted');
    this.renameInput = el('input', 'pixel-input'); this.renameInput.setAttribute('aria-label', '新的会话名'); this.renameInput.maxLength = 200;
    const managementControls = el('div', 'conversation-actions');
    this.managementCommit = button('保存名称', () => {}); this.managementCommit.type = 'submit';
    this.managementCancel = button('取消', () => this.closeConversationAction());
    managementControls.append(this.managementCancel, this.managementCommit);
    this.managementPanel.append(this.managementHeading, this.managementCopy, this.renameInput, managementControls);
    this.managementPanel.addEventListener('keydown', event => { if (event.key === 'Escape' && !store.conversationBusy) { event.preventDefault(); event.stopPropagation(); this.closeConversationAction(); } });
    this.managementPanel.addEventListener('submit', async event => {
      event.preventDefault(); const target = this.managementTarget; if (!target || store.conversationBusy) return;
      const ok = target.action === 'rename' ? await store.renameConversation(target.id, this.renameInput.value) : await store.deleteConversation(target.id);
      if (ok) this.closeConversationAction();
    });
    this.scenario = el('select', 'pixel-input demo-scenario'); this.scenario.setAttribute('aria-label', '合成验证场景');
    for (const [value, text] of [['normal', '正常回复'], ['lost', '提交响应丢失'], ['disconnect', '流中断后恢复'], ['failure', '回复失败'], ['race', '取消与完成竞态']]) { const option = el('option', '', text); option.value = value; this.scenario.append(option); }
    this.scenario.addEventListener('change', () => store.demo?.setScenario(this.scenario.value));
    this.scroll = el('div', 'message-scroll'); this.scroll.tabIndex = 0; this.scroll.setAttribute('aria-label', '消息记录');
    this.olderButton = button('读取更早消息', async () => {
      const height = this.scroll.scrollHeight, top = this.scroll.scrollTop; this.loadingOlder = true;
      await store.older(); this.scroll.scrollTop = top + this.scroll.scrollHeight - height; this.loadingOlder = false;
    }, 'older-button');
    this.messagesRoot = el('div', 'messages'); this.empty = el('div', 'chat-empty');
    this.pendingBubble = el('div', 'pending-message'); this.pendingText = el('div', 'plain-message'); this.pendingStatus = el('div', 'muted');
    const pendingActions = el('div', 'pending-actions'); this.pendingLookup = button('查询原提交', () => store.reconcileSubmission()); this.pendingRetry = button('以原标识重试', () => store.submitPending(store.current)); this.pendingReturn = button('返回输入框', () => store.discardRejected());
    pendingActions.append(this.pendingLookup, this.pendingRetry, this.pendingReturn); this.pendingBubble.append(this.pendingText, this.pendingStatus, pendingActions);
    this.scroll.append(this.olderButton, this.empty, this.messagesRoot, this.pendingBubble);
    this.jump = button('↓ 新消息', () => this.showLatest(), 'jump-latest'); this.jump.hidden = true;
    this.scroll.addEventListener('scroll', () => {
      if (!this.chatPane.getClientRects().length) return;
      this.followLatest = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 80;
      if (this.followLatest) this.jump.hidden = true; this.signalReading();
    });
    this.composer = el('form', 'chat-composer');
    this.attachmentsRoot = el('div', 'composer-attachments');
    this.textarea = el('textarea', 'pixel-input chat-input'); this.textarea.rows = 3; this.textarea.placeholder = '写点什么给小葵…'; this.textarea.setAttribute('aria-label', '消息正文');
    this.textarea.addEventListener('input', () => { store.drafts.set(store.current, this.textarea.value); this.updateComposer(); });
    this.textarea.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !this.sendButton.disabled) { e.preventDefault(); this.composer.requestSubmit(); } });
    this.composer.addEventListener('submit', async e => { e.preventDefault(); await this.send(); });
    const controls = el('div', 'composer-controls'); this.searchLabel = el('label', 'search-choice'); this.searchInput = el('input'); this.searchInput.type = 'checkbox'; this.searchLabel.append(this.searchInput, document.createTextNode('本轮联网'));
    this.fileInput = el('input'); this.fileInput.type = 'file'; this.fileInput.accept = 'image/png,image/jpeg'; this.fileInput.multiple = true; this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => this.chooseImages()); this.imageButton = button('图片', () => this.fileInput.click());
    this.inputHint = el('span', 'input-hint', 'Enter 寄出 · Shift+Enter 换行'); this.cancelButton = button('停止回复', () => store.cancel());
    this.sendButton = button('寄出', () => {}); this.sendButton.type = 'submit'; controls.append(this.imageButton, this.searchLabel, this.inputHint, this.cancelButton, this.sendButton);
    this.composer.append(this.attachmentsRoot, this.textarea, this.fileInput, controls);
    this.chatPane.append(chatHeader, this.managementPanel, this.scenario, this.scroll, this.jump, this.composer);
    this.buildMemory(); this.body.append(this.listPane, this.chatPane, this.memoryPane); this.room.append(top, this.banner, this.body); this.root.append(this.room);
  }
  updateRoom() {
    this.modeBadge.textContent = store.mode === 'demo' ? '界面演示 · 合成数据' : store.meta?.mode === 'synthetic' ? 'HTTP 联调 · 合成后端' : '后端连接';
    this.httpButton.hidden = store.mode !== 'demo'; this.logoutButton.disabled = store.busy;
    const serviceNotice = !store.meta ? '尚未读取服务能力，请重新连接。' : !store.meta.capabilities.chat ? '聊天服务尚未准备好。可以查看历史，或重新对账检查服务状态。' : '';
    this.banner.hidden = !store.error && !store.notice && !serviceNotice;
    this.bannerText.textContent = store.error || store.notice || serviceNotice; this.banner.classList.toggle('is-error', !!store.error); this.reconcileButton.disabled = !!store.reconciling;
    this.listPane.classList.toggle('is-loading', store.busy); this.createSubmit.disabled = store.busy || store.conversationBusy;
    this.renameButton.disabled = this.deleteButton.disabled = !store.current || store.loading || store.conversationBusy;
    if (this.managementTarget && this.managementTarget.id !== store.current) this.closeConversationAction(false);
    if (this.managementTarget) {
      this.managementCommit.disabled = store.conversationBusy || this.managementTarget.action === 'delete' && store.deletionBlocked(this.managementTarget.id);
      this.managementCancel.disabled = store.conversationBusy; this.renameInput.readOnly = store.conversationBusy;
      if (this.managementTarget.action === 'delete') this.managementCopy.textContent = store.deletionBlocked(this.managementTarget.id)
        ? '仍有回复或提交结果待确认，请先取消本次操作，停止回复或完成对账后再删除。'
        : '删除后会从列表移除，无法在界面中恢复。已确认的长期记忆保留。';
    }
    const listSignature = JSON.stringify([store.current, store.conversations.map(c => [c.id, c.title, c.updatedAt])]);
    if (this.listSignature !== listSignature) {
      this.listSignature = listSignature; this.conversationList.replaceChildren();
      for (const c of store.conversations) {
        const item = button('', () => { this.pane = 'chat'; store.select(c.id); }); item.className = 'conversation-item'; item.classList.toggle('selected', c.id === store.current); item.setAttribute('aria-current', c.id === store.current ? 'true' : 'false');
        item.append(el('span', 'conversation-name', c.title || '未命名会话'), el('small', 'muted', date(c.updatedAt))); this.conversationList.append(item);
      }
      if (!store.conversations.length) this.conversationList.append(el('p', 'muted', store.loading ? '正在读取会话…' : '还没有会话。点「新建」写第一封信。'));
    }
    this.moreConversations.hidden = !store.nextCursor;
    const changedConversation = this.renderedConversation !== store.current;
    if (changedConversation) {
      this.stopTyping(); this.renderedConversation = store.current; this.messageNodes.clear(); this.messagesRoot.replaceChildren(); this.scroll.scrollTop = 0; this.edits.clear(); this.expandedDecision = null;
      this.textarea.value = store.drafts.get(store.current) || ''; this.searchInput.checked = false;
      this.attachments.forEach(a => URL.revokeObjectURL(a.preview)); this.attachments = []; this.updateAttachments();
    }
    const run = store.activeRun;
    if (store.currentPending?.input.imageIds?.length && store.currentPending.phase === 'rejected') this.pendingReturn.textContent = '返回正文 · 图片需重新选择';
    else this.pendingReturn.textContent = '返回输入框';
    this.conversationTitle.textContent = store.conversations.find(c => c.id === store.current)?.title || (store.current ? '当前会话' : '写下第一封信');
    this.runStatus.textContent = store.loading ? '正在读取…' : run ? (store.cancelRequests.has(run.runId) ? '正在请求取消…' : status[run.status]) : '';
    this.scenario.hidden = store.mode !== 'demo'; this.scenario.disabled = !!run || !!store.currentPending;
    this.olderButton.hidden = !store.state()?.cursor; this.olderButton.disabled = store.loading;
    this.empty.hidden = store.messages.length > 0 || !!store.currentPending;
    this.empty.replaceChildren(el('span', 'empty-mark', '✉'), el('p', '', store.loading ? '正在读取会话…' : store.current ? '窗边安静，等你落笔。' : '先新建一个会话吧。'), el('small', 'muted', store.meta && !store.meta.capabilities.chat ? '聊天服务尚未准备好，历史仍可查看。' : store.mode === 'demo' ? '这里的文字均为界面合成示例。' : '消息由后端接收与保存。'));
    this.renderMessages(changedConversation);
    const pending = store.currentPending; this.pendingBubble.hidden = !pending;
    if (pending) {
      this.pendingText.textContent = pending.input.text || '图片消息';
      this.pendingStatus.textContent = { submitting: '提交中 · 尚未确认接受', accepted: '已接受 · 正在对账', unknown: '状态待确认 · 保留原标识与原内容', rejected: '提交未被接受 · 请根据错误处理' }[pending.phase];
      this.pendingLookup.hidden = pending.phase === 'submitting'; this.pendingRetry.hidden = !['unknown', 'rejected'].includes(pending.phase); this.pendingReturn.hidden = pending.phase !== 'rejected';
    }
    const draft = store.drafts.get(store.current) || '';
    if (this.textarea.value !== draft) this.textarea.value = draft;
    this.updateComposer(); this.updateMemory(); this.updatePanes();
    this.signalReading();
  }
  openConversationAction(action) {
    const item = store.conversations.find(conversation => conversation.id === store.current);
    if (!item || store.conversationBusy) return;
    this.managementTarget = { id: item.id, action };
    this.managementHeading.textContent = action === 'rename' ? '修改会话名' : '删除“' + (item.title || '未命名会话') + '”？';
    this.managementCopy.textContent = action === 'rename' ? '输入 1—100 个字符。聊天内容保持不变。' : '';
    this.renameInput.hidden = action !== 'rename'; this.renameInput.value = item.title;
    this.managementCommit.textContent = action === 'rename' ? '保存名称' : '确认删除';
    this.managementPanel.hidden = false; this.updateRoom();
    if (action === 'rename') { this.renameInput.focus(); this.renameInput.select(); } else this.managementCancel.focus();
  }
  closeConversationAction(focus = true) {
    const previous = this.managementTarget; this.managementTarget = null;
    if (this.managementPanel) this.managementPanel.hidden = true;
    if (focus && previous) (previous.action === 'rename' ? this.renameButton : this.deleteButton)?.focus();
  }
  renderMessages(changedConversation) {
    // 隐藏窗口的尺寸会归零，不能据此把旧消息阅读误判为跟随最新。
    const visible = this.chatPane.getClientRects().length > 0;
    const wasAtBottom = visible ? this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 80 : this.followLatest;
    let changed = false; const ids = new Set();
    for (const message of store.messages) {
      const run = message.runId && store.runs.get(message.runId);
      ids.add(message.id); let row = this.messageNodes.get(message.id);
      if (!row) {
        const node = el('article', 'message message-' + message.role); node.dataset.messageId = message.id;
        const head = el('header', 'message-meta'); const name = el('span', 'message-author', message.role === 'user' ? '你' : '小葵');
        const time = el('time', '', date(message.createdAt)); time.dateTime = message.createdAt; const state = el('span', 'message-state'); head.append(name, time, state);
        const body = el('div', 'message-text'); const images = el('div', 'message-images'); const failure = el('div', 'message-failure');
        const cursor = el('span', 'typing-cursor'); cursor.setAttribute('aria-hidden', 'true'); cursor.hidden = true;
        node.append(head, body, images, failure); row = { node, body, state, images, failure, cursor, writer: new Typewriter(message.content), live: false, version: null }; this.messageNodes.set(message.id, row); changed = true;
      }
      row.message = message; row.run = run;
      if (message.role === 'assistant') {
        const stopped = run?.status === 'failed' || run?.status === 'cancelled';
        const recovered = row.sequence !== undefined && run?.lastSequence > row.sequence + 1;
        const animate = (row.live || row.writer.pending) && !stopped && !recovered && !store.loading && !store.error && !document.hidden && preferences.value.typewriter && !preferences.reducedMotion && this.chatPane.getClientRects().length > 0;
        row.writer.setText(message.content, { animate, now: performance.now() });
        row.live = !store.loading && run && !isRunTerminal(run);
        row.sequence = run?.lastSequence;
        changed = this.paintReply(row) || changed;
      }
      const version = JSON.stringify([message.revision, run?.status, run?.error, store.images.size]);
      if (row.version !== version || message.attachments?.length) {
        if (message.role !== 'assistant') {
          if (row.content !== message.content) { row.content = message.content; row.body.textContent = message.content; changed = true; }
          row.state.textContent = '已接受';
        }
        row.failure.textContent = message.role === 'assistant' && run?.error ? run.error.message + '（' + run.error.code + '）' : '';
        row.failure.hidden = message.role !== 'assistant' || !run?.error; row.version = version;
        for (const attachment of message.attachments || []) {
          let node = row.images.querySelector(`[data-image-id="${CSS.escape(attachment.id)}"]`);
          if (!node) { node = el('div', 'message-image'); node.dataset.imageId = attachment.id; row.images.append(node); }
          const image = store.images.get(message.conversationId + ':' + attachment.id);
          if (!image && !node.imageObserved) { node.textContent = '原图加载中…'; node.imageMessage = message; node.imageAttachment = attachment; node.imageObserved = true; this.imageObserver.observe(node); }
          else if (image.url && !node.querySelector('img')) { node.replaceChildren(); const link = el('a'); link.href = image.url; link.target = '_blank'; link.rel = 'noopener'; const img = el('img'); img.src = image.url; img.alt = '消息附件'; img.loading = 'lazy'; link.append(img); node.append(link); }
          else if (image.error) { node.textContent = image.error; }
        }
      }
      // 仅节点顺序改变时挪动，文字更新不会重建消息或输入框。
      const previous = this.messagesRoot.children[Array.from(ids).length - 1];
      if (previous !== row.node) this.messagesRoot.insertBefore(row.node, previous || null);
    }
    for (const [id, row] of this.messageNodes) if (!ids.has(id)) { row.node.remove(); this.messageNodes.delete(id); }
    if (!this.loadingOlder && (changedConversation || wasAtBottom)) { this.followLatest = true; if (visible) this.scroll.scrollTop = this.scroll.scrollHeight; }
    else if (changed) this.jump.hidden = false;
    this.scheduleTyping();
  }
  paintReply(row) {
    const text = row.writer.visible, run = row.run, message = row.message;
    const active = row.live && run && !isRunTerminal(run) && !store.error && !document.hidden && this.chatPane.getClientRects().length > 0;
    const placeholder = run?.status === 'cancelled' ? '这次回复已取消。' : run?.status === 'failed' ? '没有生成可显示的回复。' : '· · ·';
    const key = text || placeholder;
    const changed = row.renderedText !== key;
    if (changed) {
      row.renderedText = key;
      if (text) row.body.replaceChildren(renderMarkdown(text));
      else if (placeholder === '· · ·') { row.body.replaceChildren(...[0, 1, 2].map(() => el('span', 'waiting-dot', '·'))); }
      else row.body.textContent = placeholder;
    }
    row.body.classList.toggle('waiting-reply', !text && active);
    row.cursor.hidden = !text || !(active || row.writer.pending) || !preferences.value.typewriter || preferences.reducedMotion;
    if (!row.cursor.hidden && (!row.cursor.isConnected || changed)) {
      // 光标进入最后一个正文块，代码中的光标不包含文字，不会污染复制结果。
      const last = row.body.lastElementChild;
      (last?.matches('.code-box') ? last.querySelector('code') : last?.matches('ul,ol') ? last.lastElementChild : last || row.body).append(row.cursor);
    }
    row.state.textContent = (run ? status[run.status] : message.status === 'complete' ? '完整结束' : message.runId ? '正在核对运行…' : '历史不完整') + (run?.status === 'completed' && row.writer.pending ? ' · 文字展开中' : '');
    return changed;
  }
  scheduleTyping() {
    if (this.typingFrame || ![...this.messageNodes.values()].some(row => row.writer.pending)) return;
    this.typingFrame = requestAnimationFrame(now => {
      this.typingFrame = null;
      if (this.surface !== 'room') return;
      const follow = this.followLatest; let changed = false;
      for (const row of this.messageNodes.values()) if (row.message.role === 'assistant' && row.writer.advance(now)) changed = this.paintReply(row) || changed;
      if (changed) { if (follow) this.scroll.scrollTop = this.scroll.scrollHeight; else this.jump.hidden = false; }
      this.signalReading();
      this.scheduleTyping();
    });
  }
  stopTyping() { if (this.typingFrame) cancelAnimationFrame(this.typingFrame); this.typingFrame = null; }
  signalReading() { this.root.dispatchEvent(new Event('chat-reading', { bubbles: true })); }
  readingConversation() {
    return this.surface === 'room' && !store.loading && this.renderedConversation === store.current &&
      this.chatPane.getClientRects().length && this.followLatest &&
      this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 80 ? store.current : null;
  }
  showLatest() {
    if (this.surface !== 'room') return;
    this.pane = 'chat'; this.updatePanes(); this.followLatest = true;
    this.scroll.scrollTop = this.scroll.scrollHeight; this.jump.hidden = true;
    this.scroll.focus({ preventScroll: true }); this.signalReading();
  }
  flushTyping() {
    this.stopTyping();
    if (this.surface !== 'room') return;
    for (const row of this.messageNodes.values()) if (row.message.role === 'assistant') { row.writer.flush(); this.paintReply(row); }
    if (this.followLatest && this.chatPane.getClientRects().length) this.scroll.scrollTop = this.scroll.scrollHeight;
  }
  updateComposer() {
    if (!this.textarea) return;
    const pending = store.currentPending, run = store.activeRun;
    const unavailable = !store.current || !store.meta?.capabilities.chat || store.loading || store.conversationBusy;
    this.textarea.disabled = unavailable || this.uploading;
    this.sendButton.disabled = unavailable || !!pending || !!run || this.uploading || (!this.textarea.value.trim() && !this.attachments.length);
    this.sendButton.textContent = this.uploading ? '上传中…' : pending?.phase === 'submitting' ? '提交中…' : '寄出';
    this.cancelButton.hidden = !run; this.cancelButton.disabled = !!run && store.cancelRequests.has(run.runId);
    this.imageButton.hidden = !store.meta?.capabilities.imageAttachments; this.imageButton.disabled = unavailable || this.uploading;
    this.searchLabel.hidden = !store.meta?.capabilities.webSearch; this.searchInput.disabled = !!pending || !!run || this.uploading;
    if (!store.meta?.capabilities.webSearch) this.searchInput.checked = false;
  }
  async chooseImages() {
    for (const file of this.fileInput.files) {
      if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 10 * 1024 * 1024 || this.attachments.length >= 8 || file.size + this.attachments.reduce((n, a) => n + a.file.size, 0) > 20 * 1024 * 1024) { store.error = '图片仅支持 PNG/JPEG，每张最多 10 MiB，每条最多 8 张、20 MiB。'; continue; }
      this.attachments.push({ id: crypto.randomUUID(), file, preview: URL.createObjectURL(file) });
    }
    this.fileInput.value = ''; this.updateAttachments(); store.emit();
  }
  updateAttachments() {
    this.attachmentsRoot.replaceChildren();
    for (const item of this.attachments) {
      const card = el('div', 'attachment-preview'); const image = el('img'); image.src = item.preview; image.alt = '待上传图片';
      card.append(image, button('移除', () => { URL.revokeObjectURL(item.preview); this.attachments = this.attachments.filter(a => a !== item); this.updateAttachments(); this.updateComposer(); })); this.attachmentsRoot.append(card);
    }
  }
  async send() {
    if (this.sendButton.disabled) return;
    const id = store.current, epoch = store.generation, text = this.textarea.value, allowSearch = this.searchInput.checked;
    const images = [...this.attachments]; this.uploading = true; this.updateComposer();
    try {
      for (const item of images) {
        if (!store.meta?.capabilities.imageAttachments) throw new Error('IMAGE_CAPABILITY_UNAVAILABLE');
        if (!item.uploaded) { await store.api.chat.uploadImage(id, item.id, item.file, store.session.csrfToken); item.uploaded = true; }
      }
      if (id !== store.current || epoch !== store.generation) return;
      await store.send(text, allowSearch, images.map(a => a.id));
      if (store.current === id && !store.currentPending && !store.drafts.get(id)) { images.forEach(a => URL.revokeObjectURL(a.preview)); this.attachments = []; this.updateAttachments(); }
    } catch (error) { if (epoch === store.generation) store.fail(error, '图片上传结果待确认，请用原图片重试'); }
    finally { this.uploading = false; this.updateComposer(); }
  }
  buildMemory() {
    this.memoryPane = el('aside', 'memory-pane'); this.memoryPane.setAttribute('aria-label', '记忆候选');
    const heading = el('div', 'pane-heading'); heading.append(el('span', '', '记忆候选'), button('返回', () => { store.memoryOpen = false; this.pane = 'chat'; this.updatePanes(); }));
    this.memoryStatus = el('div', 'memory-status'); this.memoryStatus.setAttribute('role', 'status');
    const introduction = el('p', 'muted', '先提出，再阅读确认。只有后端确认后才进入长期记忆。');
    this.memoryForm = el('form', 'memory-propose'); const label = el('label', '', '提出一条记忆'); this.memoryInput = el('textarea', 'pixel-input'); this.memoryInput.rows = 3; this.memoryInput.maxLength = 16000; this.memoryInput.placeholder = '写下想保留的事情…'; label.append(this.memoryInput);
    const controls = el('div', 'memory-controls'); this.proposeButton = button('提出候选', () => {}); this.proposeButton.type = 'submit'; this.refreshMemory = button('刷新', () => { this.edits.clear(); this.expandedDecision = null; store.loadProposals(); }); controls.append(this.proposeButton, this.refreshMemory);
    this.memoryForm.addEventListener('submit', async e => { e.preventDefault(); const result = await store.memoryAction('propose', null, this.memoryInput.value); if (result) this.memoryInput.value = ''; });
    this.memoryForm.append(label, controls); this.memoryList = el('div', 'memory-list'); this.moreMemory = button('更多候选', () => store.loadProposals(true));
    this.memoryPane.append(heading, introduction, this.memoryStatus, this.memoryForm, this.memoryList, this.moreMemory);
  }
  updateMemory() {
    this.memoryStatus.textContent = store.memoryError || store.memoryNotice || (store.memoryLoading ? '正在读取候选…' : '');
    this.memoryStatus.classList.toggle('is-error', !!store.memoryError);
    this.proposeButton.disabled = !store.current || store.memoryBusy; this.refreshMemory.disabled = store.memoryLoading || store.memoryBusy;
    if (store.pendingProposal && !this.memoryInput.value) this.memoryInput.value = store.pendingProposal.content;
    const signature = JSON.stringify([store.proposals, store.memoryBusy, store.memoryLoading, this.expandedDecision, [...this.edits.keys()]]);
    if (signature !== this.memorySignature) {
      this.memorySignature = signature; this.memoryList.replaceChildren();
      for (const item of store.proposals) this.memoryList.append(this.memoryCard(item));
      if (!store.proposals.length) this.memoryList.append(el('p', 'muted', store.memoryLoading ? '正在读取…' : store.memoryError ? '候选暂未能读取。' : '还没有候选，先写下一件想记住的事。'));
    }
    this.moreMemory.hidden = !store.proposalCursor; this.moreMemory.disabled = store.memoryLoading;
  }
  memoryCard(item) {
    const card = el('article', 'memory-card'); card.dataset.proposalId = item.id;
    const head = el('div', 'memory-card-meta'); head.append(el('span', '', { pending: '待确认', confirmed: '已确认', rejected: '已拒绝' }[item.status]), el('span', 'muted', 'v' + item.revision + ' · ' + date(item.updatedAt)));
    card.append(head);
    const edit = this.edits.get(item.id);
    if (edit && edit.revision === item.revision) {
      const textarea = el('textarea', 'pixel-input'); textarea.value = edit.content; textarea.rows = 5; textarea.maxLength = 16000; textarea.setAttribute('aria-label', '编辑候选正文');
      textarea.addEventListener('input', () => edit.content = textarea.value); card.append(textarea);
      const actions = el('div', 'memory-controls'); const save = button('保存修改', async () => { const result = await store.memoryAction('edit', item, edit.content); if (result) { this.edits.delete(item.id); this.expandedDecision = null; this.updateMemory(); } }); save.disabled = store.memoryBusy;
      actions.append(save, button('放弃修改', () => { this.edits.delete(item.id); this.updateMemory(); })); card.append(actions);
    } else {
      if (edit) this.edits.delete(item.id);
      card.append(el('div', 'memory-card-content', item.content));
      if (item.status === 'pending') {
        const actions = el('div', 'memory-controls');
        const editButton = button('编辑', () => { this.edits.set(item.id, { revision: item.revision, content: item.content }); this.expandedDecision = null; this.updateMemory(); });
        const confirm = button('确认', () => { this.expandedDecision = item.id + ':confirm'; this.updateMemory(); });
        const reject = button('拒绝', () => { this.expandedDecision = item.id + ':reject'; this.updateMemory(); });
        for (const b of [editButton, confirm, reject]) b.disabled = store.memoryBusy;
        actions.append(editButton, confirm, reject); card.append(actions);
        if (this.expandedDecision?.startsWith(item.id + ':')) {
          const action = this.expandedDecision.split(':').at(-1), decision = el('div', 'memory-decision');
          decision.append(el('p', '', action === 'confirm' ? '已阅读上方当前版本？确认后后端会保存为新增记忆。' : '拒绝这条候选？它将不会进入长期记忆。'));
          const commit = button(action === 'confirm' ? '确认保存' : '确定拒绝', async () => { await store.memoryAction(action, item); this.expandedDecision = null; this.updateMemory(); }); commit.disabled = store.memoryBusy;
          decision.append(commit, button('返回阅读', () => { this.expandedDecision = null; this.updateMemory(); })); card.append(decision);
        }
      }
    }
    return card;
  }
  updatePanes() {
    this.room.dataset.pane = this.pane;
    this.room.classList.toggle('with-memory', store.memoryOpen);
    this.memoryToggle.setAttribute('aria-expanded', String(store.memoryOpen));
    this.listToggle.setAttribute('aria-expanded', String(this.pane === 'list'));
    if (!store.memoryOpen && this.pane === 'memory') { this.pane = 'chat'; this.room.dataset.pane = 'chat'; }
    if (!this.chatPane.getClientRects().length) this.flushTyping();
  }
  fitKeyboard() { if (document.activeElement === this.textarea && this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 120) this.scroll.scrollTop = this.scroll.scrollHeight; }
}
