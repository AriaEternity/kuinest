import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import { allSchemas } from "@kuinest/contracts";
import { harness, controlled, until, inspect } from "./run-fixtures.js";

test("R01/R02：20次实际HTTP并发提交同一ID返回同一202回执和一次生成", async t => {
  const gate = controlled(), h = harness(t, gate.provider), headers = await h.headers();
  const payload = { clientMessageId: randomUUID(), text: " 并发合成 🌻 " };
  const results = await Promise.all(Array.from({ length: 20 }, () => h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload })));
  results.forEach(result => { assert.equal(result.statusCode, 202, result.body); assert.deepEqual(result.json(), results[0]!.json()); });
  await until(() => gate.calls.length === 1);
  const conflict = await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload: { ...payload, text: "不同正文" } });
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
  const flag = await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload: { ...payload, allowWebSearch: true } });
  assert.equal(flag.statusCode, 409);
  const lookup = await h.app.inject({ url: "/api/v1/conversations/conversation-a/submissions/" + payload.clientMessageId, headers });
  assert.deepEqual(lookup.json().submission, results[0]!.json());
  inspect(h.f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n, 1));
});
test("R05/R07：HTTP队列限制、查询对账、排队取消及重复终态取消", async t => {
  const gate = controlled(), h = harness(t, gate.provider), headers = await h.headers();
  const data = Array.from({ length: 4 }, () => ({ clientMessageId: randomUUID(), text: "合成" }));
  const runs = [];
  for (const payload of data) { const r = await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload }); assert.equal(r.statusCode, 202); runs.push(r.json()); }
  const full = await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload: { clientMessageId: randomUUID(), text: "超过容量" } });
  assert.equal(full.statusCode, 429); assert.equal(full.json().error.code, "QUEUE_FULL"); assert.equal(full.headers["retry-after"], "1");
  const duplicate = await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload: data[0]! }); assert.equal(duplicate.statusCode, 202);
  const url = "/api/v1/runs/" + runs[3].runId + "/cancel";
  const cancelled = await h.app.inject({ method: "POST", url, headers }); assert.equal(cancelled.statusCode, 202); assert.equal(cancelled.json().run.status, "cancelled");
  const repeated = await h.app.inject({ method: "POST", url, headers }); assert.deepEqual(repeated.json(), cancelled.json());
  const accepted = await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload: { clientMessageId: randomUUID(), text: "新容量" } }); assert.equal(accepted.statusCode, 202);
});
test("A03/A04/R01：接入写服务后仍拒绝无CSRF和跨owner，校验失败不入队", async t => {
  const h = harness(t), headers = await h.headers();
  h.f.storage.provisionOwner({ id: "owner-b", username: "synthetic-b", passwordHash: "synthetic", createdAt: h.f.clock.now() });
  h.f.storage.write("owner-b", repo => { repo.createCharacter("cb", "合成", h.f.clock.now()); repo.createConversation("conversation-b", "cb", "合成", h.f.clock.now()); });
  const payload = { clientMessageId: randomUUID(), text: "合成" };
  assert.equal((await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers: { cookie: headers.cookie, origin: headers.origin }, payload })).statusCode, 403);
  assert.equal((await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-b/messages", headers, payload })).statusCode, 404);
  assert.equal((await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload: { ...payload, role: "system" } })).statusCode, 400);
  inspect(h.f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n, 0));
});
test("阶段边界：meta只开放合成chat，联网新请求和SSE仍503且不假装完成", async t => {
  const h = harness(t), headers = await h.headers(), meta = await h.app.inject({ url: "/api/v1/meta", headers });
  assert.equal(meta.json().mode, "synthetic"); assert.equal(meta.json().capabilities.chat, true);
  for (const key of ["webSearch", "proactiveMessages", "resumableEvents"]) assert.equal(meta.json().capabilities[key], false);
  const unavailable = await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload: { clientMessageId: randomUUID(), text: "要求联网", allowWebSearch: true } });
  assert.equal(unavailable.statusCode, 503);
  inspect(h.f.root, db => assert.equal((db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n, 0));
  const reply = await h.app.inject({ method: "POST", url: "/api/v1/conversations/conversation-a/messages", headers, payload: { clientMessageId: randomUUID(), text: "合成" } });
  const id = reply.json().runId as string;
  const events = await h.app.inject({ url: "/api/v1/runs/" + id + "/events", headers }); assert.equal(events.statusCode, 503); assert.doesNotMatch(String(events.headers["content-type"]), /event-stream/);
  await until(() => h.api.queries.run("owner-a", id).status === "completed");
  const snapshot = await h.app.inject({ url: "/api/v1/runs/" + id, headers }), history = await h.app.inject({ url: "/api/v1/conversations/conversation-a/messages", headers }), changes = await h.app.inject({ url: "/api/v1/conversations/conversation-a/changes?afterRevision=2", headers });
  assert.equal(snapshot.json().reply.status, "complete"); assert.match(snapshot.json().reply.content, /合成演示/);
  assert.equal(history.json().items.length, 2); assert.equal(changes.json().items[0].id, snapshot.json().reply.id);
  const ajv = new Ajv({ strict: true }); allSchemas.forEach(s => ajv.addSchema(s));
  for (const [name, value] of [["acceptedSubmission", reply.json()], ["runSnapshot", snapshot.json()], ["historyPage", history.json()], ["messageChanges", changes.json()]] as const) assert.ok(ajv.getSchema("urn:kuinest:0.3:" + name)!(value));
});
