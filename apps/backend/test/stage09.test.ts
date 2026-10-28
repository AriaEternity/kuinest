import Database from "better-sqlite3";
import {stateHash} from "../../../tools/import-openclaw/dist/ledger.js";
import "./expression-trial.test-support.js";
import "./text-trial.test-support.js";
import "./memory-review.test-support.js";
import "./acceptance-preparation.test-support.js";
import "./review-additions.test-support.js";
import "./fresh-start-import.test-support.js";
import "./catalog-capture.test-support.js";
import "./reasoning-import.test-support.js";
import "./image-import.test-support.js";
import "./image-flow.test-support.js";
import "./image-provider.test-support.js";
import "./image-message.test-support.js";
import "./image-client.test-support.js";
import "./image-http.test-support.js";
import "./image-storage.test-support.js";
import "./image-contract.test-support.js";
import "./image-validation.test-support.js";
import { resolve as resolveContext } from "../dist/context/branches.js";
import type { Entry } from "../dist/context/types.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { appendFileSync, existsSync, readFileSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { capture, loadBundle } from "../../../tools/import-openclaw/dist/capture.js";
import { inspect as inspectBatch } from "../../../tools/import-openclaw/dist/inspect.js";
import { apply, applyTransaction, dryRun, verify } from "../../../tools/import-openclaw/dist/apply.js";
import { analyze } from "../../../tools/import-openclaw/dist/validate.js";
import { parse } from "../../../tools/import-openclaw/dist/parse.js";
import { hash, uid, limits } from "../../../tools/import-openclaw/dist/safe.js";
import { projectRoot } from "../dist/server.js";
import { restoreDatabase } from "../dist/storage/backup.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { loadMigrations } from "../dist/storage/migrations.js";
import { fixture, next, messages, entry, inspect, put, sessionBytes, key } from "./import-fixtures.js";
const code=(name:string)=>(e:unknown)=>(e as {code?:string}).code===name;
const n=(target:string,table:string)=>inspect(target,db=>(db.prepare("SELECT count(*) AS n FROM "+table).get() as {n:number}).n);
test("M01：重复批次不重复消息、协议、记忆或原档",()=>{
  const f=fixture(); f.build(); const first=apply(f.batch,f.target,"owner");
  assert.equal(first.replay,false); assert.equal(apply(f.batch,f.target,"owner").replay,true);
  assert.equal(n(f.target,"messages"),2);assert.equal(n(f.target,"context_entries"),2);
  assert.equal(n(f.target,"memory_versions"),2);assert.equal(n(f.target,"import_objects"),10);
  assert.equal(n(f.target,"import_batches"),1);assert.equal(verify(f.target).records,2);
});
test("M01：同一JSONL追加新回合，稳定ID跨文件哈希保持不变",()=>{
  const f=fixture(),base=f.build();apply(f.batch,f.target,"owner");
  const before=inspect(f.target,db=>db.prepare("SELECT id FROM context_entries ORDER BY id").all());
  const records=[...messages(),entry("u2","a1",{role:"user",content:"第二回合"}),entry("a2","u2",{role:"assistant",content:"第二次回复",reasoning_content:"合成推理"})];
  const delta=next(f,base.manifestHash,records);delta.definition.conversations[0]!.history[0]!.leafId="a2";delta.build();
  apply(delta.batch,f.target,"owner");assert.equal(n(f.target,"messages"),4);assert.equal(n(f.target,"context_entries"),4);assert.equal(n(f.target,"import_batches"),2);
  for(const id of before) assert.ok(inspect(f.target,db=>db.prepare("SELECT id FROM context_entries WHERE id=?").get((id as {id:string}).id)));
  assert.equal(verify(f.target).revision,2);assert.equal(apply(delta.batch,f.target,"owner").replay,true);
});
test("M01：文件原地改写或缩短会拒绝，不覆盖旧条目",()=>{
  for(const records of [messages().slice(0,1),[entry("u1",null,{role:"user",content:"篡改合成历史"}),messages()[1]!]]){
    const f=fixture(),base=f.build();apply(f.batch,f.target,"owner");
    const delta=next(f,base.manifestHash,records);delta.definition.conversations[0]!.history[0]!.leafId=records.at(-1)!.id;delta.build();
    assert.throws(()=>apply(delta.batch,f.target,"owner"),code("SOURCE_REWRITTEN"));assert.equal(n(f.target,"import_batches"),1);
  }
});
test("M01：错误前序批次、revision或来源拒绝",()=>{
  for(const fault of ["parent","revision","source"]){
    const f=fixture(),base=f.build();apply(f.batch,f.target,"owner");const delta=next(f,base.manifestHash);
    if(fault==="parent")delta.definition.parent="0".repeat(64);
    if(fault==="revision")delta.definition.revision=3;
    if(fault==="source")delta.definition.sourceId=randomUUID();
    delta.build();assert.throws(()=>apply(delta.batch,f.target,"owner"));assert.equal(verify(f.target).revision,1);
  }
});
test("M01：记忆改动产生新版本，旧版保留，重复内容不再版本化",()=>{
  const f=fixture(),base=f.build();apply(f.batch,f.target,"owner");const delta=next(f,base.manifestHash);
  put(f.input,"workspace/memory/synthetic.md","新的合成记忆");delta.build();apply(delta.batch,f.target,"owner");
  assert.equal(n(f.target,"memory_versions"),3);assert.equal(n(f.target,"memory_heads"),2);
  assert.equal(inspect(f.target,db=>(db.prepare("SELECT count(*) AS n FROM memory_versions WHERE parent_id IS NOT NULL").get() as {n:number}).n),1);
});
test("M02：不同会话使用相同局部ID不冲突，显式轮换保留两段显示历史",()=>{
  const f=fixture(),base=f.build();apply(f.batch,f.target,"owner");const delta=next(f,base.manifestHash),second=randomUUID();
  delta.definition.files.push({path:"sessions/"+second+".jsonl",kind:"session"});
  delta.definition.conversations[0]!.history.push({sessionId:second,leafId:"a1"});
  put(f.input,"sessions/"+second+".jsonl",sessionBytes(second));
  put(f.input,"sessions/sessions.json",JSON.stringify({[key]:{sessionId:second}}));
  delta.build();apply(delta.batch,f.target,"owner");
  assert.equal(n(f.target,"context_entries"),4);assert.equal(n(f.target,"messages"),4);assert.equal(n(f.target,"conversations"),1);
});
test("M03：缺失父节点、环和重复ID全部拒绝",()=>{
  for(const [records,error] of [
    [[entry("u","absent",{role:"user",content:"x"})],"PARENT_MISSING"],
    [[entry("u","a",{role:"user",content:"x"}),entry("a","u",{role:"assistant",content:"x"})],"PARENT_CYCLE"],
    [[...messages(),messages()[0]!],"ENTRY_INVALID"]
  ] as const)assert.throws(()=>parse(Buffer.from(sessionBytes("synthetic-session",[...records]))),code(error));
});
test("M03：未知条目完整进入隔离原档，阻止应用",()=>{
  const f=fixture();put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,[...messages(),{type:"future-secret-type",id:"x",parentId:"a1",timestamp:"2026-09-11T00:00:00Z",payload:"合成未知正文"}]));
  f.definition.conversations[0]!.history[0]!.leafId="x";f.build();
  const out=join(f.directory,"dry");const result=dryRun(f.batch,out);
  assert.ok(result.gaps.includes("UNKNOWN_ENTRY"));assert.equal(result.applied,false);assert.equal(existsSync(join(out,"candidate")),false);
  assert.ok(readFileSync(join(out,"sessions",f.sessionId+".jsonl")).equals(readFileSync(join(f.batch,"sessions",f.sessionId+".jsonl"))));
  assert.throws(()=>apply(f.batch,f.target,"owner"),code("COMPATIBILITY_GAPS"));assert.equal(n(f.target,"characters"),0);
});
test("M03：活动分支投影排除旁支，旁支原协议仍完整保存",()=>{
  const f=fixture();const records=[...messages(),entry("other","u1",{role:"assistant",content:"旁支",reasoning_content:"合成"})];
  put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));f.build();apply(f.batch,f.target,"owner");
  assert.equal(n(f.target,"context_entries"),3);assert.equal(n(f.target,"messages"),2);
  assert.equal(inspect(f.target,db=>db.prepare("SELECT 1 FROM messages WHERE content='旁支'").get()),undefined);
});
test("M03：活动叶必须存在，索引不得与显式映射冲突",()=>{
  for(const fault of ["leaf","index"]){
    const f=fixture();if(fault==="leaf")f.definition.conversations[0]!.history[0]!.leafId="missing";
    else put(f.input,"sessions/sessions.json",JSON.stringify({[key]:{sessionId:"other"}}));
    f.build();assert.throws(()=>inspectBatch(f.batch),code(fault==="leaf"?"LEAF_MISSING":"INDEX_MAPPING_MISMATCH"));
  }
});
test("M03：压缩摘要保留来源前缀和首个保留项，使用后端上下文重建检查",()=>{
  const f=fixture(),records=[...messages(),entry("u2","a1",{role:"user",content:"新话题"}),entry("a2","u2",{role:"assistant",content:"新回复",reasoning_content:"合成"}),
    {type:"compaction",id:"compact",parentId:"a2",timestamp:"2026-09-11T00:00:00Z",summary:"合成摘要",firstKeptEntryId:"u2",tokensBefore:123}];
  put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));f.definition.conversations[0]!.history[0]!.leafId="compact";f.build();
  assert.deepEqual(inspectBatch(f.batch).gaps,[]);apply(f.batch,f.target,"owner");assert.equal(n(f.target,"context_entries"),5);
});
test("M03：custom_message即使display=false仍进入上下文",()=>{
  const f=fixture();put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,[...messages(),{type:"custom_message",id:"custom",parentId:"a1",timestamp:"2026-09-11T00:00:00Z",content:"合成参考",display:false}]));
  f.definition.conversations[0]!.history[0]!.leafId="custom";f.build();apply(f.batch,f.target,"owner");
  assert.equal(inspect(f.target,db=>(db.prepare("SELECT payload_json FROM context_entries WHERE kind='custom_message'").get() as {payload_json:string}).payload_json),JSON.stringify({text:"合成参考",includeInContext:true}));
});
test("M04：错agent、越界路径、私密配置路径和重复逻辑路径拒绝",()=>{
  for(const fault of ["agent","escape","config","duplicate"]){
    const f=fixture();
    if(fault==="agent")(f.definition as {agentId:string}).agentId="neko";
    if(fault==="escape")f.definition.files.push({path:"../private/secret",kind:"document"});
    if(fault==="config")f.definition.files.push({path:"openclaw.json",kind:"document"});
    if(fault==="duplicate")f.definition.files.push(f.definition.files[0]!);
    assert.throws(()=>f.build());assert.equal(existsSync(f.batch),false);
  }
});
test("M04：符号链接目录与硬链接文件拒绝读取",()=>{
  const f=fixture();const alias=join(f.directory,"alias");symlinkSync(f.input,alias,process.platform==="win32"?"junction":"dir");
  assert.throws(()=>capture(alias,f.batch,f.definition));
  linkSync(join(f.input,"workspace","SOUL.md"),join(f.directory,"hardlink"));assert.throws(()=>f.build());
});
test("M04：只读取明确清单，未授权文件不进入批次",()=>{
  const f=fixture();put(f.input,"openclaw.json","SYNTHETIC_CREDENTIAL_SENTINEL");f.build();
  assert.equal(existsSync(join(f.batch,"openclaw.json")),false);assert.equal(inspectBatch(f.batch).files,10);
});
test("M05：工具调用、reasoning和结果可恢复为后台协议",()=>{
  const f=fixture(),records=[messages()[0]!,entry("call","u1",{role:"assistant",content:[{type:"thinking",thinking:"合成思考"},{type:"toolCall",id:"call_1",name:"clock_now",arguments:{}}],stopReason:"toolUse"}),
    entry("result","call",{role:"toolResult",toolCallId:"call_1",content:[{type:"text",text:"合成时间"}]}),
    entry("final","result",{role:"assistant",content:"完成",reasoning_content:"合成思考"})];
  put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));f.definition.conversations[0]!.history[0]!.leafId="final";f.build();
  assert.deepEqual(inspectBatch(f.batch).gaps,[]);apply(f.batch,f.target,"owner");assert.equal(n(f.target,"context_entries"),4);assert.equal(n(f.target,"messages"),2);
});
test("M05：缺reasoning、工具结果和未知图片块不会静默丢弃",()=>{
  for(const fault of ["reasoning","tool","image"]){
    const f=fixture();let records=messages();
    if(fault==="reasoning")records[1]=entry("a1","u1",{role:"assistant",content:"缺少思考"});
    if(fault==="tool")records[1]=entry("a1","u1",{role:"assistant",content:"",reasoning_content:"合成",tool_calls:[{id:"call_1",type:"function",function:{name:"clock_now",arguments:"{}"}}]});
    if(fault==="image")records[0]=entry("u1",null,{role:"user",content:[{type:"image",data:"SYNTHETIC",mimeType:"image/png"}]});
    put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));f.build();
    assert.equal(inspectBatch(f.batch).applicable,false);assert.throws(()=>apply(f.batch,f.target,"owner"),code("COMPATIBILITY_GAPS"));
  }
});
test("M06：原档哈希覆盖全部文件，文件篡改在接触目标前拒绝",()=>{
  const f=fixture();f.build();appendFileSync(join(f.batch,"workspace","SOUL.md"),"x");
  assert.throws(()=>apply(f.batch,f.target,"owner"),code("HASH_MISMATCH"));assert.equal(n(f.target,"import_batches"),0);
});
test("M06：严格UTF8、损坏JSONL及16MiB记录限额明确失败",()=>{
  assert.throws(()=>parse(Buffer.from([255])),code("UTF8_INVALID"));
  assert.throws(()=>parse(Buffer.from("{bad}\n")),code("JSON_INVALID"));
  assert.throws(()=>parse(Buffer.from("x".repeat(limits.record+1))),code("RECORD_LIMIT"));
});
test("M06：拷贝和dry-run使用新目录，拒绝覆盖",()=>{
  const f=fixture();f.build();assert.throws(()=>f.build());const out=join(f.directory,"dry");
  const result=dryRun(f.batch,out);assert.equal(result.applied,true);assert.equal(verify(join(out,"candidate")).records,2);
  assert.throws(()=>dryRun(f.batch,out));
});
test("M06：应用中途SQL错误整批回滚",()=>{
  const f=fixture();f.build();inspect(f.target,db=>db.exec("CREATE TRIGGER synthetic_reject BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'synthetic'); END;"));
  assert.throws(()=>apply(f.batch,f.target,"owner"));
  for(const table of ["import_sources","import_objects","import_batches","characters","context_entries","memory_versions"])assert.equal(n(f.target,table),0);
});
test("M06：正在运行的服务租约拒绝导入，停止后可应用",async t=>{
  const f=fixture();f.build();const storage=new SqliteStorage({dataRoot:f.target,instanceId:randomUUID(),clock:{now:Date.now}});t.after(()=>storage.close());
  assert.throws(()=>apply(f.batch,f.target,"owner"),code("LEASE_BUSY"));assert.equal(n(f.target,"characters"),0);
  await storage.close();assert.equal(apply(f.batch,f.target,"owner").applied,true);
});
test("M07：导入成功仍不自动激活角色、任务或签署连续性验收",()=>{
  const f=fixture();f.build();const r=apply(f.batch,f.target,"owner");
  assert.equal(r.activated,false);assert.equal(r.continuity,"user_acceptance_pending");
  assert.equal(inspect(f.target,db=>(db.prepare("SELECT active_version_id FROM characters").get() as {active_version_id:null}).active_version_id),null);assert.equal(n(f.target,"scheduled_tasks"),0);
});
test("M08：目标新增记忆或修改角色后拒绝旧源增量，新增经历保留",()=>{
  for(const fault of ["memory","character"]){
    const f=fixture(),base=f.build();apply(f.batch,f.target,"owner");const delta=next(f,base.manifestHash);delta.build();
    inspect(f.target,db=>{if(fault==="memory")db.exec("UPDATE memory_versions SET content='本地新经历' WHERE logical_key='MEMORY.md'");else db.exec("UPDATE characters SET name='用户已编辑'");});
    assert.throws(()=>apply(delta.batch,f.target,"owner"),code("TARGET_DIVERGED"));assert.equal(n(f.target,"import_batches"),1);
  }
});
test("M08：回退用新目录恢复，保留全部导入原档与后续记忆，不覆盖原库",async()=>{
  const f=fixture();f.build();apply(f.batch,f.target,"owner");
  const archive=join(f.directory,"rollback.sqlite");
  inspect(f.target,db=>db.exec("UPDATE memory_versions SET content='切换后新经历' WHERE logical_key='MEMORY.md'"));
  const {openDatabase}=await import("../dist/storage/database.js");const db=openDatabase(f.target,true);
  try { await db.backup(archive); } finally { db.close(); }
  const restored=join(f.directory,"restored");await restoreDatabase(archive,restored,Date.now());
  assert.equal(n(restored,"import_objects"),10);
  assert.equal(inspect(restored,db=>(db.prepare("SELECT content FROM memory_versions WHERE logical_key='MEMORY.md'").get() as {content:string}).content),"切换后新经历");
  assert.equal(n(f.target,"import_objects"),10);assert.throws(()=>verify(restored),code("TARGET_DIVERGED"));
});
test("M06：CLI成功及异常只打印固定字段，不回显私人哨兵或路径",()=>{
  const f=fixture();f.build();const run=(...args:string[])=>spawnSync(process.execPath,["tools/import-openclaw/dist/cli.js",...args],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:15000});
  const good=run("inspect","--input="+f.batch);assert.equal(good.status,0,good.stderr);assert.equal(JSON.parse(good.stdout).records,2);
  const bad=run("inspect","--input="+join(f.directory,"SYNTHETIC_PRIVATE_SENTINEL"));assert.equal(bad.status,1);assert.doesNotMatch(bad.stdout+bad.stderr,/SYNTHETIC_PRIVATE_SENTINEL|[A-Z]:\\|Error:|at /);
  put(f.batch,"manifest.json","{\"secret\":\"SYNTHETIC_CONTENT_SENTINEL\"}");
  const malformed=run("validate","--batch="+f.batch);assert.equal(malformed.status,1);assert.doesNotMatch(malformed.stdout+malformed.stderr,/SYNTHETIC_CONTENT_SENTINEL/);
});
test("M06：已存在角色的目标不能被首次导入覆盖",()=>{
  const f=fixture();f.build();inspect(f.target,db=>db.exec("INSERT INTO characters VALUES ('existing','owner','已有角色',NULL,1)"));
  assert.throws(()=>apply(f.batch,f.target,"owner"),code("TARGET_NOT_EMPTY"));assert.equal(n(f.target,"characters"),1);
});
test("M06：初始迁移脚本保持原哈希，新增账本只在第二个迁移",()=>{
  assert.equal(hash(readFileSync(join(projectRoot,"apps/backend/schema/001-initial.sql"))),"d4b3c32bff3c1722d47b129c91aba7b7ac9af604bf09ff581adebb84f97ce351");
  assert.deepEqual(loadMigrations().map(m=>m.version),[1,2,3,4,5,6]);
});
test("M04：原档文件缩小/删除不能通过省略清单绕开增量检查",()=>{
  const f=fixture(),base=f.build();apply(f.batch,f.target,"owner");const delta=next(f,base.manifestHash);
  delta.definition.files=delta.definition.files.filter(f=>f.kind!=="memory");delta.build();
  assert.throws(()=>apply(delta.batch,f.target,"owner"),code("SOURCE_FILE_REMOVED"));assert.equal(verify(f.target).revision,1);
});
test("M06：同一批次ID换清单拒绝，不重写状态",()=>{
  const f=fixture();f.build();apply(f.batch,f.target,"owner");
  const other=join(f.directory,"other");
  f.definition.config.timezone="Asia/Shanghai";capture(f.input,other,f.definition);
  assert.throws(()=>apply(other,f.target,"owner"),code("BATCH_CONFLICT"));assert.equal(verify(f.target).revision,1);
});

test("M06：复制过程中来源变化则放弃，不发布完成清单",()=>{
  const f=fixture();let reads=0;
  const readFile=(root:string,path:string)=>{
    const bytes=readFileSync(join(root,path));
    if(++reads===f.definition.files.length)put(f.input,"workspace/SOUL.md","合成并发更新");
    return bytes;
  };
  assert.throws(()=>capture(f.input,f.batch,f.definition,readFile),code("SOURCE_CHANGED"));
  assert.equal(existsSync(join(f.batch,"manifest.json")),false);
});
test("M06：CLI capture、validate、dry-run、apply及verify实际可执行",()=>{
  const f=fixture();put(f.input,"scope.json",JSON.stringify(f.definition));
  const run=(...args:string[])=>spawnSync(process.execPath,["tools/import-openclaw/dist/cli.js",...args],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:15000});
  for(const args of [
    ["capture","--input="+f.input,"--output="+f.batch],
    ["validate","--batch="+f.batch],
    ["dry-run","--input="+f.batch,"--output="+join(f.directory,"dry")],
    ["apply","--batch="+f.batch,"--target="+f.target,"--owner=owner"],
    ["verify","--target="+f.target]
  ]) { const result=run(...args);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ok,true); }
  assert.equal(run("apply","--batch="+f.batch,"--target="+f.target,"--owner=owner","--password=synthetic").status,1);
});
test("M03：重选离线活动分支重建可见顺序，不删除旁支协议",()=>{
  const f=fixture();
  const records=[...messages(),entry("other","u1",{role:"assistant",content:"新旁支",reasoning_content:"合成"})];
  put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));
  const base=f.build();apply(f.batch,f.target,"owner");
  const delta=next(f,base.manifestHash,records);delta.definition.conversations[0]!.history[0]!.leafId="other";delta.build();
  apply(delta.batch,f.target,"owner");
  assert.equal(n(f.target,"context_entries"),3);
  assert.deepEqual(inspect(f.target,db=>db.prepare("SELECT content FROM messages WHERE visibility='visible' ORDER BY seq").all()),[{content:"合成测试：蓝色纸船。"},{content:"新旁支"}]);
});
test("M06：增量dry-run保留完整隔离批次，明确提示需要前序候选库",()=>{
  const f=fixture(),base=f.build();const delta=next(f,base.manifestHash);delta.build();
  const result=dryRun(delta.batch,join(f.directory,"dry"));
  assert.equal(result.applied,false);assert.equal("needsPreviousCandidate" in result && result.needsPreviousCandidate,true);
});
test("M06：原档可从候选库逐字节取得，不依赖OpenClaw安装和原始目录",()=>{
  const f=fixture(),bundle=f.build();apply(f.batch,f.target,"owner");
  inspect(f.target,db=>{
    for(const item of bundle.manifest.files){
      const row=db.prepare("SELECT content FROM import_objects WHERE source_id=? AND path=? AND sha256=?").get(bundle.manifest.sourceId,item.path,item.sha256) as {content:Buffer};
      assert.ok(row.content.equals(bundle.files.get(item.path)!));
    }
  });
});

import "./source-import.test-support.js";


test("M05：已核实的reasoning_content标记还原字段，思考与原档逐字保留",()=>{
  const f=fixture(),thought="  合成思考🙂\n保留前后空白。  ";
  const records=[messages()[0]!,entry("a1","u1",{role:"assistant",api:"openai-completions",content:[
    {type:"thinking",thinking:thought,thinkingSignature:"reasoning_content"},{type:"text",text:"合成公开答复"}
  ],stopReason:"stop"})];
  const source=sessionBytes(f.sessionId,records);put(f.input,"sessions/"+f.sessionId+".jsonl",source);f.build();
  assert.deepEqual(inspectBatch(f.batch).gaps,[]);apply(f.batch,f.target,"owner");
  const payload=inspect(f.target,db=>(db.prepare("SELECT payload_json FROM context_entries WHERE id=?").get(uid(f.definition.sourceId,"main",f.sessionId,"a1")) as {payload_json:string}).payload_json);
  assert.equal(JSON.parse(payload).reasoning_content,thought);
  assert.deepEqual(inspect(f.target,db=>db.prepare("SELECT content FROM messages WHERE role='assistant'").all()),[{content:"合成公开答复"}]);
  const original=inspect(f.target,db=>(db.prepare("SELECT content FROM import_objects WHERE path=?").get("sessions/"+f.sessionId+".jsonl") as {content:Buffer}).content);
  assert.ok(original.equals(Buffer.from(source)));assert.equal(verify(f.target).records,2);
});
test("M05：同名标记在其他API、脱敏块或未知签名中不能被白名单放行",()=>{
  const variants=[
    {api:"anthropic-messages",signature:"reasoning_content"},{api:"openai-responses",signature:"reasoning_content"},
    {api:undefined,signature:"reasoning_content"},{api:"openai-completions",signature:"SYNTHETIC_OPAQUE"},
    {api:"openai-completions",signature:"reasoning"},{api:"openai-completions",signature:"reasoning_content",redacted:true},
    {api:"openai-completions",signature:undefined,redacted:true}
  ];
  for(const v of variants){
    const f=fixture(),block={type:"thinking",thinking:"合成私有思考",thinkingSignature:v.signature,...("redacted" in v?{redacted:v.redacted}:{})};
    put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,[messages()[0]!,entry("a1","u1",{role:"assistant",api:v.api,content:[block,{type:"text",text:"合成答复"}]})]));f.build();
    assert.ok(inspectBatch(f.batch).gaps.includes("THINKING_SIGNATURE_UNSUPPORTED"));assert.throws(()=>apply(f.batch,f.target,"owner"),code("COMPATIBILITY_GAPS"));
  }
});
test("M05：多个思考块或双来源字段必须先核实合并语义，不静默拼接通过",()=>{
  for(const fault of ["multiple","dual"]){
    const f=fixture(),block={type:"thinking",thinking:"合成思考",thinkingSignature:"reasoning_content"};
    const message={role:"assistant",api:"openai-completions",content:[block,...(fault==="multiple"?[{...block,thinking:"第二段合成思考"}]:[]),{type:"text",text:"合成答复"}],
      ...(fault==="dual"?{reasoning_content:"另一份合成思考"}:{})};
    put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,[messages()[0]!,entry("a1","u1",message)]));f.build();
    assert.ok(inspectBatch(f.batch).gaps.includes("REASONING_AMBIGUOUS"));assert.throws(()=>apply(f.batch,f.target,"owner"),code("COMPATIBILITY_GAPS"));
  }
});
test("M05：标记不能补齐不存在的思考正文",()=>{
  const f=fixture();put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,[messages()[0]!,entry("a1","u1",{
    role:"assistant",api:"openai-completions",content:[{type:"thinking",thinking:"",thinkingSignature:"reasoning_content"},{type:"text",text:"合成答复"}]
  })]));f.build();const gaps=inspectBatch(f.batch).gaps;
  assert.ok(gaps.includes("REASONING_MISSING"));assert.equal(gaps.includes("THINKING_SIGNATURE_UNSUPPORTED"),false);
});

test("M01：增量新增中文记忆保留原名和内容，重复批次不重复版本",()=>{
  const f=fixture(),base=f.build();apply(f.batch,f.target,"owner");
  const delta=next(f,base.manifestHash),key="memory/合成中文日记.md";
  delta.definition.files.push({path:"workspace/"+key,kind:"memory"});delta.definition.config.memoryReadKeys.push(key);
  put(f.input,"workspace/"+key,"纯合成的新记忆。");delta.build();apply(delta.batch,f.target,"owner");
  const row=inspect(f.target,db=>db.prepare("SELECT logical_key,content FROM memory_versions WHERE logical_key=?").get(key));
  assert.deepEqual(row,{logical_key:key,content:"纯合成的新记忆。"});const count=n(f.target,"memory_versions");
  assert.equal(apply(delta.batch,f.target,"owner").replay,true);assert.equal(n(f.target,"memory_versions"),count);assert.equal(verify(f.target).revision,2);
});

test("M05：中断回复保留原档和公开partial，后续模型上下文排除原思考与残文",()=>{
  for(const stopReason of ["error","aborted"]){
    const f=fixture(),thought="  SYNTHETIC_INTERRUPTED_THOUGHT  ";
    const records=[messages()[0]!,entry("p","u1",{role:"assistant",api:"openai-completions",stopReason,content:[
      {type:"thinking",thinking:thought,thinkingSignature:"reasoning_content"},{type:"text",text:"合成未完回复"}
    ]}),entry("u2","p",{role:"user",content:"合成后续输入"}),entry("a1","u2",{role:"assistant",content:"合成完整回答",reasoning_content:"合成"})];
    const original=sessionBytes(f.sessionId,records);put(f.input,"sessions/"+f.sessionId+".jsonl",original);f.build();
    assert.deepEqual(inspectBatch(f.batch).gaps,[]);apply(f.batch,f.target,"owner");
    const partialId=uid(f.definition.sourceId,"main",f.sessionId,"p");
    inspect(f.target,db=>{
      assert.deepEqual(db.prepare("SELECT content,status FROM messages WHERE role='assistant' ORDER BY seq").all(),[
        {content:"合成未完回复",status:"partial"},{content:"合成完整回答",status:"complete"}]);
      const entries=(db.prepare("SELECT id,parent_id AS parentId,branch_id AS branchId,kind,payload_json FROM context_entries").all() as (Entry&{payload_json:string})[]).map(e=>({...e,payload:JSON.parse(e.payload_json)}));
      const p=entries.find(e=>e.id===partialId)!;assert.equal(p.kind,"custom");
      assert.equal((p.payload as {message:{reasoning_content:string}}).message.reasoning_content,thought);
      const selected=resolveContext(entries,uid(f.definition.sourceId,"main",f.sessionId,"a1"));
      assert.ok(selected.ignored.includes(partialId));assert.equal(selected.selected.length,3);
      assert.doesNotMatch(JSON.stringify(selected.selected),/SYNTHETIC_INTERRUPTED|合成未完/);
      const raw=db.prepare("SELECT content FROM import_objects WHERE path=?").get("sessions/"+f.sessionId+".jsonl") as {content:Buffer};
      assert.ok(raw.content.equals(Buffer.from(original)));
    });assert.equal(verify(f.target).records,4);
  }
});
test("M05：空中断或仅思考中断不生成空气泡，也不补造reasoning",()=>{
  for(const content of [[],null,[{type:"thinking",thinking:"SYNTHETIC_ONLY_THOUGHT",thinkingSignature:"reasoning_content"}]]){
    const f=fixture(),records=[messages()[0]!,entry("p","u1",{role:"assistant",api:"openai-completions",stopReason:"aborted",content}),
      entry("a1","p",{role:"assistant",content:"合成完成",reasoning_content:"合成"})];
    put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));f.build();assert.deepEqual(inspectBatch(f.batch).gaps,[]);
    apply(f.batch,f.target,"owner");assert.equal(n(f.target,"context_entries"),3);assert.equal(n(f.target,"messages"),2);assert.equal(verify(f.target).records,3);
  }
});
test("M05：其他API、长度终止或工具调用不能套用已核实的中断排除规则",()=>{
  for(const override of [{api:"anthropic-messages"},{api:undefined},{stopReason:"length"},
    {content:[{type:"toolCall",id:"synthetic_tool",name:"fake",arguments:{}}]},
    {tool_calls:[{id:"synthetic_tool",type:"function",function:{name:"fake",arguments:"{}"}}]}]){
    const f=fixture(),message={role:"assistant",api:"openai-completions",stopReason:"aborted",content:"合成部分",...override};
    put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,[messages()[0]!,entry("a1","u1",message)]));f.build();
    assert.ok(inspectBatch(f.batch).gaps.includes("ASSISTANT_INCOMPLETE"));assert.throws(()=>apply(f.batch,f.target,"owner"),code("COMPATIBILITY_GAPS"));
  }
});
test("M05：中断状态不掩盖图片、未知块、坏文本或未支持签名",()=>{
  for(const content of [[{type:"image",mimeType:"image/png",data:"SYNTHETIC_IMAGE"}],[{type:"SYNTHETIC_UNKNOWN",value:"SYNTHETIC_BODY"}],
    [{type:"text",text:12}],[{type:"thinking",thinking:"SYNTHETIC_THOUGHT",thinkingSignature:"SYNTHETIC_SIGNATURE"}]]){
    const f=fixture();put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,[messages()[0]!,entry("a1","u1",{
      role:"assistant",api:"openai-completions",stopReason:"aborted",content
    })]));f.build();assert.ok(inspectBatch(f.batch).gaps.length);assert.throws(()=>apply(f.batch,f.target,"owner"),code("COMPATIBILITY_GAPS"));
  }
});
test("M01：中断后增量导入保持旧partial身份和状态，重复批次不复制",()=>{
  const f=fixture(),records=[messages()[0]!,entry("a1","u1",{role:"assistant",api:"openai-completions",stopReason:"aborted",content:"合成部分"})];
  put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));const base=f.build();apply(f.batch,f.target,"owner");
  const before=inspect(f.target,db=>db.prepare("SELECT id,content,status FROM messages WHERE role='assistant'").get());
  const delta=next(f,base.manifestHash,[...records,entry("u2","a1",{role:"user",content:"合成下一轮"}),entry("a2","u2",{role:"assistant",content:"合成完成",reasoning_content:"合成"})]);
  delta.definition.conversations[0]!.history[0]!.leafId="a2";delta.build();apply(delta.batch,f.target,"owner");
  assert.deepEqual(inspect(f.target,db=>db.prepare("SELECT id,content,status FROM messages WHERE role='assistant' AND status='partial'").get()),before);
  assert.equal(apply(delta.batch,f.target,"owner").replay,true);assert.equal(n(f.target,"messages"),4);assert.equal(verify(f.target).records,4);
});

test("M05：排除中断不能掩盖其打断工具配对的原始异常，也不补造工具结果",()=>{
  const f=fixture(),records=[messages()[0]!,
    entry("tc","u1",{role:"assistant",reasoning_content:"合成",tool_calls:[{id:"tool_one",type:"function",function:{name:"fake",arguments:"{}"}}],content:null}),
    entry("p","tc",{role:"assistant",api:"openai-completions",stopReason:"aborted",content:"合成中断"}),
    entry("tr","p",{role:"toolResult",toolCallId:"tool_one",content:"合成工具结果"}),
    entry("a1","tr",{role:"assistant",content:"合成完成",reasoning_content:"合成"})];
  put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));f.build();
  assert.ok(inspectBatch(f.batch).gaps.includes("CONTEXT_OR_PROTOCOL_INVALID"));assert.throws(()=>apply(f.batch,f.target,"owner"),code("COMPATIBILITY_GAPS"));
  assert.equal(n(f.target,"context_entries"),0);assert.equal(n(f.target,"tool_calls"),0);
});

test("M05：Responses经已核实的共同变换排除空或文本中断，来源API仍保留",()=>{
  for(const content of [[],[{type:"text",text:"合成Responses残文"}]]){
    const f=fixture();put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,[messages()[0]!,entry("a1","u1",{
      role:"assistant",api:"openai-responses",stopReason:"aborted",content
    })]));f.build();assert.deepEqual(inspectBatch(f.batch).gaps,[]);apply(f.batch,f.target,"owner");
    const row=inspect(f.target,db=>db.prepare("SELECT payload_json FROM context_entries WHERE kind='custom'").get()) as {payload_json:string};
    assert.equal(JSON.parse(row.payload_json).sourceApi,"openai-responses");
    assert.equal(n(f.target,"messages"),content.length?2:1);assert.equal(verify(f.target).records,2);
  }
});


test("M06.1：schema6的NULL删除列保持旧封存摘要，实际删除仍可检出",()=>{
 const db=new Database(":memory:");
 try{
  const migrations=loadMigrations();for(const item of migrations.slice(0,5))db.exec(item.sql);
  db.prepare("INSERT INTO owners VALUES (?,?,?,?)").run("synthetic-owner","synthetic-owner","!",0);
  db.prepare("INSERT INTO characters(id,owner_id,name,active_version_id,created_at) VALUES (?,?,?,?,?)").run("synthetic-character","synthetic-owner","合成",null,0);
  db.prepare("INSERT INTO conversations(id,owner_id,character_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("synthetic-conversation","synthetic-owner","synthetic-character","合成",0,0);
  const before=stateHash(db);db.exec(migrations[5]!.sql);assert.equal(stateHash(db),before);
  db.prepare("UPDATE conversations SET deleted_at=1 WHERE id=?").run("synthetic-conversation");assert.notEqual(stateHash(db),before);
 }finally{db.close();}
});
