import {test} from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import Database from "better-sqlite3";
import {compile} from "../dist/context/compiler.js";
import {config,defaults,documents,documentNames,expressionDocumentName,hash} from "../dist/context/profile.js";
import type {Pinned} from "../dist/context/types.js";
import type {ProviderRequest} from "../dist/ports.js";
import {doc} from "./context-fixtures.js";
import {sealed} from "./acceptance-preparation.test-support.js";
import {prepareTextTrial,startTextTrial,textTrialPreflight} from "../../../tools/import-openclaw/dist/text-trial.js";
import {textTrialMain} from "../../../tools/import-openclaw/dist/text-trial-cli.js";
import {mockProvider} from "../dist/providers/mock.js";

const settings={thinking:"provider-default" as const,maxTokens:32768,timezone:"UTC",windowTokens:1000000,reserveTokens:20000,maxCalls:2};
// 全新编写的纯合成测试文本，不使用私人提示语或真实对话的改写。
const text="合成表达试验：使用航天播报口吻，称当前试验为蓝环航线。";
const expression={bytes:Buffer.from(text),sha256:hash(text)};
const code=(name:string)=>(e:unknown)=>(e as {code?:string}).code===name;
function pinned(enabled=false):Pinned {
 const entry={id:"u",parentId:null,branchId:"b",kind:"message",payload:{role:"user",content:"合成当前输入"}};
 return {snapshotId:"snapshot",characterId:"character",versionId:"version",profile:{id:"profile",provider:"mock",model:"synthetic",endpoint:null,options:{maxTokens:100},status:"synthetic"},config:config(enabled?{expressionEnabled:true,documentOrder:[...documentNames,expressionDocumentName]}:{}),documents:[...documentNames.map(n=>doc(n,"合成资料 "+n)),...(enabled?[doc(expressionDocumentName,text)]:[])],memories:[],entries:[entry],boundary:"u",branchId:"b",receivedAt:0};
}

test("EX01：表达配置必须显式开启并保留原资料；关闭后恢复原请求",()=>{
 const original=compile(pinned(),[]),enabled=pinned(true),compiled=compile(enabled,[]);
 assert.ok(compiled.request.system.includes(text));assert.equal(compiled.manifest.expression?.sha256,expression.sha256);
 assert.equal(compiled.manifest.documents.at(-1)!.name,expressionDocumentName);
 assert.ok(compiled.request.system.includes("实际能力仅以本次tools为准"));
 const disabled={...enabled,config:config({}),documents:enabled.documents.filter(d=>d.name!==expressionDocumentName)};
 assert.deepEqual(compile(disabled,[]).request,original.request);assert.equal(original.manifest.expression,undefined);
 for(const input of [{expressionEnabled:true},{expressionEnabled:"true"},{documentOrder:[...documentNames,expressionDocumentName]},{expressionEnabled:true,documentOrder:[expressionDocumentName,...documentNames]},{expressionEnabled:true,documentOrder:["SOUL.md",expressionDocumentName]}])assert.throws(()=>config(input));
});
test("EX02：表达层缺失、重复、错哈希或缺原资料拒绝，不可通过截断基线腾空间",()=>{
 const p=pinned(true),c=config(p.config),withExpression=p.documents;
 for(const docs of [withExpression.filter(d=>d.name!==expressionDocumentName),withExpression.filter(d=>d.name!=="SOUL.md"),[...withExpression,doc(expressionDocumentName,text)],withExpression.map(d=>d.name===expressionDocumentName?{...d,sha256:"0".repeat(64)}:d)])assert.throws(()=>documents(docs,c));
 assert.throws(()=>documents(withExpression,{...c,totalChars:30}),code("CONTEXT_TOO_LARGE"));
 assert.throws(()=>documents(withExpression,{...c,fileChars:5}),code("CONTEXT_TOO_LARGE"));
});
test("EX03：无效UTF8、空白及超限表达在创建试用目录前拒绝",async()=>{
 const f=sealed(),output=join(f.directory,"trial");
 for(const bytes of [Buffer.from([255]),Buffer.from(" \n\t"),Buffer.alloc(65537,97)])await assert.rejects(()=>prepareTextTrial(f.source,output,f.sealHash,settings,{bytes,sha256:hash(bytes)}),code("TRIAL_EXPRESSION_INVALID"));
 await assert.rejects(()=>prepareTextTrial(f.source,output,f.sealHash,settings,{...expression,sha256:"0".repeat(64)}),code("TRIAL_EXPRESSION_INVALID"));assert.equal(existsSync(output),false);
});
test("EX04：端到端请求实际收到表达，基线字节未改，空窗口隔离与确认制保持",async t=>{
 const f=sealed(),output=join(f.directory,"trial"),sourceHash=hash(readFileSync(join(f.source,"preview/candidate/kuinest.sqlite")));
 const result=await prepareTextTrial(f.source,output,f.sealHash,settings,expression),plan=textTrialPreflight(output,result.planSha256);
 assert.equal(plan.config.expressionEnabled,true);assert.equal(plan.expression!.sha256,expression.sha256);assert.equal(plan.config.memoryReviewEnabled,true);assert.deepEqual(plan.config.memoryWriteKeys,[]);assert.equal(plan.config.memoryReplaceEnabled,false);assert.equal(plan.checks.contextEntries,0);
 const requests:ProviderRequest[]=[];
 const session=startTextTrial(output,result.planSha256,{syntheticProvider:{description:{...mockProvider.description!,thinking:"provider-default"},async *stream(request){requests.push(structuredClone(request));yield {type:"text_delta",text:"合成验证完成"};yield {type:"finish",reason:"stop"};}}});t.after(()=>session.close());
 assert.equal((await session.chat("合成窗口一标记")).status,"completed");session.newConversation();const next=await session.chat("合成窗口二标记");assert.equal(next.status,"completed");assert.equal(requests.length,2);
 for(const request of requests){assert.ok(request.system.includes(text));assert.equal(request.system.split(text).length,2);assert.ok(request.system.includes("memory_propose只提出待确认候选"));}
 assert.equal(requests[1]!.messages.length,1);assert.ok(!JSON.stringify(requests[1]).includes("合成窗口一标记"));
 await session.close();
 const db=new Database(join(output,"database/kuinest.sqlite"),{readonly:true}),rollback=new Database(join(output,"rollback/kuinest.sqlite"),{readonly:true});
 try{
  assert.deepEqual(db.prepare("SELECT logical_name,content,sha256 FROM character_documents WHERE version_id=? AND logical_name<>? ORDER BY logical_name").all(plan.version,expressionDocumentName),rollback.prepare("SELECT logical_name,content,sha256 FROM character_documents ORDER BY logical_name").all());
  assert.deepEqual(db.prepare("SELECT * FROM memory_versions ORDER BY id").all(),rollback.prepare("SELECT * FROM memory_versions ORDER BY id").all());
  const row=db.prepare("SELECT manifest_json FROM context_snapshots WHERE run_id=?").get(next.runId) as {manifest_json:string};const m=JSON.parse(row.manifest_json);assert.equal(m.prepared.expression.sha256,expression.sha256);assert.equal(m.prepared.selectedEntryIds.length,1);
 }finally{db.close();rollback.close();}
 assert.equal(hash(readFileSync(join(f.source,"preview/candidate/kuinest.sqlite"))),sourceHash);
});
test("EX05：表达文件变更或计划开关不一致会阻止启动",async()=>{
 const f=sealed(),output=join(f.directory,"trial"),r=await prepareTextTrial(f.source,output,f.sealHash,settings,expression);
 writeFileSync(join(output,expressionDocumentName),"已改变的合成表达");assert.throws(()=>textTrialPreflight(output,r.planSha256),code("TRIAL_EXPRESSION_INVALID"));
 writeFileSync(join(output,expressionDocumentName),expression.bytes);const file=join(output,"TRIAL-PLAN.json"),plan=JSON.parse(readFileSync(file,"utf8"));delete plan.expression;const bytes=Buffer.from(JSON.stringify(plan));writeFileSync(file,bytes);assert.throws(()=>textTrialPreflight(output,hash(bytes)),code("TRIAL_EXPRESSION_INVALID"));assert.equal(existsSync(join(output,"TRIAL-STARTED.json")),false);
});
test("EX06：命令行表达参数必须成对，完整离线入口保存相同字节",async()=>{
 for(const arg of ["--expression-dir=D:/not-used","--expression-sha256="+expression.sha256])await assert.rejects(()=>textTrialMain(["prepare","--input=D:/not-used","--output=D:/not-used","--seal-sha256="+"0".repeat(64),"--settings-dir=D:/not-used",arg]),code("TRIAL_ARGUMENT_INVALID"));
 const f=sealed(),output=join(f.directory,"trial");writeFileSync(join(f.directory,"TRIAL-SETTINGS.json"),JSON.stringify(settings));writeFileSync(join(f.directory,expressionDocumentName),expression.bytes);
 const result=await textTrialMain(["prepare","--input="+f.source,"--output="+output,"--seal-sha256="+f.sealHash,"--settings-dir="+f.directory,"--expression-dir="+f.directory,"--expression-sha256="+expression.sha256]);
 assert.ok("planSha256" in result);assert.equal(textTrialPreflight(output,result.planSha256).expression!.sha256,expression.sha256);assert.deepEqual(readFileSync(join(output,expressionDocumentName)),expression.bytes);
});

test("EX07：原项目提示语完整置于system开头，不套表达参考包装；旧请求逐字兼容",()=>{
 const p=pinned(true),legacy=compile(p,[]);
 assert.equal(hash(JSON.stringify(legacy.request)),"45791060f58a4b78738222b5db25019cb1e9dd62f35db39ad0aacf4487186252");
 const next=compile({...p,config:config({...config(p.config),expressionMode:"project-instructions"})},[]);
 assert.ok(next.request.system.startsWith(text+"\n\n"));assert.equal(next.request.system.split(text).length,2);
 assert.ok(!next.request.system.includes("【独立表达参考】"));assert.ok(!next.request.system.includes("【表达参考的运行边界】"));
 for(const d of p.documents.filter(d=>d.name!==expressionDocumentName))assert.ok(next.request.system.indexOf(Buffer.from(d.bytes).toString())>text.length);
 assert.deepEqual(next.manifest.documents,legacy.manifest.documents);assert.deepEqual(next.request.messages,legacy.request.messages);assert.deepEqual(next.request.tools,legacy.request.tools);assert.deepEqual(next.request.options,legacy.request.options);
 assert.equal(next.manifest.expression?.version,"project-instructions-v1");assert.equal(next.manifest.expression?.sha256,expression.sha256);
 for(const value of [{expressionMode:"project-instructions"},{...config(p.config),expressionMode:"unknown"}])assert.throws(()=>config(value));
});
test("EX08：新模式经过真实编排入口保存，确认制与空窗口继续生效",async t=>{
 const f=sealed(),output=join(f.directory,"trial"),result=await prepareTextTrial(f.source,output,f.sealHash,settings,{...expression,mode:"project-instructions"});
 const plan=textTrialPreflight(output,result.planSha256);assert.equal(plan.config.expressionMode,"project-instructions");
 const requests:ProviderRequest[]=[];
 const session=startTextTrial(output,result.planSha256,{syntheticProvider:{description:{...mockProvider.description!,thinking:"provider-default"},async *stream(request){requests.push(structuredClone(request));yield {type:"text_delta",text:"合成试验结果"};yield {type:"finish",reason:"stop"};}}});t.after(()=>session.close());
 assert.equal((await session.chat("合成甲窗口")).status,"completed");session.newConversation();const resultB=await session.chat("合成乙窗口");assert.equal(resultB.status,"completed");
 for(const r of requests){assert.ok(r.system.startsWith(text+"\n\n"));assert.ok(r.system.includes("memory_propose只提出待确认候选"));assert.ok(!r.system.includes("【独立表达参考】"));assert.ok(!r.tools.some(t=>t.name==="memory_write"));}
 assert.equal(requests[1]!.messages.length,1);assert.ok(!JSON.stringify(requests[1]).includes("合成甲窗口"));await session.close();
 const db=new Database(join(output,"database/kuinest.sqlite"),{readonly:true}),rollback=new Database(join(output,"rollback/kuinest.sqlite"),{readonly:true});
 try{
  const row=db.prepare("SELECT manifest_json FROM context_snapshots WHERE run_id=?").get(resultB.runId) as {manifest_json:string};assert.equal(JSON.parse(row.manifest_json).prepared.expression.version,"project-instructions-v1");
  assert.deepEqual(db.prepare("SELECT logical_name,content,sha256 FROM character_documents WHERE version_id=? AND logical_name<>? ORDER BY logical_name").all(plan.version,expressionDocumentName),rollback.prepare("SELECT logical_name,content,sha256 FROM character_documents ORDER BY logical_name").all());
  assert.deepEqual(db.prepare("SELECT * FROM memory_versions ORDER BY id").all(),rollback.prepare("SELECT * FROM memory_versions ORDER BY id").all());
 }finally{db.close();rollback.close();}
});
test("EX09：模式参数无效或与数据库版本不符均拒绝；CLI显式准备新模式",async()=>{
 const f=sealed(),output=join(f.directory,"trial");
 await assert.rejects(()=>prepareTextTrial(f.source,output,f.sealHash,settings,{...expression,mode:"wrong" as "reference"}),code("TRIAL_EXPRESSION_INVALID"));assert.equal(existsSync(output),false);
 await assert.rejects(()=>textTrialMain(["prepare","--input=D:/not-used","--output=D:/not-used","--seal-sha256="+"0".repeat(64),"--settings-dir=D:/not-used","--expression-mode=project-instructions"]),code("TRIAL_ARGUMENT_INVALID"));
 writeFileSync(join(f.directory,"TRIAL-SETTINGS.json"),JSON.stringify(settings));writeFileSync(join(f.directory,expressionDocumentName),expression.bytes);
 const result=await textTrialMain(["prepare","--input="+f.source,"--output="+output,"--seal-sha256="+f.sealHash,"--settings-dir="+f.directory,"--expression-dir="+f.directory,"--expression-sha256="+expression.sha256,"--expression-mode=project-instructions"]);
 assert.ok("planSha256" in result);assert.equal(textTrialPreflight(output,result.planSha256).config.expressionMode,"project-instructions");
 const file=join(output,"TRIAL-PLAN.json"),plan=JSON.parse(readFileSync(file,"utf8"));plan.config.expressionMode="reference";const bytes=Buffer.from(JSON.stringify(plan));writeFileSync(file,bytes);assert.throws(()=>textTrialPreflight(output,hash(bytes)),code("TRIAL_EXPRESSION_INVALID"));
});
