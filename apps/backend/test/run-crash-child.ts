import { SqliteStorage } from "../dist/storage/storage.js";
import { Worker } from "../dist/conversations/worker.js";
import { randomUUID } from "node:crypto";
// 仅由第四阶段测试启动；所有参数来自父测试新建的合成目录。
const [root, at, runId] = process.argv.slice(2);
if (!root || !at || !runId || !process.send) throw new Error("SYNTHETIC_TEST_ONLY");
const clock = { now: () => Number(at) }, store = new SqliteStorage({ dataRoot: root, clock, instanceId: randomUUID() });
const worker = new Worker(store.runAccess(), {
  async *stream(_request, signal) {
    yield { type: "text_delta", text: "纯合成中断证据".repeat(128) };
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  },
}, clock, { next: randomUUID });
worker.start(); store.startRenewal(() => {});
let sent = false;
setInterval(() => {
  if (sent) return;
  const result = store.apiAccess().run("owner-a", runId);
  if (result?.reply?.content) { sent = true; process.send!({ status: "persisted" }); }
}, 10);
