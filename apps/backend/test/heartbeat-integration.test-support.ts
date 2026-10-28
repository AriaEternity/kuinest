import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixture, publishTask, task, enqueue, harness, until, inspect } from "./stage08-fixtures.js";
import type { ProviderAdapter, ProviderRequest } from "../dist/ports.js";
import { BraveSearch } from "../dist/tools/search.js";
import { Scheduler } from "../dist/scheduler/tick.js";
test("T01/T09：主动任务经真实协议循环写日记再静默；写入只一次且私有工具组不公开",async t=>{
  const f=fixture(t),versionId=publishTask(f,{memoryReadKeys:["memory/diary.md"],memoryWriteKeys:["memory/diary.md"],memoryAppendKeys:["memory/diary.md"]});
  task(f,{versionId,allowMemoryWrite:true});const id=enqueue(f),requests:ProviderRequest[]=[];
  const provider:ProviderAdapter={description:{provider:"mock",model:"synthetic",maxTokens:32768},async *stream(request){
    requests.push(request);yield {type:"reasoning_delta",text:"synthetic-private-tool-reasoning"};
    if(requests.length===1){
      assert.ok(request.tools.some(d=>(d.function as {name:string}).name==="memory_append"));
      yield {type:"tool_call_delta",index:0,id:"write-diary",name:"memory_append",arguments:JSON.stringify({key:"memory/diary.md",expectedVersion:null,content:"synthetic-private-diary"})};
      yield {type:"finish",reason:"tool_calls"};
    } else {
      const result=request.messages.at(-1)!;assert.equal(result.role,"tool");assert.equal(JSON.parse(result.content as string).ok,true);
      yield {type:"text_delta",text:"NO_REPLY"};yield {type:"finish",reason:"stop"};
    }
  }};
  const h=harness(t,f,provider);await until(()=>h.api.queries.run("owner-a",id).status==="completed");
  assert.equal(requests.length,2);assert.equal(requests[0]!.system,requests[1]!.system);
  assert.equal(f.storage.memoryAccess().read("owner-a","character-a","memory/diary.md")!.content,"synthetic-private-diary");
  inspect(f.root,db=>{
    assert.equal((db.prepare("SELECT count(*) AS n FROM memory_versions").get() as {n:number}).n,1);
    assert.equal((db.prepare("SELECT status FROM tool_calls").get() as {status:string}).status,"completed");
    assert.equal((db.prepare("SELECT active_branch_id AS id FROM conversations").get() as {id:string|null}).id,null);
    assert.doesNotMatch(JSON.stringify(db.prepare("SELECT payload_json FROM run_events").all()),/synthetic-private|NO_REPLY/);
  });
});
test("T03：实际HTTP提交双重联网选项与meta一致，协议搜索结果仍是私有引用",async t=>{
  const f=fixture(t);let searchCount=0,round=0;
  const provider:ProviderAdapter={description:{provider:"mock",model:"synthetic",maxTokens:32768},async *stream(request){
    round++;yield {type:"reasoning_delta",text:"合成"};
    if(round===1){
      assert.ok(request.tools.some(d=>(d.function as {name:string}).name==="web_search"));
      yield {type:"tool_call_delta",index:0,id:"search",name:"web_search",arguments:'{"query":"纯合成查询"}'};yield {type:"finish",reason:"tool_calls"};
    }else{yield {type:"text_delta",text:"合成搜索后的回复"};yield {type:"finish",reason:"stop"};}
  }};
  const h=harness(t,f,provider,{async search(query){assert.equal(query,"纯合成查询");searchCount++;return {untrusted:true,results:[{description:"synthetic-private-search-result"}]};}}),headers=await h.headers();
  const meta=await h.app.inject({url:"/api/v1/meta",headers});assert.equal(meta.json().capabilities.webSearch,true);assert.equal(meta.json().capabilities.proactiveMessages,true);
  const receipt=await h.app.inject({method:"POST",url:"/api/v1/conversations/conversation-a/messages",headers,payload:{clientMessageId:f.ids.next(),text:"合成提问",allowWebSearch:true}});
  assert.equal(receipt.statusCode,202);const id=receipt.json().runId as string;
  await until(()=>h.api.queries.run("owner-a",id).status==="completed");assert.equal(searchCount,1);
  assert.doesNotMatch(JSON.stringify(h.api.queries.history("owner-a","conversation-a",undefined,50))+h.logs(),/synthetic-private/);
  const g=fixture(t),disabled=harness(t,g,provider),head=await disabled.headers();
  assert.equal((await disabled.app.inject({url:"/api/v1/meta",headers:head})).json().capabilities.webSearch,false);
  const denied=await disabled.app.inject({method:"POST",url:"/api/v1/conversations/conversation-a/messages",headers:head,payload:{clientMessageId:g.ids.next(),text:"合成",allowWebSearch:true}});assert.equal(denied.statusCode,503);
});
test("T03：实际回环检索取消会终止等待，不吞取消或继续发请求",async t=>{
  let count=0;const server=createServer((_req,_res)=>{count++;});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const search=new BraveSearch({mode:"synthetic",enabled:true,endpoint:"http://127.0.0.1:"+address.port+"/res/v1/web/search"},()=>{throw new Error();});
  const abort=new AbortController(),pending=search.search("合成",abort.signal);const rejected=assert.rejects(pending);
  await until(()=>count===1);abort.abort(new Error("synthetic-abort"));await rejected;assert.equal(count,1);
});
test("T04：调度器失败停止并通知一次；关闭后不再读取存储或唤醒worker",t=>{
  let scans=0,wakes=0,faults=0;const scheduler=new Scheduler({tick(){scans++;if(scans===2)throw new Error("synthetic");return 1;}},{now:()=>0},{next:()=>""},()=>wakes++,()=>faults++);
  t.after(()=>scheduler.close());scheduler.start();assert.equal(scheduler.ready,true);assert.equal(wakes,1);
  scheduler.tick();assert.equal(scheduler.ready,false);scheduler.tick();scheduler.close();
  assert.equal(scans,2);assert.equal(faults,1);assert.equal(wakes,1);
});

test("T03：真实检索未确认存储授权时零凭据读取；异步凭据挂起也响应取消",async()=>{
  let reads=0,requests=0;
  const off=new BraveSearch({mode:"private",enabled:true,allowExternalQuery:true},()=>{reads++;return "unused";});
  await assert.rejects(()=>off.search("synthetic",new AbortController().signal));assert.equal(reads,0);
  const search=new BraveSearch({mode:"private",enabled:true,allowExternalQuery:true,storageRightsConfirmed:true},()=>{reads++;return new Promise<string>(()=>{});},async()=>{requests++;throw new Error("不允许真实外联");});
  const abort=new AbortController(),pending=search.search("synthetic",abort.signal),rejected=assert.rejects(pending);
  await until(()=>reads===1);abort.abort();await rejected;assert.equal(requests,0);
});
