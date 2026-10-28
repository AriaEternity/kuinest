import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { projectRoot } from "../dist/server.js";
import { fixture,publishTask,task,enqueue,inspect,until } from "./stage08-fixtures.js";
for(const mode of ["draft","append"])test("T09：真实子进程在"+mode+"提交后强制中断，恢复不发送、不重试副作用",async t=>{
  const f=fixture(t),versionId=publishTask(f,{memoryReadKeys:["memory/diary.md"],memoryWriteKeys:["memory/diary.md"],memoryAppendKeys:["memory/diary.md"]});
  task(f,{versionId,allowMemoryWrite:true});const id=enqueue(f);await f.storage.close();
  const child=fork(join(projectRoot,"apps/backend/dist-test/stage08-crash-child.js"),[f.root,mode],{execPath:process.execPath,stdio:["ignore","ignore","pipe","ipc"]});
  let ready=false,error="";child.on("message",()=>{ready=true;});child.stderr?.on("data",d=>{error+=d.toString();});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
  await until(()=>{assert.equal(error,"");return ready;},5000);
  const closed=once(child,"exit");child.kill();await closed;await f.reopen(60000);
  assert.equal(f.store.recover(f.clock.now(),f.ids),1);assert.equal(f.store.recover(f.clock.now(),f.ids),0);
  inspect(f.root,db=>{
    assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(id) as {status:string}).status,"failed");
    assert.equal((db.prepare("SELECT active_branch_id AS id FROM conversations").get() as {id:null}).id,null);
    assert.deepEqual(db.prepare("SELECT content,visibility FROM messages").get(),{content:"",visibility:"suppressed"});
    assert.doesNotMatch(JSON.stringify(db.prepare("SELECT payload_json FROM run_events").all()),/synthetic-crash|partialReply/);
    assert.equal((db.prepare("SELECT count(*) AS n FROM provider_calls").get() as {n:number}).n,1);
    if(mode==="append"){
      assert.equal((db.prepare("SELECT status FROM tool_calls").get() as {status:string}).status,"unknown");
      assert.equal((db.prepare("SELECT count(*) AS n FROM memory_versions").get() as {n:number}).n,1);
    }
  });
});
