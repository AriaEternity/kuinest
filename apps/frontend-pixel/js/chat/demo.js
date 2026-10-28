// 纯合成 HTTP/SSE 传输：仍经过共享 ChatClient、合同校验和真实状态机。
// 只显式进入演示时使用；HTTP 失败不调用本模块。
import { imageUploadLimits } from '@kuinest/contracts';
const KEY = 'kuinest-pixel-synthetic-v1';
const copy = value => structuredClone(value);
const now = () => new Date().toISOString();
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const fault = (status, code) => json({ error: { code, message: '合成验证状态。' }, requestId: 'synthetic-request' }, status);
const csrf = 's'.repeat(43);
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
export async function createDemo() {
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  if (!db || db.version !== 1) {
    const [history, proposals] = await Promise.all([
      fetch(new URL('./fixtures/basic-conversation.json', import.meta.url)).then(r => r.json()),
      fetch(new URL('./fixtures/memory-proposals.json', import.meta.url)).then(r => r.json()),
    ]);
    db = { version: 1, conversations: [{ id: 'demo-conversation-001', title: '第一封合成信', updatedAt: now(), revision: history.revision }], messages: { 'demo-conversation-001': history.items }, runs: {}, proposals: proposals.items, submissions: {}, revision: history.revision };
  }
  if (!db.messages['demo-history-001']) {
    const id = 'demo-history-001', items = [];
    for (let index = 0; index < 64; index++) items.push({ id: 'demo-archive-' + index, conversationId: id, role: index % 2 ? 'assistant' : 'user', content: `合成档案第 ${index + 1} 条。这里只检查历史分页与阅读顺序。`, status: 'complete', createdAt: new Date(Date.UTC(2026, 8, 10, 0, index)).toISOString(), revision: ++db.revision });
    db.messages[id] = items; db.conversations.push({ id, title: '合成历史档案', updatedAt: items.at(-1).createdAt, revision: db.revision });
  }
  let scenario = 'normal';
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  const emit = (run, type, fields = {}) => { run.lastSequence++; run.events.push({ runId: run.runId, sequence: run.lastSequence, occurredAt: now(), type, ...copy(fields) }); };
  const revise = run => {
    if (run.reply) { run.reply.revision = ++db.revision; const items = db.messages[run.conversationId]; const i = items.findIndex(m => m.id === run.reply.id); if (i >= 0) items[i] = copy(run.reply); else items.push(copy(run.reply)); }
    const c = db.conversations.find(c => c.id === run.conversationId); c.revision = db.revision; c.updatedAt = now();
  };
  const snapshot = run => {
    const { runId, conversationId, origin, status, lastSequence, reply, error } = run;
    return copy({ runId, conversationId, origin, status, lastSequence, ...(reply ? { reply } : {}), ...(error ? { error } : {}) });
  };
  function advance(run) {
    if (terminal(run.status)) return;
    if (run.cancelRequested && run.scenario !== 'race') {
      run.status = 'cancelled'; revise(run); emit(run, 'run.cancelled', { partialReply: run.reply }); save(); return;
    }
    const steps = Math.floor((Date.now() - run.startedAt) / 450);
    if (steps > 0 && run.status === 'accepted') { run.status = 'running'; emit(run, 'run.started'); }
    while (run.chunk < Math.min(steps, run.chunks.length)) {
      const text = run.chunks[run.chunk++]; run.reply.content += text; revise(run);
      emit(run, 'reply.delta', { replyId: run.reply.id, text, revision: run.reply.revision });
    }
    if (steps > run.chunks.length) {
      run.status = run.scenario === 'failure' ? 'failed' : 'completed';
      run.reply.status = run.status === 'completed' ? 'complete' : 'partial'; revise(run);
      if (run.status === 'completed') emit(run, 'run.completed', { reply: run.reply });
      else { run.error = { code: 'UPSTREAM_UNAVAILABLE', message: '合成故障：上游暂时不可用。' }; emit(run, 'run.failed', { ...run.error, partialReply: run.reply }); }
    }
    save();
  }
  const hash = async content => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(b => b.toString(16).padStart(2, '0')).join('');
  async function request(url, options = {}) {
    options.signal?.throwIfAborted();
    const parsed = new URL(url, location.origin), path = parsed.pathname.replace('/api/v1', ''), method = options.method || 'GET';
    const input = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : {};
    if (path === '/auth/session' || path === '/auth/login') return json({ ownerId: 'synthetic-owner', expiresAt: new Date(Date.now() + 86400000).toISOString(), csrfToken: csrf });
    if (path === '/auth/logout') return new Response(null, { status: 204 });
    if (path === '/meta') return json({ apiVersion: '0.3', mode: 'synthetic', imageLimits: imageUploadLimits, capabilities: { chat: true, history: true, resumableEvents: true, messageChanges: true, imageAttachments: false, webSearch: false, proactiveMessages: false } });
    if (method !== 'GET' && options.headers?.['X-CSRF-Token'] !== csrf) return fault(403, 'CSRF_INVALID');
    if (path === '/conversations') {
      if (method === 'POST') { const c = { id: 'demo-' + crypto.randomUUID(), title: input.title || '新会话', updatedAt: now(), revision: 0 }; db.conversations.push(c); db.messages[c.id] = []; save(); return json(c, 201); }
      return json({ items: copy(db.conversations), nextCursor: null });
    }
    const singleConversation = path.match(/^\/conversations\/([^/]+)$/);
    if (singleConversation) {
      const id = decodeURIComponent(singleConversation[1]);
      const item = db.conversations.find(conversation => conversation.id === id);
      db.deletedConversations ??= [];
      if (!item) return method === 'DELETE' && db.deletedConversations.includes(id) ? new Response(null, { status: 204 }) : fault(404, 'NOT_FOUND');
      if (method === 'GET') return json(copy(item));
      if (method === 'PATCH') {
        if (typeof input.title !== 'string' || !input.title.trim() || [...input.title.trim()].length > 100 || /[\u0000-\u001f\u007f]/u.test(input.title)) return fault(400, 'INPUT_INVALID');
        item.title = input.title.trim(); item.updatedAt = now(); save(); return json(copy(item));
      }
      if (method === 'DELETE') {
        const runs = Object.values(db.runs).filter(run => run.conversationId === id); runs.forEach(advance);
        if (runs.some(run => !terminal(run.status))) return fault(409, 'CONVERSATION_BUSY');
        db.conversations = db.conversations.filter(conversation => conversation.id !== id); delete db.messages[id];
        for (const run of runs) delete db.runs[run.runId];
        for (const key of Object.keys(db.submissions)) if (key.startsWith(id + ':')) delete db.submissions[key];
        db.deletedConversations.push(id); save(); return new Response(null, { status: 204 });
      }
    }
    const conv = path.match(/^\/conversations\/([^/]+)\/(messages|changes|submissions\/[^/]+|memory-proposals)$/);
    if (conv) {
      const id = decodeURIComponent(conv[1]); if (!db.messages[id]) return fault(404, 'NOT_FOUND');
      Object.values(db.runs).filter(r => r.conversationId === id).forEach(advance);
      const items = db.messages[id];
      if (conv[2] === 'messages' && method === 'POST') {
        const key = id + ':' + input.clientMessageId, previous = db.submissions[key];
        if (previous) return JSON.stringify(previous.input) === JSON.stringify(input) ? json(previous.accepted, 202) : fault(409, 'IDEMPOTENCY_CONFLICT');
        const runId = 'demo-run-' + crypto.randomUUID(), messageId = 'demo-user-' + crypto.randomUUID(), replyId = 'demo-reply-' + crypto.randomUUID();
        const accepted = { conversationId: id, clientMessageId: input.clientMessageId, messageId, replyId, runId, acceptedAt: now() };
        const run = { runId, conversationId: id, origin: 'user', status: 'accepted', lastSequence: 0,
          reply: { id: replyId, conversationId: id, runId, role: 'assistant', content: '', status: 'partial', createdAt: now(), revision: ++db.revision },
          events: [], startedAt: Date.now(), chunk: 0, scenario,
          chunks: ['这是一条', '合成回复，', '用于检查像素聊天室。\n\n', '**流式文字**会逐步出现；', '只有运行终态才表示结束。\n\n', '```js\n', 'const mode = "synthetic";\n', '```\n\n', '没有调用真实模型。'] };
        const user = { id: messageId, conversationId: id, runId, role: 'user', content: input.text, status: 'complete', createdAt: accepted.acceptedAt, revision: ++db.revision };
        items.push(user, copy(run.reply)); db.runs[runId] = run; db.submissions[key] = { input: copy(input), accepted };
        emit(run, 'run.accepted', { origin: 'user', submission: accepted }); save();
        if (scenario === 'lost') { run.scenario = 'normal'; save(); throw new TypeError('合成验证：提交响应丢失'); }
        return json(accepted, 202);
      }
      if (conv[2] === 'messages') {
        const end = parsed.searchParams.has('cursor') ? Number(parsed.searchParams.get('cursor')) : items.length;
        const start = Math.max(0, end - Number(parsed.searchParams.get('limit') || 50));
        return json({ items: copy(items.slice(start, end)), nextCursor: start ? String(start) : null, revision: db.revision });
      }
      if (conv[2] === 'changes') return json({ items: copy(items.filter(m => m.revision > Number(parsed.searchParams.get('afterRevision'))).sort((a, b) => a.revision - b.revision)), throughRevision: db.revision, hasMore: false });
      if (conv[2].startsWith('submissions/')) { const value = db.submissions[id + ':' + decodeURIComponent(conv[2].slice(12))]; return value ? json({ submission: value.accepted, run: snapshot(db.runs[value.accepted.runId]) }) : fault(404, 'NOT_FOUND'); }
      if (conv[2] === 'memory-proposals') {
        if (method === 'POST') {
          let item = db.proposals.find(p => p.requestId === input.clientRequestId);
          if (item && item.content !== input.content) return fault(409, 'MEMORY_REVIEW_CONFLICT');
          if (!item) { item = { id: crypto.randomUUID(), characterId: 'synthetic-character', revision: 1, content: input.content, contentSha256: await hash(input.content), status: 'pending', source: 'user', createdAt: now(), updatedAt: now(), decidedAt: null, memoryKey: null }; db.proposals.push({ ...item, requestId: input.clientRequestId }); save(); }
          const { requestId, ...publicItem } = item; return json(publicItem);
        }
        const start = parsed.searchParams.has('cursor') ? db.proposals.findIndex(p => p.id === parsed.searchParams.get('cursor')) + 1 : 0;
        const page = db.proposals.slice(start, start + 20).map(({ requestId, ...item }) => item);
        return json({ items: copy(page), nextCursor: start + 20 < db.proposals.length ? page.at(-1).id : null });
      }
    }
    const match = path.match(/^\/runs\/([^/]+)(?:\/(events|cancel))?$/);
    if (match) {
      const run = db.runs[decodeURIComponent(match[1])];
      if (!run) return fault(404, 'NOT_FOUND');
      advance(run);
      if (match[2] === 'cancel') {
        if (!terminal(run.status)) {
          if (run.scenario === 'race') { run.startedAt = Date.now() - 10000; advance(run); }
          else run.cancelRequested = true;
          save();
        }
        return json({ accepted: true, run: snapshot(run) }, 202);
      }
      if (match[2] !== 'events') return json(snapshot(run));
      let cursor = Number(options.headers?.['Last-Event-ID'] || 0), timer, closed = false;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const close = () => { if (closed) return; closed = true; clearInterval(timer); options.signal?.removeEventListener('abort', close); controller.close(); };
          const tick = () => {
            if (closed) return;
            advance(run);
            for (const event of run.events.filter(e => e.sequence > cursor)) { controller.enqueue(encoder.encode(`event: ${event.type}\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)); cursor = event.sequence; }
            if (run.scenario === 'disconnect' && run.chunk >= 2) { run.scenario = 'normal'; save(); close(); }
            if (terminal(run.status)) close();
          };
          timer = setInterval(tick, 150); options.signal?.addEventListener('abort', close, { once: true }); tick();
        }, cancel() { closed = true; clearInterval(timer); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    const proposal = path.match(/^\/memory-proposals\/([^/]+)(?:\/(confirm|reject))?$/);
    if (proposal) {
      const item = db.proposals.find(p => p.id === decodeURIComponent(proposal[1])); if (!item) return fault(404, 'NOT_FOUND');
      if (method !== 'GET') {
        const decision = proposal[2] === 'confirm' ? 'confirmed' : 'rejected';
        if (item.status === decision && proposal[2]) { const { requestId, ...publicItem } = item; return json(publicItem); }
        if (item.status !== 'pending' || input.revision !== item.revision || input.contentSha256 !== item.contentSha256) return fault(409, 'MEMORY_REVIEW_CONFLICT');
        if (method === 'PATCH') { item.content = input.content; item.contentSha256 = await hash(item.content); }
        else { item.status = decision; item.decidedAt = now(); item.memoryKey = decision === 'confirmed' ? 'memory/confirmed-' + item.id + '.md' : null; }
        item.revision++; item.updatedAt = now(); save();
      }
      const { requestId, ...publicItem } = item; return json(publicItem);
    }
    return fault(404, 'NOT_FOUND');
  }
  save();
  return { request, setScenario(value) { scenario = value; }, save };
}
