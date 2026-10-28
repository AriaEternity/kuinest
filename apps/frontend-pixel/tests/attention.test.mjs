// 只验证提醒可能误报、漏报或清理错误的状态路径，不重复检查界面元素。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatAttention } from '../js/desktop/chat-attention.js';
const run = (status, sequence, extra = {}) => ({ runId: 'r', conversationId: 'c', status, lastSequence: sequence, reply: { content: '合成正文' }, ...extra });
const observe = (tracker, runs, extra = {}) => tracker.observe({ scope: 'demo:owner:1', authenticated: true, runs, ...extra });
test('历史终态、无终态的断流与静默完成都不提醒', () => {
  const tracker = new ChatAttention();
  assert.deepEqual(observe(tracker, [run('completed', 5)]), []);
  assert.deepEqual(observe(tracker, [run('running', 2, { runId: 'live' })]), []);
  assert.deepEqual(observe(tracker, [run('running', 2, { runId: 'live' })]), []);
  assert.deepEqual(observe(tracker, [run('completed', 3, { runId: 'live', reply: null, origin: 'heartbeat' })]), []);
});
test('快速完成以接受回执为依据，重复终态与取消竞态只提醒一次', () => {
  const tracker = new ChatAttention();
  const receipt = { runId: 'r', conversationId: 'c' };
  assert.equal(observe(tracker, [run('completed', 5)], { receipts: [receipt] }).length, 1);
  assert.equal(observe(tracker, [run('completed', 5)]).length, 1);
  assert.equal(observe(tracker, [run('cancelled', 4)]).length, 1);
  assert.deepEqual(observe(tracker, [run('completed', 5)], { reading: 'c' }), []);
  assert.deepEqual(observe(tracker, [run('completed', 5)]), []);
});
test('失败如实提醒，阅读一个会话不清掉另一个，主动取消不作回复提醒', () => {
  const tracker = new ChatAttention();
  observe(tracker, [run('running', 1), run('running', 1, { runId: 'other', conversationId: 'other-c' })]);
  const notes = observe(tracker, [run('failed', 2, { reply: null }), run('completed', 2, { runId: 'other', conversationId: 'other-c' })]);
  assert.equal(notes.length, 2); assert.equal(notes[0].failed, true);
  assert.equal(observe(tracker, [], { reading: 'c' })[0].conversationId, 'other-c');
  observe(tracker, [run('running', 1, { runId: 'cancel' })]);
  assert.equal(observe(tracker, [run('cancelled', 2, { runId: 'cancel' })]).length, 1);
});
test('关闭提醒不积压旧通知，账号或模式变化清除标记', () => {
  const tracker = new ChatAttention();
  observe(tracker, [run('running', 1)]);
  assert.deepEqual(observe(tracker, [run('completed', 2)], { enabled: false }), []);
  assert.deepEqual(observe(tracker, [run('completed', 2)]), []);
  observe(tracker, [run('running', 1, { runId: 'new' })]);
  assert.equal(observe(tracker, [run('failed', 2, { runId: 'new' })]).length, 1);
  assert.deepEqual(observe(tracker, [], { scope: 'http:owner:2' }), []);
  observe(tracker, [run('running', 1)]);
  observe(tracker, [run('completed', 2)]);
  assert.deepEqual(observe(tracker, [], { authenticated: false }), []);
});
