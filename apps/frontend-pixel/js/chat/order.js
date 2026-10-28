// 不按 revision 排序。版本用于更新，历史数组顺序来自服务端。
// 快照先到时，仅在同一运行内部修正用户/回复的先后，不移动无关历史。
export function orderedMessages(messages) {
  const items = [...messages];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.role !== 'assistant' || !item.runId) continue;
    const userIndex = items.findIndex(m => m.runId === item.runId && m.role === 'user');
    if (userIndex > i) items.splice(i, 0, items.splice(userIndex, 1)[0]);
  }
  return items;
}
export const isRunTerminal = run => !!run && ['completed', 'failed', 'cancelled'].includes(run.status);
export function reconcileRun(previous, incoming) {
  if (previous && (incoming.lastSequence < previous.lastSequence || isRunTerminal(previous) && !isRunTerminal(incoming))) return previous;
  return incoming;
}
