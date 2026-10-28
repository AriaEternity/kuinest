import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../dist/context/compiler.js";
import { defaults } from "../dist/context/profile.js";
import { fixture, doc, mutate, inspect, isCode } from "./context-fixtures.js";

test("C01：领取事务固定角色/profile/记忆，切换版本和后续排队不改变本轮", t => {
  const f = fixture(t), a = f.submit("本轮固定输入"), claim = f.store.claim(f.clock.now(), f.ids)!;
  const first = f.storage.contextAccess().load(claim);
  const memory = f.storage.memoryAccess().write("owner-a", { characterId: "character-a", key: "MEMORY.md", expectedVersion: null, content: "后来才有的记忆", provenance: { source: "synthetic", reference: "test" } }, f.ids.next(), f.clock.now());
  const newer = f.publish("后来的角色版本");
  f.submit("未来排队输入");
  const current = compile(f.storage.contextAccess().load(claim), []);
  assert.equal(first.versionId, "version-a"); assert.equal(current.profile.id, "profile-a");
  assert.doesNotMatch(JSON.stringify(current.request), /后来才有|后来的角色|未来排队/);
  assert.equal(current.request.messages.filter(m => m.content === "本轮固定输入").length, 1);
  f.store.finish(claim, "failed", "RUN_INTERRUPTED", f.clock.now(), f.ids);
  const next = f.store.claim(f.clock.now(), f.ids)!;
  const nextPinned = f.storage.contextAccess().load(next); assert.equal(nextPinned.versionId, newer); assert.equal(nextPinned.memories[0]!.id, memory.id);
  inspect(f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM context_snapshots WHERE run_id=?").get(a.runId) as { n: number }).n, 1));
});

test("C01：快照登记失败使领取、用户节点与running整体回滚", t => {
  const f = fixture(t), run = f.submit();
  mutate(f, db => db.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON context_snapshots BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END"));
  assert.throws(() => f.store.claim(f.clock.now(), f.ids));
  inspect(f.root, db => {
    assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(run.runId) as { status: string }).status, "accepted");
    assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries").get() as { n: number }).n, 0);
  });
  mutate(f, db => db.exec("DROP TRIGGER fail_snapshot"));
  assert.ok(f.store.claim(f.clock.now(), f.ids));
});

test("C01/C03：固定版本的资料哈希变化、跨owner与非法逻辑名均拒绝", t => {
  const f = fixture(t); f.submit(); const claim = f.store.claim(f.clock.now(), f.ids)!;
  assert.throws(() => f.storage.contextAccess().load({ ...claim, ownerId: "owner-b" }), isCode("NOT_FOUND"));
  mutate(f, db => db.prepare("UPDATE character_documents SET content=? WHERE version_id='version-a' AND logical_name='SOUL.md'").run(Buffer.from("被改动")));
  assert.throws(() => compile(f.storage.contextAccess().load(claim), []), isCode("PROFILE_INVALID"));
  assert.throws(() => f.storage.characterAccess().publish("owner-a", { characterId: "character-a", versionId: f.ids.next(), profile: { id: f.ids.next(), provider: "mock", model: "synthetic", endpoint: null, options: {}, status: "synthetic" }, config: defaults, documents: [doc("../SOUL.md", "非法")] }, f.clock.now()), isCode("PROFILE_INVALID"));
});

test("C01/C06：长期MEMORY版本覆盖静态种子且不重复注入，本轮仍固定旧版本", t => {
  const f = fixture(t), p = { id: f.ids.next(), provider: "mock" as const, model: "synthetic", endpoint: null, options: {}, status: "synthetic" }, version = f.ids.next();
  f.storage.characterAccess().publish("owner-a", { characterId: "character-a", versionId: version, profile: p, config: defaults, documents: [doc("MEMORY.md", "过期种子")] }, f.clock.now());
  f.storage.characterAccess().activate("owner-a", "character-a", version);
  const m = f.storage.memoryAccess().write("owner-a", { characterId: "character-a", key: "MEMORY.md", expectedVersion: null, content: "当前蓝色约定", provenance: { source: "synthetic", reference: "test" } }, f.ids.next(), f.clock.now());
  f.submit("蓝色"); const claim = f.store.claim(f.clock.now(), f.ids)!;
  f.storage.memoryAccess().write("owner-a", { characterId: "character-a", key: "MEMORY.md", expectedVersion: m.id, content: "以后红色约定", provenance: { source: "synthetic", reference: "next" } }, f.ids.next(), f.clock.now());
  const output = compile(f.storage.contextAccess().load(claim), []);
  assert.equal(output.request.system.split("当前蓝色约定").length - 1, 1);
  assert.doesNotMatch(output.request.system, /过期种子|以后红色/);
  assert.equal(output.manifest.selectedMemories.length, 0);
});

test("C06：两个同expectedVersion写入只有一次成功，旧版本和来源保留，角色核心不可写", async t => {
  const f = fixture(t), input = { characterId: "character-a", key: "MEMORY.md", expectedVersion: null, content: "合成原始记忆", provenance: { source: "synthetic" as const, reference: "test-cas" } };
  const initial = f.storage.memoryAccess().write("owner-a", input, f.ids.next(), f.clock.now());
  const results = await Promise.allSettled(["一", "二"].map(content => Promise.resolve().then(() => f.storage.memoryAccess().write("owner-a", { ...input, expectedVersion: initial.id, content }, f.ids.next(), f.clock.now()))));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code, "MEMORY_VERSION_CONFLICT");
  inspect(f.root, db => { assert.equal((db.prepare("SELECT count(*) AS n FROM memory_versions").get() as { n: number }).n, 2); assert.equal((db.prepare("SELECT content FROM memory_versions WHERE id=?").get(initial.id) as { content: string }).content, input.content); });
  assert.throws(() => f.storage.memoryAccess().write("owner-a", { ...input, key: "SOUL.md" }, f.ids.next(), f.clock.now()), isCode("MEMORY_WRITE_INVALID"));
  assert.throws(() => f.storage.memoryAccess().read("owner-b", "character-a", "MEMORY.md"), isCode("NOT_FOUND"));
});

test("C06/C08：同owner不同角色的记忆不混入，超过搜索源预算显式失败", t => {
  const f = fixture(t);
  f.storage.write("owner-a", repo => repo.createCharacter("character-b", "另一个合成角色", f.clock.now()));
  const p = { id: f.ids.next(), provider: "mock" as const, model: "synthetic", endpoint: null, options: {}, status: "synthetic" }, v = f.ids.next();
  f.storage.characterAccess().publish("owner-a", { characterId: "character-b", versionId: v, profile: p, config: defaults, documents: [] }, f.clock.now());
  f.storage.characterAccess().activate("owner-a", "character-b", v);
  f.storage.memoryAccess().write("owner-a", { characterId: "character-b", key: "MEMORY.md", expectedVersion: null, content: "隔离标记蓝色", provenance: { source: "synthetic", reference: "b" } }, f.ids.next(), f.clock.now());
  assert.deepEqual(f.storage.memoryAccess().search("owner-a", "character-a", "蓝色"), []);
  mutate(f, db => { for (let i = 0; i < 201; i++) {
    const key = "memory/" + i + ".md", id = "many-" + i;
    db.prepare("INSERT INTO memory_versions(id,character_id,logical_key,version,content,provenance_json,created_at) VALUES(?,'character-a',?,1,'合成','{}',1)").run(id, key);
    db.prepare("INSERT INTO memory_heads VALUES('character-a',?,?)").run(key, id);
  } });
  assert.throws(() => f.storage.memoryAccess().search("owner-a", "character-a", "合成"), isCode("MEMORY_INDEX_REQUIRED"));
  f.submit(); const claim = f.store.claim(f.clock.now(), f.ids)!;
  assert.throws(() => f.storage.contextAccess().load(claim), isCode("MEMORY_INDEX_REQUIRED"));
});

test("C07：工具记忆写入重放返回原版本，参数变化或取消不得形成新写入", t => {
  const f = fixture(t); f.submit(); const claim = f.store.claim(f.clock.now(), f.ids)!, protocol = f.storage.protocolAccess();
  const request = { system: "合成", messages: [{ role: "user", content: "合成" }], tools: [], options: {} };
  const call = protocol.begin(claim, f.ids.next(), request, f.clock.now());
  const content = "合成工具写入", args = { key: "MEMORY.md", expectedVersion: null, content };
  const tool = { id: "memory-call", type: "function" as const, function: { name: "memory_write", arguments: JSON.stringify(args) } };
  protocol.checkpoint(claim, call, { assistant: { role: "assistant", content: "", reasoning_content: "合成", tool_calls: [tool] }, finish_reason: "tool_calls" }, "completed", f.clock.now());
  const started = protocol.beginTool(claim, call, f.ids.next(), tool, f.clock.now());
  const input = { ...args, characterId: "character-a", provenance: { source: "tool" as const, reference: claim.id }, sourceToolCallId: started.id, claim };
  const first = f.storage.memoryAccess().write("owner-a", input, f.ids.next(), f.clock.now());
  assert.equal(f.storage.memoryAccess().write("owner-a", input, f.ids.next(), f.clock.now()).id, first.id);
  assert.throws(() => f.storage.memoryAccess().write("owner-a", { ...input, content: "不同" }, f.ids.next(), f.clock.now()), isCode("MEMORY_TOOL_INVALID"));
  f.store.cancel("owner-a", claim.id, f.clock.now(), f.ids);
  assert.equal(f.storage.memoryAccess().write("owner-a", input, f.ids.next(), f.clock.now()).id, first.id);
  assert.throws(() => f.storage.memoryAccess().write("owner-a", { ...input, sourceToolCallId: "other" }, f.ids.next(), f.clock.now()), isCode("SERVICE_NOT_READY"));
  inspect(f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM memory_versions").get() as { n: number }).n, 1));
});

test("C05：7天只按被执行用户输入重置，其他活动不续期，原链与公开历史保留", async t => {
  const f = fixture(t); f.submit("旧输入"); const first = f.store.claim(f.clock.now(), f.ids)!;
  f.store.append(first, "旧回复", f.clock.now()); f.store.finish(first, "completed", undefined, f.clock.now(), f.ids);
  const saved = inspect(f.root, db => db.prepare("SELECT active_branch_id AS branch,last_context_user_at AS last FROM conversations WHERE id='conversation-a'").get()) as { branch: string; last: number };
  f.clock.value += 7 * 86400000;
  // 模拟心跳等非用户活动只更新展示时间；不声称08调度器已实现。
  mutate(f, db => db.prepare("UPDATE conversations SET updated_at=? WHERE id='conversation-a'").run(f.clock.now()));
  await f.reopen(); f.submit("新输入"); const next = f.store.claim(f.clock.now(), f.ids)!;
  const pinned = f.storage.contextAccess().load(next);
  assert.notEqual(pinned.branchId, saved.branch);
  assert.deepEqual(compile(pinned, []).request.messages.map(m => m.content), ["新输入"]);
  inspect(f.root, db => {
    assert.equal((db.prepare("SELECT count(*) AS n FROM branches WHERE conversation_id='conversation-a'").get() as { n: number }).n, 2);
    assert.equal((db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id='conversation-a'").get() as { n: number }).n, 4);
    assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries WHERE branch_id=?").get(saved.branch) as { n: number }).n, 2);
  });
});

test("C06：记忆指针提交失败时，新版本与指针一起回滚", t => {
  const f = fixture(t), input = { characterId: "character-a", key: "MEMORY.md", expectedVersion: null, content: "合成初始", provenance: { source: "synthetic" as const, reference: "rollback" } };
  const first = f.storage.memoryAccess().write("owner-a", input, f.ids.next(), f.clock.now());
  mutate(f, db => db.exec("CREATE TRIGGER fail_memory_head BEFORE UPDATE ON memory_heads BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END"));
  assert.throws(() => f.storage.memoryAccess().write("owner-a", { ...input, expectedVersion: first.id, content: "未提交" }, f.ids.next(), f.clock.now()));
  assert.equal(f.storage.memoryAccess().read("owner-a", "character-a", "MEMORY.md")!.id, first.id);
  inspect(f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM memory_versions").get() as { n: number }).n, 1));
});

test("C04：全run最多一次压缩加8次回复，第二次压缩或第10次上游请求拒绝", t => {
  const f = fixture(t); f.submit(); const claim = f.store.claim(f.clock.now(), f.ids)!, store = f.storage.protocolAccess();
  const request = { system: "合成", messages: [{ role: "user", content: "合成" }], tools: [], options: {} };
  const c = store.begin(claim, f.ids.next(), request, f.clock.now(), "compaction");
  store.checkpoint(claim, c, { assistant: { role: "assistant", content: "合成摘要" }, finish_reason: "stop" }, "completed", f.clock.now());
  assert.throws(() => store.begin(claim, f.ids.next(), request, f.clock.now(), "compaction"), isCode("TOOL_LIMIT"));
  for (let i = 0; i < 8; i++) {
    const call = store.begin(claim, f.ids.next(), request, f.clock.now());
    store.checkpoint(claim, call, { assistant: { role: "assistant", content: "合成" }, finish_reason: "stop" }, "completed", f.clock.now());
  }
  assert.throws(() => store.begin(claim, f.ids.next(), request, f.clock.now()), isCode("TOOL_LIMIT"));
  inspect(f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM provider_calls").get() as { n: number }).n, 9));
});
