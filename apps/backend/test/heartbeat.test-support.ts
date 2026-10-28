import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, task, enqueue, harness, inspect, until, controlled, publishTask, mutate } from "./stage08-fixtures.js";
import type { ProviderAdapter } from "../dist/ports.js";
import { compile } from "../dist/context/compiler.js";
const wrapped=(c:ReturnType<typeof controlled>):ProviderAdapter=>({description:{provider:"mock",model:"synthetic",maxTokens:32768},stream:(r,s)=>c.provider.stream(r,s)});
const state=(f:ReturnType<typeof fixture>,id:string)=>inspect(f.root,db=>db.prepare("SELECT status FROM runs WHERE id=?").get(id) as {status:string}).status;
const branch=(f:ReturnType<typeof fixture>)=>inspect(f.root,db=>db.prepare("SELECT active_branch_id AS branch,last_context_user_at AS last FROM conversations WHERE id='conversation-a'").get());
const events=(f:ReturnType<typeof fixture>,id:string)=>inspect(f.root,db=>db.prepare("SELECT type,payload_json AS payload FROM run_events WHERE run_id=? ORDER BY seq").all(id)) as {type:string;payload:string}[];
async function draft(f:ReturnType<typeof fixture>,c:ReturnType<typeof controlled>,id:string,text:string){
  await until(()=>c.calls.length===1); c.calls[0]!.push({type:"reasoning_delta",text:"synthetic-private-reasoning"});
  c.calls[0]!.push({type:"text_delta",text});
  await until(()=>inspect(f.root,db=>JSON.stringify(db.prepare("SELECT response_json FROM provider_calls WHERE run_id=?").all(id))).includes(text));
}
function noLeak(f:ReturnType<typeof fixture>,id:string){
  inspect(f.root,db=>{
    const row=db.prepare("SELECT m.content,m.visibility FROM messages m JOIN runs r ON r.reply_message_id=m.id WHERE r.id=?").get(id) as {content:string;visibility:string};
    assert.equal(row.content,"");assert.equal(row.visibility,"suppressed");
    assert.equal((db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id=? AND type='reply.delta'").get(id) as {n:number}).n,0);
  });
}
test("T07/T09：精确静默标记完成但无公开消息，HTTP/SSE重放及changes均无候选和伪造用户",async t=>{
  const f=fixture(t);task(f);const id=enqueue(f),before=branch(f),c=controlled(),h=harness(t,f,wrapped(c));
  await draft(f,c,id,"  HEARTBEAT_OK  ");noLeak(f,id);
  assert.equal(c.calls[0]!.request.messages.length,0);assert.match(c.calls[0]!.request.system,/当前受控任务指令/);
  const during=JSON.stringify(h.api.queries.run("owner-a",id));assert.doesNotMatch(during,/HEARTBEAT_OK|partialReply|submission/);
  c.calls[0]!.push({type:"finish",reason:"stop"});c.calls[0]!.end();
  await until(()=>state(f,id)==="completed");noLeak(f,id);assert.deepEqual(branch(f),before);
  const header=await h.headers(),origin=await h.app.listen({host:"127.0.0.1",port:0});
  const replay=await (await fetch(origin+"/api/v1/runs/"+id+"/events",{headers:header})).text();
  const pub=replay+JSON.stringify(h.api.queries.history("owner-a","conversation-a",undefined,50))+JSON.stringify(h.api.queries.changes("owner-a","conversation-a",0))+h.logs();
  assert.doesNotMatch(pub,/HEARTBEAT_OK|synthetic-private|submission|clientMessageId|partialReply/);
  const accepted=JSON.parse(events(f,id)[0]!.payload);assert.equal(accepted.origin,"heartbeat");assert.equal(accepted.conversationId,"conversation-a");assert.equal(accepted.submission,undefined);
  assert.equal(JSON.parse(events(f,id).at(-1)!.payload).reply,undefined);
});
test("T07/T08：句内标记正常发送；较早占位的主动消息在新用户消息之后通过revision发现并完整接回",async t=>{
  const f=fixture(t);task(f);const id=enqueue(f),c=controlled(),h=harness(t,f,wrapped(c)),text="主动合成问候，句内 HEARTBEAT_OK 仍是可见正文。";
  await draft(f,c,id,text);noLeak(f,id);
  const user=h.runs.submit("owner-a","conversation-a",{clientMessageId:f.ids.next(),text:"主动运行期间的新用户输入"});
  const revision=inspect(f.root,db=>(db.prepare("SELECT change_revision AS n FROM conversations").get() as {n:number}).n);
  c.calls[0]!.push({type:"finish",reason:"stop"});c.calls[0]!.end();
  await until(()=>state(f,id)==="completed"&&c.calls.length===2);
  const changes=h.api.queries.changes("owner-a","conversation-a",revision);
  assert.match(JSON.stringify(changes),/主动合成问候/);assert.equal(h.api.queries.run("owner-a",id).reply!.content,text);
  assert.deepEqual(events(f,id).map(e=>e.type),["run.accepted","run.started","run.completed"]);
  const request=c.calls[1]!.request;assert.equal(request.messages.at(-1)!.content,"主动运行期间的新用户输入");
  assert.ok(request.messages.some(m=>m.role==="assistant"&&m.content===text));
  assert.equal(request.messages.filter(m=>m.role==="user").length,1);assert.equal(c.maximum(),1);
  inspect(f.root,db=>assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries WHERE kind='message' AND json_extract(payload_json,'$.role')='assistant'").get() as {n:number}).n,1));
  c.calls[1]!.push({type:"text_delta",text:"用户合成回复"});c.calls[1]!.push({type:"finish",reason:"stop"});c.calls[1]!.end();await until(()=>state(f,user.runId)==="completed");
});
for(const outcome of ["failed","cancelled","empty","timeout"] as const)test("T09："+outcome+"主动候选保持隐藏，终态无partialReply且原上下文不变",async t=>{
  const f=fixture(t);task(f);const id=enqueue(f),c=controlled(),before=branch(f),h=harness(t,f,wrapped(c),undefined,{timeoutMs:outcome==="timeout"?150:3000});
  await draft(f,c,id,outcome==="empty"?"   ":"hidden-candidate-"+outcome);
  if(outcome==="cancelled")h.runs.cancel("owner-a",id);
  else if(outcome!=="timeout"){if(outcome==="empty")c.calls[0]!.push({type:"finish",reason:"stop"});c.calls[0]!.end();}
  await until(()=>["failed","cancelled"].includes(state(f,id)));noLeak(f,id);assert.deepEqual(branch(f),before);
  const publicData=JSON.stringify(h.api.queries.run("owner-a",id))+JSON.stringify(events(f,id))+h.logs();
  assert.doesNotMatch(publicData,/hidden-candidate|synthetic-private|partialReply/);
  if(outcome==="empty")assert.equal(h.api.queries.run("owner-a",id).error!.code,"EMPTY_REPLY");
});
test("T09：accepted取消没有空消息；运行中重开恢复不重试模型且不发布私有草稿",async t=>{
  const f=fixture(t);task(f);const id=enqueue(f);
  f.store.cancel("owner-a",id,f.clock.now(),f.ids);noLeak(f,id);assert.equal(state(f,id),"cancelled");
  const g=fixture(t);task(g);const interrupted=enqueue(g),claim=g.store.claim(g.clock.now(),g.ids)!;
  const protocol=g.storage.protocolAccess(),call=protocol.begin(claim,g.ids.next(),{system:"合成",messages:[],tools:[],options:{}},g.clock.now());
  protocol.checkpoint(claim,call,{assistant:{role:"assistant",content:"hidden-crash-candidate"}},"started",g.clock.now());
  assert.equal(g.store.append(claim,"never-public",g.clock.now()),false);await g.reopen();assert.equal(g.store.recover(g.clock.now(),g.ids),1);
  assert.equal(state(g,interrupted),"failed");noLeak(g,interrupted);assert.doesNotMatch(JSON.stringify(events(g,interrupted)),/hidden-crash|never-public|partialReply/);
  assert.equal(g.store.recover(g.clock.now(),g.ids),0);
});
test("T04/T09：任务入队固定文档版本/revision，后续改任务或角色不能改变此次system",t=>{
  const f=fixture(t),v1=publishTask(f,{},"synthetic-original-task"),spec=task(f,{versionId:v1}),id=enqueue(f);
  const v2=publishTask(f,{},"synthetic-later-task");
  f.storage.schedulerAccess().update("owner-a",spec.id,2,{...spec.input,definition:{...spec.input.definition,documentVersionId:v2}});
  const claim=f.store.claim(f.clock.now(),f.ids)!,pinned=f.storage.contextAccess().load(claim),request=compile(pinned,[]).request;
  assert.equal(claim.id,id);assert.equal(claim.contextUserEntryId,null);assert.equal(pinned.versionId,v1);assert.equal(pinned.task!.revision,2);
  assert.match(request.system,/synthetic-original-task/);assert.doesNotMatch(request.system,/synthetic-later-task/);
  assert.equal(pinned.entries.filter(e=>e.kind==="message").length,0);
});
test("T09：可见提交时若公开事件写失败，消息、分支、revision与运行终态一并回滚",async t=>{
  const f=fixture(t);task(f);const id=enqueue(f),claim=f.store.claim(f.clock.now(),f.ids)!,ctx=f.storage.contextAccess(),p=ctx.load(claim),compiled=compile(p,[]);
  ctx.save(claim,compiled.manifest,f.clock.now());
  const protocol=f.storage.protocolAccess(),call=protocol.begin(claim,f.ids.next(),compiled.request,f.clock.now());
  protocol.checkpoint(claim,call,{assistant:{role:"assistant",content:"合成可见候选"},finish_reason:"stop"},"completed",f.clock.now());
  mutate(f,db=>db.exec("CREATE TRIGGER fail_heartbeat_event BEFORE INSERT ON run_events WHEN NEW.type='run.completed' BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END"));
  assert.throws(()=>f.store.finish(claim,"completed",undefined,f.clock.now(),f.ids,"合成可见候选"));
  noLeak(f,id);assert.equal(state(f,id),"running");assert.deepEqual(branch(f),{branch:null,last:null});
  inspect(f.root,db=>assert.equal((db.prepare("SELECT change_revision AS n FROM conversations").get() as {n:number}).n,1));
});
