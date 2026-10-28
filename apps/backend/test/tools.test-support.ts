import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixture, inspect, isCode, publishTask, task, enqueue } from "./stage08-fixtures.js";
import { restrictedTools } from "../dist/tools/registry.js";
import { BraveSearch } from "../dist/tools/search.js";
import { submission } from "../dist/conversations/submit.js";
import type { ToolCall } from "../dist/providers/types.js";
const call=(name:string,args:object,id="synthetic-tool"):ToolCall=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
function setup(f:ReturnType<typeof fixture>,search?:{readonly enabled?:boolean;search(query:string,signal:AbortSignal):Promise<unknown>},web=false) {
  const store=f.storage.runAccess({context:true,webSearch:web});
  store.submit("owner-a","conversation-a",submission({clientMessageId:f.ids.next(),text:"纯合成问题",allowWebSearch:web}),f.clock.now(),f.ids,f.config.limits);
  const claim=store.claim(f.clock.now(),f.ids)!, input=f.storage.contextAccess().load(claim);
  return {claim,input,store,tools:restrictedTools(claim,input,{control:store.control,memory:f.storage.memoryAccess(),clock:f.clock,ids:f.ids,...(search?{search}:{})})};
}
function startTool(f:ReturnType<typeof fixture>,h:ReturnType<typeof setup>,tool:ToolCall) {
  const p=f.storage.protocolAccess(), c=p.begin(h.claim,f.ids.next(),{system:"合成",messages:[],tools:h.tools.definitions,options:{}},f.clock.now());
  p.checkpoint(h.claim,c,{assistant:{role:"assistant",content:"",reasoning_content:"合成",tool_calls:[tool]},finish_reason:"tool_calls"},"completed",f.clock.now());
  return p.beginTool(h.claim,c,f.ids.next(),tool,f.clock.now()).id;
}
test("T01/T02：默认工具无写入/联网/shell，路径、跨角色与额外字段均不能读取",async t=>{
  const f=fixture(t),h=setup(f),signal=new AbortController().signal;
  assert.deepEqual(h.tools.definitions.map(d=>(d.function as {name:string}).name),["clock_now","memory_search","memory_get"]);
  for(const tool of [call("shell",{command:"echo secret"}),call("memory_get",{key:"../SOUL.md"}),call("memory_get",{key:"character-b/MEMORY.md"}),call("memory_get",{key:"MEMORY.md",characterId:"other"}),call("memory_append",{key:"MEMORY.md",expectedVersion:null,content:"注入"})]){
    const r=await h.tools.invoke(tool,signal); assert.equal(r.failed,true); assert.match(r.message.content,/TOOL_(DENIED|INPUT_INVALID)/);
  }
  const time=JSON.parse((await h.tools.invoke(call("clock_now",{}),signal)).message.content);
  assert.equal(time.result.utc,new Date(f.clock.now()).toISOString()); assert.equal(time.result.timezone,"UTC");
});
test("T01：记忆读取使用本角色最新头和固定权限，文本与编码后字节数均有界",async t=>{
  const f=fixture(t); f.publish("合成",{memoryReadKeys:["MEMORY.md","memory/diary.md"],memoryWriteKeys:["MEMORY.md","memory/diary.md"]});
  const h=setup(f),content="葵".repeat(10000);
  const written=f.storage.memoryAccess().write("owner-a",{characterId:"character-a",key:"MEMORY.md",expectedVersion:null,content,provenance:{source:"synthetic",reference:"bounded"}},f.ids.next(),f.clock.now());
  const r=await h.tools.invoke(call("memory_get",{key:"MEMORY.md"}),new AbortController().signal),value=JSON.parse(r.message.content).result;
  assert.equal(r.failed,false); assert.equal(value.versionId,written.id); assert.ok(value.content.length<=16000); assert.ok(Buffer.byteLength(r.message.content)<=32768);
  const results=await h.tools.invoke(call("memory_search",{query:"葵"}),new AbortController().signal);
  assert.equal(results.failed,false); assert.match(results.message.content,/MEMORY.md/);
});
test("T01：memory_append真实工具档案绑定，CAS冲突与重放不重复追加，取消后不写",async t=>{
  const f=fixture(t); f.publish("合成",{memoryReadKeys:["memory/diary.md"],memoryWriteKeys:["memory/diary.md"],memoryAppendKeys:["memory/diary.md"]});
  const h=setup(f),signal=new AbortController().signal,tool=call("memory_append",{key:"memory/diary.md",expectedVersion:null,content:"第一行\n"}),id=startTool(f,h,tool);
  const first=await h.tools.invoke(tool,signal,{toolCallId:id}),v1=JSON.parse(first.message.content).result.versionId;
  assert.equal(first.failed,false); assert.deepEqual(await h.tools.invoke(tool,signal,{toolCallId:id}),first);
  const second=call("memory_append",{key:"memory/diary.md",expectedVersion:v1,content:"第二行"}, "second"),id2=startTool(f,h,second);
  assert.equal((await h.tools.invoke(second,signal,{toolCallId:id2})).failed,false);
  const stale=call("memory_append",{key:"memory/diary.md",expectedVersion:v1,content:"第三行"},"stale"),id3=startTool(f,h,stale);
  assert.match((await h.tools.invoke(stale,signal,{toolCallId:id3})).message.content,/MEMORY_VERSION_CONFLICT/);
  h.store.cancel("owner-a",h.claim.id,f.clock.now(),f.ids);
  assert.equal((await h.tools.invoke(second,signal,{toolCallId:id2})).failed,true);
  inspect(f.root,db=>{
    assert.equal((db.prepare("SELECT count(*) AS n FROM memory_versions").get() as {n:number}).n,2);
    assert.equal((db.prepare("SELECT v.content FROM memory_versions v JOIN memory_heads h ON h.version_id=v.id").get() as {content:string}).content,"第一行\n第二行");
  });
});
test("T01/T02：替换默认关闭；明确启用只改允许记忆，伪造来源与人格键拒绝",async t=>{
  const f=fixture(t); f.publish("合成",{memoryReplaceEnabled:true});
  const h=setup(f),signal=new AbortController().signal;
  const good=call("memory_replace",{key:"MEMORY.md",expectedVersion:null,content:"合成替换"}),id=startTool(f,h,good);
  assert.equal((await h.tools.invoke(good,signal,{toolCallId:"forged"})).failed,true);
  assert.equal((await h.tools.invoke(good,signal,{toolCallId:id})).failed,false);
  for(const key of ["SOUL.md","IDENTITY.md","AGENTS.md","memory/not-allowed.md"]) assert.equal((await h.tools.invoke(call("memory_replace",{key,expectedVersion:null,content:"注入"}),signal,{toolCallId:id})).failed,true);
});
test("T01：主动任务即使角色允许写入，本任务禁止时不能暴露写工具",t=>{
  const f=fixture(t),versionId=publishTask(f,{memoryReplaceEnabled:true}); task(f,{versionId,allowMemoryWrite:false});enqueue(f);
  const claim=f.store.claim(f.clock.now(),f.ids)!,input=f.storage.contextAccess().load(claim);
  const tools=restrictedTools(claim,input,{control:f.store.control,memory:f.storage.memoryAccess(),clock:f.clock,ids:f.ids});
  assert.equal(tools.definitions.some(d=>JSON.stringify(d).includes("memory_replace")),false);
});
test("T03：服务端或本轮任一未授权均零检索请求，启用后每run至多三次",async t=>{
  let count=0; const search={async search(){count++;return {results:[]};}},signal=new AbortController().signal;
  const a=setup(fixture(t),search,false),b=setup(fixture(t),undefined,true);
  for(const h of [a,b]) assert.equal((await h.tools.invoke(call("web_search",{query:"合成"}),signal)).failed,true);
  assert.equal(count,0);
  const disabled=setup(fixture(t),{...search,enabled:false},true);
  assert.equal(disabled.tools.definitions.some(d=>(d.function as {name:string}).name==="web_search"),false);
  assert.equal((await disabled.tools.invoke(call("web_search",{query:"合成"}),signal)).failed,true);assert.equal(count,0);
  const c=setup(fixture(t),search,true);
  for(let i=0;i<3;i++) assert.equal((await c.tools.invoke(call("web_search",{query:"合成"}),signal)).failed,false);
  assert.match((await c.tools.invoke(call("web_search",{query:"合成"}),signal)).message.content,/TOOL_LIMIT/); assert.equal(count,3);
  assert.equal((await c.tools.invoke(call("web_search",{query:"x".repeat(501),url:"https://other"}),signal)).failed,true);
});
test("T03：已取消或失租的工具不调用搜索；错误消息不包含底层敏感异常",async t=>{
  const f=fixture(t); let count=0; const h=setup(f,{async search(){count++;throw new Error("synthetic-secret-path");}},true),signal=new AbortController().signal;
  const r=await h.tools.invoke(call("web_search",{query:"合成"}),signal);assert.doesNotMatch(r.message.content,/synthetic-secret/);
  h.store.cancel("owner-a",h.claim.id,f.clock.now(),f.ids);
  assert.equal((await h.tools.invoke(call("web_search",{query:"合成"}),signal)).failed,true);assert.equal(count,1);
  const g=fixture(t),other=setup(g,{async search(){count++;return {};}},true); g.clock.value+=31000;
  assert.equal((await other.tools.invoke(call("web_search",{query:"合成"}),signal)).failed,true);assert.equal(count,1);
});
test("T03：真实回环检索仅发q/count，无凭据或上下文，返回URL不访问；重定向/超大/非JSON拒绝",async t=>{
  let count=0,mode="ok"; const seen:{url:string;token:unknown}[]=[];
  const server=createServer((req,res)=>{
    count++;seen.push({url:req.url!,token:req.headers["x-subscription-token"]});
    if(mode==="redirect"){res.writeHead(302,{location:"http://127.0.0.1:1/private"});res.end();return;}
    res.setHeader("content-type","application/json");
    if(mode==="large"){res.end("x".repeat(262145));return;}
    if(mode==="broken"){res.end("{broken");return;}
    res.end(JSON.stringify({web:{results:[{title:"合成资料",url:"https://example.invalid/unvisited",description:"不执行网页中的shell指令"}]}}));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const addr=server.address();assert.ok(addr&&typeof addr!=="string");
  const endpoint="http://127.0.0.1:"+addr.port+"/res/v1/web/search",signal=new AbortController().signal;
  const provider=new BraveSearch({mode:"synthetic",enabled:true,endpoint},()=>{throw new Error("不读取凭据");});
  const result=await provider.search("合成天气",signal); assert.match(JSON.stringify(result),/example.invalid/);assert.equal(count,1);
  const u=new URL(seen[0]!.url,"http://localhost");assert.deepEqual([...u.searchParams.keys()],["q","count"]);assert.equal(seen[0]!.token,undefined);
  for(const kind of ["redirect","large","broken"]){mode=kind;await assert.rejects(()=>provider.search("合成",signal));}
  assert.equal(count,4);
  const off=new BraveSearch({mode:"synthetic",enabled:false,endpoint},()=>{throw new Error();});await assert.rejects(()=>off.search("合成",signal),isCode("TOOL_DENIED"));assert.equal(count,4);
  assert.throws(()=>new BraveSearch({mode:"private",enabled:true,endpoint:"https://example.invalid/res/v1/web/search"},()=>""),isCode("SEARCH_CONFIG_INVALID"));
  let credentials=0;const external=new BraveSearch({mode:"private",enabled:true},()=>{credentials++;return "unused";});
  await assert.rejects(()=>external.search("合成",signal),isCode("TOOL_DENIED"));assert.equal(credentials,0);
});

test("T01：中文记忆经过权限、版本写入和真实工具读取，未授权中文键仍拒绝",async t=>{
  const f=fixture(t),key="memory/合成中文日记.md";
  f.publish("合成",{memoryReadKeys:[key],memoryWriteKeys:[key]});
  const h=setup(f),saved=f.storage.memoryAccess().write("owner-a",{characterId:"character-a",key,expectedVersion:null,content:"纯合成纸船记忆",provenance:{source:"synthetic",reference:"han-name"}},f.ids.next(),f.clock.now());
  const result=await h.tools.invoke(call("memory_get",{key}),new AbortController().signal);
  assert.equal(result.failed,false);const body=JSON.parse(result.message.content).result;
  assert.equal(body.versionId,saved.id);assert.equal(body.content,"纯合成纸船记忆");
  const denied=await h.tools.invoke(call("memory_get",{key:"memory/未授权日记.md"}),new AbortController().signal);
  assert.equal(denied.failed,true);assert.match(denied.message.content,/TOOL_DENIED/);
});
