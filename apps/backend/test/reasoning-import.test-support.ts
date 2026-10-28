import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, next, messages, entry, put, sessionBytes, inspect } from "./import-fixtures.js";
import { readDeferredReplay } from "../dist/context/deferred-replay.js";
import { analyze, summary } from "../../../tools/import-openclaw/dist/validate.js";
import { loadBundle } from "../../../tools/import-openclaw/dist/capture.js";
import { apply, verify } from "../../../tools/import-openclaw/dist/apply.js";
import { scope } from "../../../tools/import-openclaw/dist/manifest.js";
import { replayProfileHash } from "../../../tools/import-openclaw/dist/replay.js";
import { requestBody } from "../dist/providers/deepseek.js";
import { resolve } from "../dist/context/branches.js";
import type { Scope, RawEntry } from "../../../tools/import-openclaw/dist/types.js";
import type { Entry } from "../dist/context/types.js";
import type { ThinkingMode } from "../dist/providers/policy.js";
import { uid } from "../../../tools/import-openclaw/dist/safe.js";
const source = { api: "openai-completions" as const, provider: "synthetic-provider", model: "synthetic" };
const isCode = (code: string) => (e: unknown) => (e as {code?:string}).code === code;
const tools = [{type:"function" as const,function:{name:"synthetic_echo",description:"纯合成回声",parameters:{type:"object",properties:{}}}}];
function bind(definition: Scope, mode: ThinkingMode = "provider-default") {
  definition.requireReasoning = false;
  definition.profile.options = {thinking:mode};
  definition.reasoningReplay = {format:"bound-completions-v1",target:{...source},profileSha256:replayProfileHash(definition.profile)};
}
function history(): RawEntry[] { return [
  messages()[0]!,
  entry("call","u1",{role:"assistant",...source,content:[{type:"toolCall",id:"synthetic_call",name:"synthetic_echo",arguments:{}}],stopReason:"toolUse"}),
  entry("result","call",{role:"toolResult",toolCallId:"synthetic_call",content:"合成工具结果"}),
  entry("a1","result",{role:"assistant",...source,content:[{type:"text",text:"合成公开答复"}],stopReason:"stop"}),
]; }
function build(mode: ThinkingMode = "provider-default", records = history()) {
  const f=fixture(); bind(f.definition,mode);
  put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));f.build();
  return {...f,analysis:analyze(loadBundle(f.batch))};
}
function stored(target:string):Entry[] {
  return inspect(target,db=>(db.prepare("SELECT id,parent_id AS parentId,branch_id AS branchId,kind,payload_json FROM context_entries").all() as (Entry&{payload_json:string})[])
    .map(e=>({...e,payload:JSON.parse(e.payload_json)})));
}
test("RP01：显式同模型绑定允许默认/关闭策略的缺思考工具历史，原档和wire均不补造字段",()=>{
  for(const mode of ["provider-default","disabled"] as const){
    const f=build(mode);assert.deepEqual(f.analysis.gaps,[]);apply(f.batch,f.target,"owner");
    const selected=resolve(stored(f.target),uid(f.definition.sourceId,"main",f.sessionId,"a1"));
    const input=selected.selected.map(e=>e.message);assert.equal(input.length,4);
    for(const m of input) if(m.role==="assistant")assert.equal(Object.hasOwn(m,"reasoning_content"),false);
    const wire=requestBody({system:"合成系统",messages:input,tools,options:{mode:"synthetic",thinking:mode}},
      {mode:"synthetic",model:"synthetic",endpoint:"http://127.0.0.1/chat/completions",allowedOrigin:"http://127.0.0.1",thinking:mode});
    assert.equal(Object.hasOwn(wire,"thinking"),mode==="disabled");
    assert.doesNotMatch(JSON.stringify(wire),/reasoning_content/);assert.equal(verify(f.target).records,4);
    const original=inspect(f.target,db=>(db.prepare("SELECT content FROM import_objects WHERE path=?").get("sessions/"+f.sessionId+".jsonl") as {content:Buffer}).content);
    assert.equal(original.toString(),sessionBytes(f.sessionId,history()));
  }
});
test("RP02：未声明绑定保留原有缺口，不因profile写默认策略而自动放行",()=>{
  const f=fixture();f.definition.requireReasoning=false;f.definition.profile.options={thinking:"provider-default"};
  put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,history()));f.build();
  assert.ok(analyze(loadBundle(f.batch)).gaps.includes("REASONING_MISSING"));
  assert.throws(()=>apply(f.batch,f.target,"owner"),isCode("COMPATIBILITY_GAPS"));
});
test("RP03：开启策略或显式requireReasoning继续拒绝缺字段，不能靠绑定降级",()=>{
  const f=build("enabled");assert.ok(f.analysis.gaps.includes("REASONING_MISSING"));
  assert.throws(()=>apply(f.batch,f.target,"owner"),isCode("COMPATIBILITY_GAPS"));
  const g=fixture();bind(g.definition);g.definition.requireReasoning=true;
  put(g.input,"sessions/"+g.sessionId+".jsonl",sessionBytes(g.sessionId,history()));g.build();
  assert.ok(analyze(loadBundle(g.batch)).gaps.includes("REASONING_MISSING"));
});
test("RP04：同模型多个受支持思考块按旧版换行合并，私有空白和原档保留，公开无泄漏",()=>{
  const thoughts=["  SYNTHETIC_PRIVATE_ONE  ","\t","\nSYNTHETIC_PRIVATE_TWO\n"];
  const records=[messages()[0]!,entry("a1","u1",{role:"assistant",...source,content:[
    ...thoughts.map(thinking=>({type:"thinking",thinking,thinkingSignature:"reasoning_content"})),{type:"text",text:"合成公开文字"}
  ],stopReason:"stop"})];
  const f=build("enabled",records);assert.deepEqual(f.analysis.gaps,[]);apply(f.batch,f.target,"owner");
  const selected=resolve(stored(f.target),uid(f.definition.sourceId,"main",f.sessionId,"a1")).selected.map(e=>e.message);
  const a=selected.at(-1)!;assert.equal(a.role,"assistant");assert.equal((a as {reasoning_content:string}).reasoning_content,thoughts[0]+"\n"+thoughts[2]);
  const wire=requestBody({system:"合成",messages:selected,tools,options:{mode:"synthetic"}},{mode:"synthetic",model:"synthetic",endpoint:"http://127.0.0.1/chat/completions",allowedOrigin:"http://127.0.0.1"});
  assert.equal((wire.messages as {reasoning_content?:string}[]).at(-1)!.reasoning_content,thoughts[0]+"\n"+thoughts[2]);
  const visible=inspect(f.target,db=>db.prepare("SELECT content FROM messages WHERE role='assistant'").all());
  assert.deepEqual(visible,[{content:"合成公开文字"}]);assert.doesNotMatch(JSON.stringify(visible),/SYNTHETIC_PRIVATE/);
  const original=inspect(f.target,db=>(db.prepare("SELECT content FROM import_objects WHERE path=?").get("sessions/"+f.sessionId+".jsonl") as {content:Buffer}).content);
  assert.equal(original.toString(),sessionBytes(f.sessionId,records));
});
test("RP05：来源缺失/跨provider/API/model都阻止应用，不把思考转为公开文字",()=>{
  for(const patch of [{provider:undefined},{model:undefined},{api:undefined},{provider:"another"},{model:"another"},{api:"openai-responses"}]){
    const rows=history();rows[1]=entry("call","u1",{...(rows[1]!.message as object),...patch});
    const f=build("provider-default",rows);
    assert.ok(f.analysis.gaps.some(g=>g==="REPLAY_SOURCE_IDENTITY_MISSING"||g==="CROSS_MODEL_REPLAY_REVIEW"));
    const target=join(f.directory,"must-not-be-opened");assert.throws(()=>apply(f.batch,target,"owner"),isCode("COMPATIBILITY_GAPS"));assert.equal(existsSync(target),false);
  }
});
test("RP06：未知/无签名、redacted、双来源和工具签名仍拒绝",()=>{
  for(const patch of [
    {content:[{type:"thinking",thinking:"SYNTHETIC_PRIVATE"}]},
    {content:[{type:"thinking",thinking:"SYNTHETIC_PRIVATE",thinkingSignature:"unknown"}]},
    {content:[{type:"thinking",thinking:"SYNTHETIC_PRIVATE",thinkingSignature:"reasoning_content",redacted:true}]},
    {reasoning_content:"SYNTHETIC_OTHER",content:[{type:"thinking",thinking:"SYNTHETIC_PRIVATE",thinkingSignature:"reasoning_content"}]},
    {content:[{type:"toolCall",id:"synthetic_call",name:"synthetic_echo",arguments:{},thoughtSignature:"SYNTHETIC_OPAQUE"}]},
  ]){
    const rows=history();rows[1]=entry("call","u1",{...(rows[1]!.message as object),...patch});
    const f=build("provider-default",rows);assert.ok(f.analysis.gaps.length);assert.throws(()=>apply(f.batch,f.target,"owner"),isCode("COMPATIBILITY_GAPS"));
  }
});
test("RP07：绑定清单字段闭集、profile配置哈希及模型必须匹配",()=>{
  const f=fixture();bind(f.definition);scope(f.definition);
  for(const mutate of [
    (d:Scope)=>{d.profile.options.thinking="disabled";},
    (d:Scope)=>{d.reasoningReplay!.target.model="another";},
    (d:Scope)=>{(d.reasoningReplay as unknown as Record<string,unknown>).extra="SYNTHETIC_SECRET";},
    (d:Scope)=>{(d.reasoningReplay!.target as unknown as Record<string,unknown>).api="openai-responses";},
  ]){
    const d=structuredClone(f.definition);mutate(d);assert.throws(()=>scope(d));
  }
  assert.equal(replayProfileHash({...f.definition.profile,options:{thinking:"provider-default",maxTokens:100}}),
    replayProfileHash({...f.definition.profile,options:{maxTokens:100,thinking:"provider-default"}}));
});
test("RP08：单向追加/重复批次保留映射；中途改绑定策略须新候选，不静默混用",()=>{
  const f=build();const before=loadBundle(f.batch);apply(f.batch,f.target,"owner");const original=stored(f.target);
  const rows=[...history(),entry("u2","a1",{role:"user",content:"合成后续"}),
    entry("a2","u2",{role:"assistant",...source,content:"合成第二次答复",stopReason:"stop"})];
  const delta=next(f,before.manifestHash,rows);delta.definition.conversations[0]!.history[0]!.leafId="a2";delta.build();
  apply(delta.batch,f.target,"owner");assert.equal(apply(delta.batch,f.target,"owner").replay,true);
  for(const e of original)assert.deepEqual(stored(f.target).find(v=>v.id===e.id),e);
  assert.equal(verify(f.target).records,6);
  const g=build();const base=loadBundle(g.batch);apply(g.batch,g.target,"owner");
  const changed=next(g,base.manifestHash,history());bind(changed.definition,"disabled");changed.build();
  assert.throws(()=>apply(changed.batch,g.target,"owner"),isCode("REPLAY_POLICY_CHANGED"));assert.equal(verify(g.target).revision,1);
});
test("RP09：没有思考正文时不开启补空；已收到思考在关闭策略下仅从传输副本移除",()=>{
  const rows=[messages()[0]!,entry("a1","u1",{role:"assistant",...source,content:[
    {type:"thinking",thinking:"  ",thinkingSignature:"reasoning_content"},{type:"text",text:"合成答复"}],stopReason:"stop"})];
  assert.ok(build("enabled",rows).analysis.gaps.includes("REASONING_MISSING"));
  rows[1]=entry("a1","u1",{role:"assistant",...source,content:[{type:"thinking",thinking:"SYNTHETIC_RETAIN",thinkingSignature:"reasoning_content"},{type:"text",text:"合成答复"}],stopReason:"stop"});
  const f=build("disabled",rows);apply(f.batch,f.target,"owner");
  const input=resolve(stored(f.target),uid(f.definition.sourceId,"main",f.sessionId,"a1")).selected.map(e=>e.message),before=structuredClone(input);
  const wire=requestBody({system:"合成",messages:input,tools,options:{mode:"synthetic",thinking:"disabled"}},
    {mode:"synthetic",thinking:"disabled",model:"synthetic",endpoint:"http://127.0.0.1/chat/completions",allowedOrigin:"http://127.0.0.1"});
  assert.doesNotMatch(JSON.stringify(wire),/SYNTHETIC_RETAIN/);assert.deepEqual(input,before);assert.match(JSON.stringify(input),/SYNTHETIC_RETAIN/);
});
test("RP10：绑定不代替工具配对，也不代替连续性验收或角色激活",()=>{
  const broken=history().filter(e=>e.id!=="result");broken[2]!.parentId="call";
  const bad=build("provider-default",broken);assert.ok(bad.analysis.gaps.includes("CONTEXT_OR_PROTOCOL_INVALID"));
  const f=build();const result=apply(f.batch,f.target,"owner");assert.equal(result.activated,false);assert.equal(result.continuity,"user_acceptance_pending");
  assert.deepEqual(inspect(f.target,db=>db.prepare("SELECT active_version_id FROM characters").all()),[{active_version_id:null}]);
  assert.ok(Object.values(loadBundle(f.batch).manifest.compatibility).every(v=>v==="unverified"));
});

function archivedHistory():RawEntry[] {
  const rows=history();
  for(const e of rows) if((e.message as {role?:string})?.role==="assistant")
    (e.message as Record<string,unknown>).model="synthetic-previous";
  rows[3]!.id="old_reply";
  return [...rows,entry("u2","old_reply",{role:"user",content:"合成当前问题"}),
    entry("a1","u2",{role:"assistant",...source,content:"合成当前答复",stopReason:"stop"}),
    {type:"compaction",id:"compact",parentId:"a1",timestamp:"2026-09-11T00:01:00.000Z",
      summary:"合成历史摘要",firstKeptEntryId:"u2",tokensBefore:100}];
}
function deferredFixture(records=archivedHistory(),leaf="compact") {
  const f=fixture();bind(f.definition);f.definition.reasoningReplay!.deferHistoricalReplay=true;
  f.definition.conversations[0]!.history[0]!.leafId=leaf;
  put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));f.build();
  return {...f,analysis:analyze(loadBundle(f.batch))};
}
test("RP11：压缩前跨模型历史完整存档和公开展示，当前续聊只使用已适配尾部",()=>{
  const f=deferredFixture();assert.deepEqual(f.analysis.gaps,[]);assert.equal(summary(f.analysis).deferredReplayRecords,2);
  const result=apply(f.batch,f.target,"owner");assert.equal(result.deferredReplayRecords,2);assert.equal(result.activated,false);
  const all=stored(f.target),blocked=all.filter(e=>readDeferredReplay(e));assert.equal(blocked.length,2);
  assert.ok(blocked.every(e=>(e.payload as {replay:string}).replay==="blocked"));
  const current=resolve(all,uid(f.definition.sourceId,"main",f.sessionId,"compact"));
  assert.equal(current.summary!.text,"合成历史摘要");assert.deepEqual(current.selected.map(e=>e.message.content),["合成当前问题","合成当前答复"]);
  assert.equal(inspect(f.target,db=>(db.prepare("SELECT count(*) AS n FROM messages WHERE visibility='visible'").get() as {n:number}).n),4);
  const raw=inspect(f.target,db=>(db.prepare("SELECT content FROM import_objects WHERE path=?").get("sessions/"+f.sessionId+".jsonl") as {content:Buffer}).content);
  assert.equal(raw.toString(),sessionBytes(f.sessionId,archivedHistory()));assert.equal(verify(f.target).records,7);
});
test("RP12：选回待适配历史或让摘要保留点覆盖它时，导入与运行均明确拒绝",()=>{
  const f=deferredFixture();apply(f.batch,f.target,"owner");
  assert.throws(()=>resolve(stored(f.target),uid(f.definition.sourceId,"main",f.sessionId,"old_reply")),
    e=>(e as {code?:string}).code==="CONTEXT_UNVERIFIED");
  const old=deferredFixture(archivedHistory(),"old_reply");assert.ok(old.analysis.gaps.includes("CONTEXT_OR_PROTOCOL_INVALID"));
  assert.throws(()=>apply(old.batch,old.target,"owner"),isCode("COMPATIBILITY_GAPS"));
  const rows=archivedHistory();rows.at(-1)!.firstKeptEntryId="call";
  const retained=deferredFixture(rows);assert.ok(retained.analysis.gaps.includes("CONTEXT_OR_PROTOCOL_INVALID"));
});
test("RP13：延后回放不放过未知签名、缺来源、未配对工具及未知记录",()=>{
  for(const variant of ["signature","toolSignature","identity","pair","unknown"]){
    const rows=archivedHistory();
    if(variant==="signature") (rows[1]!.message as {content:unknown[]}).content.push({type:"thinking",thinking:"SYNTHETIC_PRIVATE",thinkingSignature:"unsupported"});
    if(variant==="toolSignature") ((rows[1]!.message as {content:Record<string,unknown>[]}).content[0]!).thoughtSignature="SYNTHETIC_OPAQUE";
    if(variant==="identity") delete (rows[1]!.message as Record<string,unknown>).provider;
    if(variant==="pair"){rows.splice(2,1);rows[2]!.parentId="call";}
    if(variant==="unknown") rows[1]!.type="unsupported_entry";
    const f=deferredFixture(rows);assert.ok(f.analysis.gaps.length,variant);assert.throws(()=>apply(f.batch,f.target,"owner"),isCode("COMPATIBILITY_GAPS"));
  }
});
test("RP14：延后记录保留私有思考，可见历史不泄漏；标记损坏或未知版本不能被静默跳过",()=>{
  const rows=archivedHistory();(rows[3]!.message as Record<string,unknown>).reasoning_content="SYNTHETIC_OLD_PRIVATE";
  const f=deferredFixture(rows);apply(f.batch,f.target,"owner");
  const all=stored(f.target),old=all.find(e=>e.id===uid(f.definition.sourceId,"main",f.sessionId,"old_reply"))!;
  assert.match(JSON.stringify(readDeferredReplay(old)),/SYNTHETIC_OLD_PRIVATE/);
  assert.doesNotMatch(JSON.stringify(inspect(f.target,db=>db.prepare("SELECT content FROM messages").all())),/SYNTHETIC_OLD_PRIVATE/);
  for(const patch of [{replay:"allow"},{sourceType:"openclaw-deferred-replay-v2"},{reviewCodes:[]},{reviewCodes:["UNKNOWN"]},{profileSha256:"invalid"},{message:{role:"user",content:"合成"}}]){
    const entry={...old,parentId:null,payload:{...(old.payload as object),...patch}};
    assert.throws(()=>resolve([entry],entry.id));
  }
});
test("RP15：追加新回合保持旧延后标记和公开身份，后续重新选择旧历史会拒绝",()=>{
  const f=deferredFixture(),base=loadBundle(f.batch);apply(f.batch,f.target,"owner");const old=stored(f.target);
  const rows=[...archivedHistory(),entry("u3","compact",{role:"user",content:"合成追加"}),
    entry("a3","u3",{role:"assistant",...source,content:"合成追加回复",stopReason:"stop"})];
  const delta=next(f,base.manifestHash,rows);delta.definition.conversations[0]!.history[0]!.leafId="a3";delta.build();
  apply(delta.batch,f.target,"owner");assert.equal(apply(delta.batch,f.target,"owner").replay,true);
  for(const e of old)assert.deepEqual(stored(f.target).find(v=>v.id===e.id),e);
  assert.equal(verify(f.target).records,9);
  const current=resolve(stored(f.target),uid(f.definition.sourceId,"main",f.sessionId,"a3"));assert.equal(current.selected.length,4);
  assert.throws(()=>resolve(stored(f.target),uid(f.definition.sourceId,"main",f.sessionId,"old_reply")),
    e=>(e as {code?:string}).code==="CONTEXT_UNVERIFIED");
});
