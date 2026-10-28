import { test } from "node:test";
import assert from "node:assert/strict";
import { config, defaults, documents, memoryKey, profile } from "../dist/context/profile.js";
import { resolve, splitForCompaction } from "../dist/context/branches.js";
import { measure } from "../dist/context/budget.js";
import { search } from "../dist/memory/search.js";
import type { Entry, MemoryVersion } from "../dist/context/types.js";
import { doc, isCode } from "./context-fixtures.js";
const entry = (id: string, parentId: string | null, kind: string, payload: unknown): Entry => ({ id, parentId, branchId: "b", kind, payload });
const user = (id: string, parent: string | null, content = id) => entry(id, parent, "message", { role: "user", content });
const model = { id: "p", provider: "mock" as const, model: "synthetic", endpoint: null, options: { maxTokens: 100 }, status: "synthetic" };

test("C01/C04：逻辑资料名称、UTF8与配置关闭未知字段，原始字节及顺序可核查", () => {
  for (const name of ["../SOUL.md", "D:/SOUL.md", "/SOUL.md", "SOUL.md\0", "soul.md"]) assert.throws(() => documents([doc(name, "合成")], defaults), isCode("PROFILE_INVALID"));
  assert.throws(() => config({ unexpected: true }), isCode("PROFILE_INVALID"));
  assert.throws(() => documents([{ ...doc("SOUL.md", "合成"), bytes: Buffer.from([255]) }], defaults), isCode("PROFILE_INVALID"));
  assert.throws(() => documents([doc("SOUL.md", "一"), doc("SOUL.md", "二")], defaults), isCode("PROFILE_INVALID"));
  assert.deepEqual(documents([doc("SOUL.md", "二"), doc("IDENTITY.md", "一")], defaults).map(d => d.name), ["IDENTITY.md", "SOUL.md"]);
  assert.equal(memoryKey("SOUL.md"), false); assert.equal(memoryKey("memory/2026-09-11.md"), true); assert.equal(memoryKey("memory/../SOUL.md"), false);
});

test("C04/C08：固定旧实现string.length字符探针与emoji安全截断，截断差异明确保留", () => {
  // 对照v2026.7.1-2 bootstrap的UTF16计数；不冒充其trimEnd/头尾策略输出一致。
  for (const [text, count] of [["中文", 2], ["🙂", 2], ["中🙂文", 4], ["e\u0301", 2]] as const) assert.equal(documents([doc("SOUL.md", text)], defaults)[0]!.originalUnits, count);
  const original = doc("SOUL.md", "中🙂文");
  const small = documents([original], { ...defaults, fileChars: 2, totalChars: 2 })[0]!;
  assert.equal(small.text, "中"); assert.equal(small.truncated, true); assert.equal(Buffer.from(original.bytes).toString(), "中🙂文");
  const all = documents([doc("IDENTITY.md", "1234"), doc("SOUL.md", "5678")], { ...defaults, fileChars: 4, totalChars: 6 });
  assert.deepEqual(all.map(d => d.text), ["1234", "56"]);
  assert.equal(documents([doc("SOUL.md", "x".repeat(80001))], defaults)[0]!.selectedUnits, 80000);
});

test("C02：按父链选活动分支，内部custom不变话语，custom_message按规则进入", () => {
  const entries = [user("a", null), user("other", "a", "旁支禁止进入"), entry("state", "a", "custom", { secret: "状态标记" }), entry("hidden", "state", "custom_message", { text: "隐藏", includeInContext: false }), entry("note", "hidden", "branch_summary", { text: "合成旁支概述" }), user("last", "note")];
  const result = resolve(entries, "last");
  assert.deepEqual(result.selected.map(e => e.id), ["a", "note", "last"]);
  assert.doesNotMatch(JSON.stringify(result.selected), /旁支禁止进入|状态标记|隐藏/);
});

test("C02/C03：最后有效压缩只用指定保留点；旁支、未来保留点与环拒绝", () => {
  const c = entry("c", "b", "compaction", { summary: "合成摘要", sourceIds: ["a"], firstKeptEntryId: "b" });
  const entries = [user("a", null), user("b", "a"), c, user("d", "c")];
  const result = resolve(entries, "d"); assert.deepEqual(result.selected.map(e => e.id), ["b", "d"]); assert.equal(result.summary!.text, "合成摘要");
  for (const keep of ["none", "c", "d"]) assert.throws(() => resolve([...entries.filter(e => e.id !== "c"), { ...c, payload: { summary: "合成", sourceIds: ["a"], firstKeptEntryId: keep } }], "d"), isCode("CONTEXT_INVALID"));
  assert.throws(() => resolve([user("a", "b"), user("b", "a")], "a"), isCode("CONTEXT_INVALID"));
  assert.throws(() => resolve([entry("unknown", null, "unknown", { original: "保留" }), user("a", "unknown")], "a"), isCode("CONTEXT_UNVERIFIED"));
});

test("C04：压缩保留8个完整回合及当前输入，工具调用/结果不能被拆开", () => {
  const entries: Entry[] = []; let parent: string | null = null;
  for (let i = 0; i < 11; i++) {
    entries.push(user("u" + i, parent)); parent = "u" + i;
    if (i === 10) continue;
    entries.push(entry("a" + i, parent, "message", { role: "assistant", content: "", reasoning_content: "合成", tool_calls: [{ id: "t" + i, type: "function", function: { name: "synthetic_echo", arguments: "{}" } }] })); parent = "a" + i;
    entries.push(entry("r" + i, parent, "message", { role: "tool", tool_call_id: "t" + i, content: "{}" })); parent = "r" + i;
    entries.push(entry("f" + i, parent, "message", { role: "assistant", content: "完整合成答复", reasoning_content: "合成" })); parent = "f" + i;
  }
  const split = splitForCompaction(resolve(entries, "u10").selected);
  assert.equal(split.firstKeptEntryId, "u2"); assert.equal(split.tail.filter(e => e.userTurn).length, 9);
  assert.equal(split.before.at(-1)!.id, "f1");
  let last = "u10";
  for (let i = 0; i < 8; i++) { entries.push(user("failed" + i, last)); last = "failed" + i; }
  assert.equal(splitForCompaction(resolve(entries, last).selected).firstKeptEntryId, "u2");
  assert.throws(() => splitForCompaction(resolve([user("current", null)], "current").selected), isCode("CONTEXT_TOO_LARGE"));
});

test("C04/C08：字节估算标为未验证；边界包含输出与安全预留，错误tokenizer拒绝", () => {
  const request = { system: "中🙂", messages: [{ role: "user", content: "合成" }], tools: [], options: {} };
  const value = measure(request, defaults, model);
  assert.equal(value.verified, false); assert.equal(value.input, Buffer.byteLength(JSON.stringify({ system: request.system, messages: request.messages, tools: [] })) + 128 + 1024);
  assert.equal(measure(request, { ...defaults, windowTokens: value.input + 101, reserveTokens: 1 }, model).fits, true);
  assert.equal(measure(request, { ...defaults, windowTokens: value.input + 100, reserveTokens: 1 }, model).fits, false);
  assert.throws(() => measure(request, defaults, model, { id: "wrong", model: "other", verified: true, count: () => 1 }), isCode("PROFILE_INVALID"));
  for (const status of ["verified", "accepted_difference"]) assert.throws(() => profile({ ...model, status }), isCode("PROFILE_INVALID"));
});

test("C08：词面检索按命中数与逻辑键稳定排序，结果有版本/位置且不越过预算", () => {
  const rows: MemoryVersion[] = ["memory/b.md", "memory/a.md", "memory/c.md"].map((key, i) => ({ id: "v" + i, characterId: "c", key, version: 1, parentId: null, content: "前缀🙂 蓝色 茶 " + "字".repeat(2000), provenance: {}, sourceToolCallId: null }));
  const hits = search(rows, "蓝色 茶", rows.map(r => r.key));
  assert.deepEqual(hits.map(h => h.key), ["memory/a.md", "memory/b.md", "memory/c.md"]);
  for (const h of hits) assert.equal(rows.find(r => r.id === h.versionId)!.content.slice(h.start, h.end), h.text);
  assert.ok(hits.reduce((n, h) => n + h.text.length, 0) <= 8000);
  assert.equal(search(rows, "无命中", rows.map(r => r.key)).length, 0);
  assert.equal(search(rows, "还记得蓝色吗？", rows.map(r => r.key))[0]!.key, "memory/a.md");
  assert.throws(() => search(Array.from({ length: 201 }, (_, i) => ({ ...rows[0]!, id: "" + i, key: "memory/" + i + ".md" })), "蓝色", []), isCode("MEMORY_INDEX_REQUIRED"));
  assert.throws(() => search([{ ...rows[0]!, content: "x".repeat(1024 * 1024 + 1) }], "x", []), isCode("MEMORY_INDEX_REQUIRED"));
});

test("C03：被替代的超长摘要保留原件，当前摘要限额不变", () => {
  const old = entry("old", "b", "compaction", { summary: "合".repeat(32769), sourceIds: ["a"], firstKeptEntryId: "b", tokensBefore: 900 });
  const fresh = entry("fresh", "d", "compaction", { summary: "合成当前摘要", sourceIds: ["a", "b", "old"], firstKeptEntryId: "d", tokensBefore: 800 });
  const entries = [user("a", null), user("b", "a"), old, user("d", "old"), fresh, user("last", "fresh")];
  const before = structuredClone(entries), result = resolve(entries, "last");
  assert.equal(result.summary!.text, "合成当前摘要");assert.equal(result.compactionId, "fresh");
  assert.deepEqual(result.selected.map(v => v.id), ["d", "last"]);assert.deepEqual(entries, before);
  assert.throws(() => resolve(entries, "d"), isCode("CONTEXT_INVALID"));
  for (const units of [32768, 32769]) {
    const changed = entries.map(e => e.id === "fresh" ? { ...fresh, payload: { ...(fresh.payload as object), summary: "文".repeat(units) } } : e);
    if (units === 32768) assert.equal(resolve(changed, "last").summary!.text.length, units);
    else assert.throws(() => resolve(changed, "last"), isCode("CONTEXT_INVALID"));
  }
});
test("C03：被替代的旧摘要仍检查内容形状、来源、保留点和计数", () => {
  const old = entry("old", "b", "compaction", { summary: "合".repeat(32769), sourceIds: ["a"], firstKeptEntryId: "b", tokensBefore: 900 });
  const fresh = entry("fresh", "d", "compaction", { summary: "合成新摘要", sourceIds: ["a"], firstKeptEntryId: "d" });
  const entries = [user("a", null), user("b", "a"), old, user("d", "old"), fresh];
  for (const change of [
    { summary: "" }, { summary: "\uD800" }, { summary: 123 }, { sourceIds: [] },
    { sourceIds: ["a", "a"] }, { sourceIds: ["d"] }, { sourceIds: ["outside"] },
    { firstKeptEntryId: "d" }, { tokensBefore: -1 }, { unknown: "合成未知字段" }
  ]) {
    const invalid = entries.map(e => e.id === "old" ? { ...old, payload: { ...(old.payload as object), ...change } } : e);
    assert.throws(() => resolve(invalid, "fresh"), isCode("CONTEXT_INVALID"));
  }
});

test("C01：中文记忆逻辑键按原名使用，控制符、路径和设备名仍拒绝",()=>{
  for(const name of ["合成日记.md","测试𠀀_2026-09.md","汉".repeat(80)+".md"]) {
    const key="memory/"+name;assert.equal(memoryKey(key),true);assert.ok(config({memoryReadKeys:[key],memoryWriteKeys:[key]}).memoryReadKeys.includes(key));
  }
  for(const key of ["memory/汉".repeat(81)+".md","memory/../资料.md","memory/资料/日记.md","memory/资料\\日记.md",
    "memory/.隐藏.md","memory/带 空格.md","memory/隐\u202e藏.md","memory/隐\u200b藏.md","memory/记忆／旁路.md",
    "memory/CON.md","memory/nul.md","memory/LPT9.md","memory/混合é.md","memory/无效\uD800.md"]) {
    assert.equal(memoryKey(key),false);assert.throws(()=>config({memoryReadKeys:[key]}),isCode("PROFILE_INVALID"));
  }
  assert.equal(memoryKey("memory/"+"汉".repeat(81)+".md"),false);
});
