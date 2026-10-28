import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import { allSchemas } from "@kuinest/contracts";
import { fixture, inspect, isCode } from "./run-fixtures.js";
import { submission } from "../dist/conversations/submit.js";
import type { Claim } from "../dist/conversations/types.js";

test("R01/R02：并发同ID只保存一组事实，原文和联网开关参与严格幂等", async t => {
  const f = fixture(t), client = randomUUID(), text = " 合成原文\n🌻 ";
  const results = await Promise.all(Array.from({ length: 20 }, async () => f.submit(text, client)));
  results.forEach(value => assert.deepEqual(value, results[0]));
  assert.throws(() => f.submit(text.trim(), client), isCode("IDEMPOTENCY_CONFLICT"));
  assert.throws(() => f.submit(text, client, "conversation-a", true), isCode("IDEMPOTENCY_CONFLICT"));
  const same = f.store.submit("owner-a", "conversation-a", submission({ text, clientMessageId: client }), f.clock.now(), f.ids, f.config.limits); assert.deepEqual(same, results[0]);
  inspect(f.root, db => {
    assert.equal((db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 2);
    assert.equal((db.prepare("SELECT content FROM messages WHERE role='user'").get() as { content: string }).content, text);
    const event = db.prepare("SELECT payload_json FROM run_events").get() as { payload_json: string };
    assert.deepEqual(JSON.parse(event.payload_json).submission, results[0]);
  });
});
test("R03：提交事件写入故障让消息、运行、seq和revision一起回滚", t => {
  const f = fixture(t);
  inspect(f.root, db => db.exec("CREATE TRIGGER synthetic_submission_fault BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT,'synthetic-fault'); END"));
  assert.throws(() => f.submit(), /synthetic-fault/);
  inspect(f.root, db => {
    for (const table of ["messages", "runs", "run_events"]) assert.equal((db.prepare("SELECT count(*) AS n FROM " + table).get() as { n: number }).n, 0);
    assert.deepEqual(db.prepare("SELECT next_public_seq,change_revision FROM conversations").get(), { next_public_seq: 1, change_revision: 0 });
    db.exec("DROP TRIGGER synthetic_submission_fault");
  });
  assert.ok(f.submit());
});
test("R07：每会话4/全局16限制，只拒绝新提交；满队列仍能对账", t => {
  const f = fixture(t), first = f.submit();
  for (let i = 1; i < 4; i++) f.submit();
  assert.throws(() => f.submit(), isCode("QUEUE_FULL"));
  assert.deepEqual(f.submit("合成输入", first.clientMessageId), first);
  for (let c = 1; c <= 3; c++) { const id = "conversation-" + c; f.conversation(id); for (let i = 0; i < 4; i++) f.submit("合成", randomUUID(), id); }
  f.conversation("extra"); assert.throws(() => f.submit("新请求", randomUUID(), "extra"), isCode("QUEUE_FULL"));
  assert.deepEqual(f.submit("合成输入", first.clientMessageId), first);
  f.store.cancel("owner-a", first.runId, f.clock.now(), f.ids); assert.ok(f.submit("容量释放"));
});
test("R04：同毫秒UUID逆序仍按用户seq领取，A不见B且B见A的最终回复", t => {
  const f = fixture(t);
  const names = ["u-a", "reply-a", "z-run", "u-b", "reply-b", "a-run"];
  f.ids.next = () => names.shift() ?? randomUUID();
  const a = f.submit("输入A"), b = f.submit("输入B");
  const first = f.store.claim(f.clock.now(), f.ids)!; assert.equal(first.id, a.runId);
  assert.equal(f.store.claim(f.clock.now(), f.ids), undefined);
  const requestA = f.store.context(first); assert.deepEqual(requestA.messages.map(m => m.content), ["输入A"]); assert.ok(Object.isFrozen(requestA.messages));
  f.store.append(first, "回复A", f.clock.now()); f.store.finish(first, "completed", undefined, f.clock.now(), f.ids);
  const second = f.store.claim(f.clock.now(), f.ids)!; assert.equal(second.id, b.runId);
  assert.deepEqual(f.store.context(second).messages.map(m => m.content), ["输入A", "回复A", "输入B"]);
  assert.deepEqual(requestA.messages.map(m => m.content), ["输入A"]);
});
test("R09：追加用户和置running之间失败时全部回滚，重试只追加一次", t => {
  const f = fixture(t), run = f.submit();
  inspect(f.root, db => db.exec("CREATE TRIGGER synthetic_claim_fault BEFORE UPDATE OF status ON runs WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'synthetic-claim'); END"));
  assert.throws(() => f.store.claim(f.clock.now(), f.ids), /synthetic-claim/);
  inspect(f.root, db => {
    assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM branches").get() as { n: number }).n, 0);
    assert.deepEqual(db.prepare("SELECT status,context_user_entry_id FROM runs").get(), { status: "accepted", context_user_entry_id: null });
    db.exec("DROP TRIGGER synthetic_claim_fault");
  });
  assert.equal(f.store.claim(f.clock.now(), f.ids)!.id, run.runId);
  inspect(f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries").get() as { n: number }).n, 1));
});
test("R05/R08：取消先提交阻止delta/completed；完成先提交则取消保留原终态", t => {
  const f = fixture(t), cancelled = f.submit(), claim = f.store.claim(f.clock.now(), f.ids)!;
  f.store.append(claim, "已保存部分", f.clock.now()); f.store.cancel("owner-a", claim.id, f.clock.now(), f.ids);
  assert.equal(f.store.append(claim, "禁止追加", f.clock.now()), false);
  f.store.finish(claim, "completed", undefined, f.clock.now(), f.ids);
  assert.equal(f.store.finish(claim, "failed", "UPSTREAM_UNAVAILABLE", f.clock.now(), f.ids), false);
  const next = f.submit(), done = f.store.claim(f.clock.now(), f.ids)!; f.store.append(done, "完成回复", f.clock.now()); f.store.finish(done, "completed", undefined, f.clock.now(), f.ids);
  f.store.cancel("owner-a", done.id, f.clock.now(), f.ids);
  inspect(f.root, db => {
    assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(cancelled.runId) as { status: string }).status, "cancelled");
    assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(next.runId) as { status: string }).status, "completed");
    for (const id of [cancelled.runId, next.runId]) assert.equal((db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id=? AND type IN ('run.completed','run.failed','run.cancelled')").get(id) as { n: number }).n, 1);
    assert.deepEqual(db.prepare("SELECT content,status FROM messages WHERE id=?").get(cancelled.replyId), { content: "已保存部分", status: "partial" });
  });
});
test("R03/R05：投影或终态事件失败时文本、revision、上下文和状态一起回滚", t => {
  const f = fixture(t); f.submit(); const claim = f.store.claim(f.clock.now(), f.ids)!;
  inspect(f.root, db => db.exec("CREATE TRIGGER synthetic_delta_fault BEFORE INSERT ON run_events WHEN NEW.type='reply.delta' BEGIN SELECT RAISE(ABORT,'delta-fault'); END"));
  assert.throws(() => f.store.append(claim, "不应保存", f.clock.now()), /delta-fault/);
  inspect(f.root, db => { assert.equal((db.prepare("SELECT content FROM messages WHERE role='assistant'").get() as { content: string }).content, ""); db.exec("DROP TRIGGER synthetic_delta_fault"); });
  f.store.append(claim, "已保存", f.clock.now());
  inspect(f.root, db => db.exec("CREATE TRIGGER synthetic_terminal_fault BEFORE INSERT ON run_events WHEN NEW.type='run.completed' BEGIN SELECT RAISE(ABORT,'terminal-fault'); END"));
  assert.throws(() => f.store.finish(claim, "completed", undefined, f.clock.now(), f.ids), /terminal-fault/);
  inspect(f.root, db => {
    assert.equal((db.prepare("SELECT status FROM runs").get() as { status: string }).status, "running");
    assert.equal((db.prepare("SELECT status FROM messages WHERE role='assistant'").get() as { status: string }).status, "partial");
    assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries").get() as { n: number }).n, 1);
    db.exec("DROP TRIGGER synthetic_terminal_fault");
  });
  assert.equal(f.store.finish(claim, "completed", undefined, f.clock.now(), f.ids), true);
});
test("R06/R09：新实例恢复中断运行，保留用户和partial，accepted继续排队", async t => {
  const f = fixture(t), first = f.submit("执行输入"), pending = f.submit("排队输入"), current = f.store.claim(f.clock.now(), f.ids)!;
  f.store.append(current, "中断前部分", f.clock.now());
  const old = f.store; await f.reopen();
  assert.throws(() => old.append(current, "旧结果", f.clock.now()));
  assert.equal(f.store.recover(f.clock.now(), f.ids), 1); assert.equal(f.store.recover(f.clock.now(), f.ids), 0);
  inspect(f.root, db => {
    assert.deepEqual(db.prepare("SELECT status,error_code FROM runs WHERE id=?").get(first.runId), { status: "failed", error_code: "RUN_INTERRUPTED" });
    assert.deepEqual(db.prepare("SELECT content,status FROM messages WHERE id=?").get(first.replyId), { content: "中断前部分", status: "partial" });
    assert.equal((db.prepare("SELECT head_entry_id FROM branches").get() as { head_entry_id: string }).head_entry_id, current.contextUserEntryId);
  });
  const second = f.store.claim(f.clock.now(), f.ids)!; assert.equal(second.id, pending.runId);
  assert.deepEqual(f.store.context(second).messages.map(m => m.content), ["执行输入", "排队输入"]);
});
test("R06：取消标志跨重启恢复为cancelled，旧实例失租不能写结果", async t => {
  const f = fixture(t); f.submit(); const claim = f.store.claim(f.clock.now(), f.ids)!; f.store.cancel("owner-a", claim.id, f.clock.now(), f.ids);
  const oldStorage = f.storage, old = f.store; f.clock.value += 30000;
  const { SqliteStorage } = await import("../dist/storage/storage.js");
  const next = new SqliteStorage({ dataRoot: f.root, clock: f.clock, instanceId: "successor" }); f.cleanup(() => next.close());
  assert.throws(() => old.finish(claim, "completed", undefined, f.clock.now(), f.ids), isCode("LEASE_LOST"));
  next.runAccess().recover(f.clock.now(), f.ids);
  inspect(f.root, db => assert.equal((db.prepare("SELECT status FROM runs").get() as { status: string }).status, "cancelled"));
  await oldStorage.close(); assert.equal((await next.getReadiness()).lease.held, true);
});
test("R09：损坏的用户上下文使恢复失败，不猜空头或推进任务", async t => {
  const f = fixture(t); f.submit(); f.store.claim(f.clock.now(), f.ids);
  inspect(f.root, db => db.exec("UPDATE context_entries SET payload_json='{\"role\":\"assistant\",\"content\":\"synthetic-wrong-role\"}'"));
  await f.reopen(); assert.throws(() => f.store.recover(f.clock.now(), f.ids), isCode("SERVICE_NOT_READY"));
  inspect(f.root, db => assert.equal((db.prepare("SELECT status FROM runs").get() as { status: string }).status, "running"));
});
test("R04：7天闲置按输入接收时间切分上下文，历史仍保留", async t => {
  const f = fixture(t); f.submit("旧输入"); const first = f.store.claim(f.clock.now(), f.ids)!;
  f.store.append(first, "旧回复", f.clock.now()); f.store.finish(first, "completed", undefined, f.clock.now(), f.ids);
  await f.reopen(7 * 86400000); f.submit("新输入");
  const next = f.store.claim(f.clock.now(), f.ids)!; assert.deepEqual(f.store.context(next).messages.map(m => m.content), ["新输入"]);
  inspect(f.root, db => {
    assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 4);
    assert.equal((db.prepare("SELECT count(*) AS n FROM branches").get() as { n: number }).n, 2);
  });
});
test("R01/R05：持久事件符合公开schema，seq和revision持续递增", t => {
  const f = fixture(t); f.submit(); const claim: Claim = f.store.claim(f.clock.now(), f.ids)!;
  f.store.append(claim, "合成", f.clock.now()); f.store.finish(claim, "completed", undefined, f.clock.now(), f.ids);
  const ajv = new Ajv({ strict: true }); allSchemas.forEach(schema => ajv.addSchema(schema)); const validate = ajv.getSchema("urn:kuinest:0.3:runEvent")!;
  inspect(f.root, db => {
    const events = db.prepare("SELECT seq,payload_json FROM run_events ORDER BY seq").all() as { seq: number; payload_json: string }[];
    assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4]); events.forEach(e => assert.ok(validate(JSON.parse(e.payload_json)), JSON.stringify(validate.errors)));
    assert.equal((db.prepare("SELECT change_revision FROM conversations").get() as { change_revision: number }).change_revision, 4);
  });
});
