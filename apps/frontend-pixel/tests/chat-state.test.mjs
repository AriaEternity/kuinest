// 只覆盖此次接入最容易造成的顺序与竞态问题；不引入测试框架。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { orderedMessages, reconcileRun } from '../js/chat/order.js';
const { ConversationState, ChatClient } = await import(pathToFileURL(resolve(process.env.KUINEST_ROOT || fileURLToPath(new URL('../../../', import.meta.url)), 'packages/chat-client/dist/index.js')));
const message = (id, role, runId, revision, content = id) => ({ id, conversationId: 'demo-test', role, runId, revision, content, status: 'partial', createdAt: '2026-10-12T00:00:00.000Z' });

test('旧消息升级到高 revision 后仍在新消息之前', () => {
  const state = new ConversationState('demo-test');
  state.history({ items: [message('old', 'assistant', 'old-run', 1), message('new', 'user', 'new-run', 2)], nextCursor: null, revision: 2 });
  state.changes({ items: [message('old', 'assistant', 'old-run', 20, '完整旧正文')], throughRevision: 20, hasMore: false });
  assert.deepEqual(orderedMessages(state.items).map(m => m.id), ['old', 'new']);
});
test('快照先到时，用户消息在同一运行的回复之前且不重复', () => {
  const state = new ConversationState('demo-test'); state.history({ items: [message('history', 'user', 'history-run', 1)], nextCursor: null, revision: 1 });
  state.upsert(message('reply', 'assistant', 'run', 8));
  state.changes({ items: [message('user', 'user', 'run', 2), message('reply', 'assistant', 'run', 9)], throughRevision: 9, hasMore: false });
  state.upsert(message('reply', 'assistant', 'run', 8, '旧正文'));
  assert.deepEqual(orderedMessages(state.items).map(m => m.id), ['history', 'user', 'reply']);
  assert.equal(state.items.filter(m => m.id === 'reply').length, 1);
});
test('取消接收快照晚于完成到达时，不把完成降回运行中', () => {
  const complete = { runId: 'run', status: 'completed', lastSequence: 10 };
  assert.equal(reconcileRun(complete, { runId: 'run', status: 'running', lastSequence: 9 }), complete);
  assert.equal(reconcileRun(complete, { runId: 'run', status: 'accepted', lastSequence: 10 }), complete);
});
test('读取旧历史页不推进 changes 基线', () => {
  const state = new ConversationState('demo-test'); state.history({ items: [message('new', 'user', 'new-run', 4)], nextCursor: 'older', revision: 5 });
  state.history({ items: [message('old', 'user', 'old-run', 1)], nextCursor: null, revision: 30 });
  assert.equal(state.revision, 5); assert.deepEqual(state.items.map(m => m.id), ['old', 'new']);
});
test('SSE EOF 后用快照全文恢复，只有服务端终态才结束', async () => {
  let snapshots = 0, streams = 0;
  const base = { runId: 'run', conversationId: 'demo-test', origin: 'user' };
  const initial = { ...base, status: 'running', lastSequence: 2, reply: message('reply', 'assistant', 'run', 3, '半条') };
  const completed = { ...base, status: 'completed', lastSequence: 5, reply: { ...message('reply', 'assistant', 'run', 9, '恢复后的完整正文'), status: 'complete' } };
  const client = new ChatClient('/api/v1', async url => {
    if (String(url).endsWith('/events')) { streams++; return new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }); }
    snapshots++; return new Response(JSON.stringify(completed), { headers: { 'Content-Type': 'application/json' } });
  });
  const values = []; for await (const run of client.watch('run', { signal: new AbortController().signal, initial })) values.push(run);
  assert.deepEqual(values.map(r => r.status), ['running', 'completed']); assert.equal(values.at(-1).reply.content, '恢复后的完整正文'); assert.equal(streams, 1); assert.equal(snapshots, 1);
});
