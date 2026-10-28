import test from 'node:test';
import assert from 'node:assert/strict';
import { Typewriter } from '../js/chat/typewriter.js';

test('字素逐步展开时不拆开家庭 emoji 与组合字符', () => {
  const writer = new Typewriter();
  writer.setText('葵👨‍👩‍👧‍👦e\u0301！', { animate: true, now: 0 });
  writer.advance(28); assert.equal(writer.visible, '葵');
  writer.advance(56); assert.equal(writer.visible, '葵👨‍👩‍👧‍👦');
  writer.advance(84); assert.equal(writer.visible, '葵👨‍👩‍👧‍👦e\u0301');
  writer.advance(900); assert.equal(writer.visible, writer.target); assert.equal(writer.pending, false);
});
test('后续分块与重复更新不重打旧文字，恢复全文和修正立即对齐', () => {
  const writer = new Typewriter('已恢复的正文');
  assert.equal(writer.pending, false);
  writer.setText('已恢复的正文继续', { animate: true, now: 0 });
  writer.advance(28); assert.equal(writer.visible, '已恢复的正文继');
  writer.setText('已恢复的正文继续', { animate: true, now: 40 });
  writer.advance(56); assert.equal(writer.visible, '已恢复的正文继续');
  writer.setText('后端修正全文', { animate: true, now: 70 }); assert.equal(writer.visible, '后端修正全文');
  writer.setText('后端修正全文与恢复内容', { animate: false }); assert.equal(writer.visible, writer.target);
});
test('大段积压在最后一次接收后 900ms 内追齐，停止展示可立即展开全部', () => {
  const writer = new Typewriter();
  writer.setText('像素'.repeat(2500), { animate: true, now: 100 });
  writer.advance(150); assert.ok(writer.visible.length > 0 && writer.visible.length < writer.target.length);
  writer.advance(1000); assert.equal(writer.visible, writer.target); assert.equal(writer.pending, false);
  writer.setText(writer.target + '取消前已收到的内容', { animate: true, now: 1100 });
  writer.flush(); assert.equal(writer.visible, writer.target); assert.equal(writer.pending, false);
});
