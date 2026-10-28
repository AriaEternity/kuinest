import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, task, enqueue, inspect, mutate, isCode, publishTask } from "./stage08-fixtures.js";
test("T04：任务默认禁用；启用需正确版本，同期重复tick与重开库均只入队一次",async t=>{
  const f=fixture(t), spec=task(f,{enabled:false}), port=f.storage.schedulerAccess();
  assert.equal(port.tick(f.clock.now(),f.ids),0);
  assert.throws(()=>port.setEnabled("owner-a",spec.id,2,true),isCode("TASK_REVISION_CONFLICT"));
  assert.throws(()=>port.setEnabled("other",spec.id,1,true),isCode("NOT_FOUND"));
  port.setEnabled("owner-a",spec.id,1,true); const id=enqueue(f);
  assert.equal(port.tick(f.clock.now(),f.ids),0); await f.reopen();
  assert.equal(f.storage.schedulerAccess().tick(f.clock.now(),f.ids),0);
  inspect(f.root,db=>{
    assert.equal((db.prepare("SELECT count(*) AS n FROM task_occurrences").get() as {n:number}).n,1);
    const run=db.prepare("SELECT origin,user_message_id AS user,request_key AS key FROM runs WHERE id=?").get(id) as {origin:string;user:null;key:string};
    assert.equal(run.origin,"heartbeat"); assert.equal(run.user,null); assert.equal(run.key,"task:"+spec.id+":"+spec.input.nextDueAt);
  });
});
test("T05：错过十个周期仅最新一期入队，旧周期合并范围；下一期严格晚于now",t=>{
  const f=fixture(t), now=f.clock.now(), spec=task(f,{dueAt:now-10*60000-25000}); enqueue(f);
  inspect(f.root,db=>{
    const rows=db.prepare("SELECT due_at AS due,range_start_at AS start,status FROM task_occurrences ORDER BY due_at").all() as {due:number;start:number|null;status:string}[];
    assert.deepEqual(rows,[{due:now-85000,start:spec.input.nextDueAt,status:"skipped_catchup"},{due:now-25000,start:null,status:"enqueued"}]);
    assert.equal((db.prepare("SELECT next_due_at AS due FROM scheduled_tasks").get() as {due:number}).due,now+35000);
  });
});
test("T06：待处理用户或同会话主动任务存在时跳过，不生成额外投影",t=>{
  const f=fixture(t); task(f); f.submit("用户优先");
  assert.equal(f.storage.schedulerAccess().tick(f.clock.now(),f.ids),0);
  inspect(f.root,db=>assert.equal((db.prepare("SELECT status FROM task_occurrences").get() as {status:string}).status,"skipped_busy"));
  const other=fixture(t); const version=publishTask(other); task(other,{versionId:version}); task(other,{versionId:version});
  assert.equal(other.storage.schedulerAccess().tick(other.clock.now(),other.ids),1);
  inspect(other.root,db=>assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as {n:number}).n,1));
});
test("T06：全局队列饱和时其他空会话任务也跳过",t=>{
  const f=fixture(t);
  for(let i=0;i<4;i++){
    const c="busy-"+i; f.storage.write("owner-a",r=>r.createConversation(c,"character-a","合成",f.clock.now()));
    for(let j=0;j<4;j++) f.storage.runAccess().submit("owner-a",c,{clientMessageId:f.ids.next(),text:"合成",allowWebSearch:false,imageIds:[],inputJson:'{"text":"合成","allowWebSearch":false}',inputHash:"synthetic"},f.clock.now(),f.ids,f.config.limits);
  }
  task(f); assert.equal(f.storage.schedulerAccess().tick(f.clock.now(),f.ids),0);
  inspect(f.root,db=>assert.equal((db.prepare("SELECT status FROM task_occurrences").get() as {status:string}).status,"skipped_busy"));
});
test("T04：推进任务时故障，occurrence、run、序号和消息全部回滚",t=>{
  const f=fixture(t); task(f);
  mutate(f,db=>db.exec("CREATE TRIGGER synthetic_tick_fault BEFORE UPDATE OF next_due_at ON scheduled_tasks BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END"));
  assert.throws(()=>f.storage.schedulerAccess().tick(f.clock.now(),f.ids));
  inspect(f.root,db=>{
    for(const table of ["runs","messages","task_occurrences"]) assert.equal((db.prepare("SELECT count(*) AS n FROM "+table).get() as {n:number}).n,0);
    assert.equal((db.prepare("SELECT next_public_seq AS seq FROM conversations").get() as {seq:number}).seq,1);
  });
});
test("T04：过期租约禁止调度；修订任务重新禁用且拒绝任意脚本与无效时区",t=>{
  const f=fixture(t), spec=task(f), port=f.storage.schedulerAccess();
  assert.throws(()=>port.update("owner-a",spec.id,2,{...spec.input,intervalSeconds:59}),isCode("TASK_INVALID"));
  assert.throws(()=>port.update("owner-a",spec.id,2,{...spec.input,timezone:"not/a/timezone"}),isCode("TASK_INVALID"));
  assert.throws(()=>port.update("owner-a",spec.id,2,{...spec.input,definition:{...spec.input.definition,command:"shell"} as typeof spec.input.definition}),isCode("TASK_INVALID"));
  assert.deepEqual(port.update("owner-a",spec.id,2,spec.input),{id:spec.id,revision:3,enabled:false});
  port.setEnabled("owner-a",spec.id,3,true); f.clock.value+=31000;
  assert.throws(()=>port.tick(f.clock.now(),f.ids)); inspect(f.root,db=>assert.equal((db.prepare("SELECT count(*) AS n FROM runs").get() as {n:number}).n,0));
});
