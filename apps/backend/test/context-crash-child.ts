import { randomUUID } from "node:crypto";
import { SqliteStorage } from "../dist/storage/storage.js";
import { compile } from "../dist/context/compiler.js";
import { splitForCompaction } from "../dist/context/branches.js";
const [root, mode] = process.argv.slice(2);
if (!root || !["memory", "compaction"].includes(mode ?? "")) throw new Error("测试参数不正确");
const clock = { now: () => Date.now() }, ids = { next: () => randomUUID() };
const storage = new SqliteStorage({ dataRoot: root, instanceId: ids.next(), clock });
const store = storage.runAccess({ context: true }), claim = store.claim(clock.now(), ids)!;
const protocol = storage.protocolAccess(), request = { system: "纯合成", messages: [{ role: "user", content: "纯合成" }], tools: [], options: {} };
if (mode === "memory") {
  const call = protocol.begin(claim, ids.next(), request, clock.now());
  const args = { key: "MEMORY.md", expectedVersion: null, content: "崩溃前已提交的合成记忆" };
  const tool = { id: "memory-crash", type: "function" as const, function: { name: "memory_write", arguments: JSON.stringify(args) } };
  protocol.checkpoint(claim, call, { assistant: { role: "assistant", content: "", reasoning_content: "合成", tool_calls: [tool] }, finish_reason: "tool_calls" }, "completed", clock.now());
  const started = protocol.beginTool(claim, call, ids.next(), tool, clock.now());
  storage.memoryAccess().write("owner-a", { ...args, characterId: "character-a", provenance: { source: "tool", reference: claim.id }, sourceToolCallId: started.id, claim }, "crash-memory-version", clock.now());
} else {
  const input = storage.contextAccess().load(claim), prepared = compile(input, []), split = splitForCompaction(prepared.branch.selected);
  const call = protocol.begin(claim, ids.next(), request, clock.now(), "compaction");
  const result = { text: "崩溃前已保存的合成摘要", sourceIds: split.before.map(e => e.id) };
  protocol.checkpoint(claim, call, { assistant: { role: "assistant", content: JSON.stringify(result) }, finish_reason: "stop" }, "completed", clock.now());
  storage.contextAccess().save(claim, {}, clock.now(), { id: "crash-compaction", callId: call.id, payload: { summary: result.text, sourceIds: result.sourceIds, firstKeptEntryId: split.firstKeptEntryId, providerCallId: call.id, tokensBefore: 100 } });
}
process.send?.({ state: "persisted" });
setInterval(() => {}, 1000);
