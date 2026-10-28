import { verify } from "../../../tools/import-openclaw/dist/apply.js";
import {TextSession} from "../dist/acceptance/text-session.js";
import {fixture as contextFixture} from "./context-fixtures.js";
import {textTrialMain} from "../../../tools/import-openclaw/dist/text-trial-cli.js";
import type {ProviderAdapter} from "../dist/ports.js";
import {test} from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import Database from "better-sqlite3";
import {sealed} from "./acceptance-preparation.test-support.js";
import {prepareTextTrial,textTrialPreflight,startTextTrial} from "../../../tools/import-openclaw/dist/text-trial.js";
import {hash} from "../../../tools/import-openclaw/dist/safe.js";
import {mockProvider} from "../dist/providers/mock.js";
import {loadMigrations,appliedMigrations} from "../dist/storage/migrations.js";
const settings={thinking:"provider-default" as const,maxTokens:32768,timezone:"UTC",windowTokens:1000000,reserveTokens:20000,maxCalls:2};
const code=(c:string)=>(e:unknown)=>(e as {code?:string}).code===c;
test("TT01：离线试聊副本先验证回退，保持空上下文且未激活，真实开关缺失不读凭据",async()=>{
 const f=sealed(),output=join(f.directory,"trial"),result=await prepareTextTrial(f.source,output,f.sealHash,settings);assert.equal(result.activated,false);assert.equal(result.schema,loadMigrations().length);assert.equal(result.contextEntries,0);assert.equal(result.rollbackVerified,true);let credentials=0;
 assert.throws(()=>startTextTrial(output,result.planSha256,{credential:()=>{credentials++;return "SYNTHETIC_SECRET";}}),code("TRIAL_AUTHORIZATION_REQUIRED"));assert.equal(credentials,0);assert.equal(existsSync(join(output,"TRIAL-STARTED.json")),false);assert.equal(textTrialPreflight(output,result.planSha256).checks.realCalls,0);
});
test("TT02：合成试聊复用完整编排，确认共享、新窗口隔离、总调用上限且基线不变",async t=>{
 const f=sealed(),output=join(f.directory,"trial"),sourceHash=hash(readFileSync(join(f.source,"preview/candidate/kuinest.sqlite"))),result=await prepareTextTrial(f.source,output,f.sealHash,settings),plan=textTrialPreflight(output,result.planSha256);
 const session=startTextTrial(output,result.planSha256,{syntheticProvider:{...mockProvider,description:{...mockProvider.description!,thinking:"provider-default"}}});t.after(()=>session.close());const first=await session.chat("合成第一个窗口的话题");assert.equal(first.status,"completed");
 const p=session.review.proposeUser(session.owner,session.character,{clientRequestId:session.ids.next(),content:"合成永久偏好赤色星球"});assert.equal(session.storage.memoryAccess().search(session.owner,session.character,"赤色星球").length,0);session.review.decide(session.owner,p.id,{revision:p.revision,contentSha256:p.contentSha256},"confirmed");
 const old=session.conversation;session.newConversation();assert.notEqual(session.conversation,old);const second=await session.chat("合成赤色星球");assert.equal(second.status,"completed");assert.equal(session.calls,2);await assert.rejects(()=>session.chat("超过额度"),code("RATE_LIMITED"));await session.close();
 const db=new Database(join(output,"database/kuinest.sqlite"),{readonly:true});try{
  const snapshot=db.prepare("SELECT manifest_json FROM context_snapshots WHERE run_id=?").get(second.runId) as {manifest_json:string};const m=JSON.parse(snapshot.manifest_json);assert.equal(m.prepared.selectedEntryIds.length,1);assert.ok(m.prepared.selectedMemories.some((x:{key:string})=>x.key==="memory/confirmed-"+p.id+".md"));
  const original=new Database(join(output,"rollback/kuinest.sqlite"),{readonly:true});try{for(const row of original.prepare("SELECT * FROM memory_versions").all() as {id:string}[])assert.deepEqual(db.prepare("SELECT * FROM memory_versions WHERE id=?").get(row.id),row);const docs=original.prepare("SELECT logical_name,content,sha256 FROM character_documents ORDER BY logical_name").all();assert.deepEqual(db.prepare("SELECT logical_name,content,sha256 FROM character_documents WHERE version_id=? ORDER BY logical_name").all(plan.version),docs);}finally{original.close();}
 }finally{db.close();}assert.equal(hash(readFileSync(join(f.source,"preview/candidate/kuinest.sqlite"))),sourceHash);assert.throws(()=>textTrialPreflight(output,result.planSha256));
});
test("TT03：错误哈希、路径及篡改库拒绝，不能复用已经启动的试用包",async()=>{
 const f=sealed(),output=join(f.directory,"trial"),r=await prepareTextTrial(f.source,output,f.sealHash,settings);assert.throws(()=>textTrialPreflight(output,"0".repeat(64)),code("TRIAL_PLAN_CHANGED"));writeFileSync(join(output,"TRIAL-STARTED.json"),"{}");assert.throws(()=>textTrialPreflight(output,r.planSha256),code("TRIAL_ALREADY_STARTED"));
 const g=sealed(),dir=join(g.directory,"trial"),s=await prepareTextTrial(g.source,dir,g.sealHash,settings);writeFileSync(join(dir,"database/kuinest.sqlite"),"SYNTHETIC_CORRUPTION");assert.throws(()=>textTrialPreflight(dir,s.planSha256),code("TRIAL_FILE_CHANGED"));
 await assert.rejects(()=>prepareTextTrial(g.source,g.source,g.sealHash,settings),code("TRIAL_OUTPUT_INVALID"));
});
test("TT04：旧schema3封存验证不升级原库，只有新试用库升级当前版本",async()=>{
 const f=sealed(),file=join(f.source,"preview/candidate/kuinest.sqlite"),db=new Database(file);try{db.exec("DROP INDEX conversations_visible_page; ALTER TABLE conversations DROP COLUMN deleted_at; DROP TABLE kuisense_latest_context; DROP TABLE memory_proposal_revisions; DROP TABLE memory_proposals; DELETE FROM schema_migrations WHERE version>=4;");assert.equal(appliedMigrations(db).length,3);}finally{db.close();}
 const sealFile=f.seal.files.find(p=>p.path===file)!;sealFile.sha256=hash(readFileSync(file));const sha=f.save(),before=hash(readFileSync(file));assert.equal(verify(join(f.source,"preview/candidate")).ok,true);assert.equal(hash(readFileSync(file)),before);const output=join(f.directory,"trial"),r=await prepareTextTrial(f.source,output,sha,settings);assert.equal(r.schema,loadMigrations().length);assert.equal(hash(readFileSync(file)),before);
 for(const [name,count] of [["database",loadMigrations().length],["rollback",3],["restore-rehearsal",3]] as const){const d=new Database(join(output,name,"kuinest.sqlite"),{readonly:true});try{assert.equal(appliedMigrations(d).length,count);}finally{d.close();}}assert.equal(loadMigrations().length,6);
});
test("TT05：试用参数闭合校验，未知字段与无限调用预算拒绝",async()=>{const f=sealed();for(const s of [{...settings,maxCalls:13},{...settings,allowLive:true},{...settings,windowTokens:100},{...settings,thinking:"invented"}])await assert.rejects(()=>prepareTextTrial(f.source,join(f.directory,"trial"),f.sealHash,s));assert.equal(existsSync(join(f.directory,"trial")),false);});

test("TT06：真实工具循环产生候选后续答复，续轮占用总请求额度",async t=>{
 const f=contextFixture(t);f.publish("纯合成角色",{memoryReviewEnabled:true,memoryWriteKeys:[]});let calls=0;
 const provider:ProviderAdapter={description:mockProvider.description!,async *stream(){calls++;if(calls===1){yield {type:"reasoning_delta",text:"合成思考"};yield {type:"tool_call_delta",index:0,id:"synthetic-propose",name:"memory_propose",arguments:JSON.stringify({content:"合成长期偏好青色方块"})};yield {type:"finish",reason:"tool_calls"};}else{yield {type:"text_delta",text:"合成答复：已列为待确认。"};yield {type:"finish",reason:"stop"};}}};
 const session=new TextSession(f.storage,"owner-a","character-a",f.clock,()=>provider,2);f.cleanup(()=>session.close());
 const result=await session.chat("合成请求记下偏好");assert.equal(result.status,"completed");assert.equal(calls,2);assert.equal(session.calls,2);const queue=session.review.list("owner-a","character-a");assert.equal(queue.items.length,1);assert.equal(queue.items[0]!.status,"pending");assert.equal(f.storage.memoryAccess().search("owner-a","character-a","青色方块").length,0);await assert.rejects(()=>session.chat("合成超额"),code("RATE_LIMITED"));assert.equal(calls,2);
});
test("TT07：工具续轮达到预算时不发出额外上游请求",async t=>{
 const f=contextFixture(t);f.publish("合成",{memoryReviewEnabled:true,memoryWriteKeys:[]});let calls=0;
 const provider:ProviderAdapter={description:mockProvider.description!,async *stream(){calls++;yield {type:"tool_call_delta",index:0,id:"synthetic-time",name:"clock_now",arguments:"{}"};yield {type:"finish",reason:"tool_calls"};}};
 const session=new TextSession(f.storage,"owner-a","character-a",f.clock,()=>provider,1);f.cleanup(()=>session.close());const result=await session.chat("合成时间请求");assert.equal(result.status,"failed");assert.equal(calls,1);assert.equal(session.calls,1);
});
test("TT08：重定向终端不允许进入私人聊天或读取凭据",async()=>{await assert.rejects(()=>textTrialMain(["chat","--directory=D:/nonexistent","--plan-sha256="+"0".repeat(64),"--allow-live=true"]),code("TRIAL_INTERACTIVE_AUTHORIZATION_REQUIRED"));});
