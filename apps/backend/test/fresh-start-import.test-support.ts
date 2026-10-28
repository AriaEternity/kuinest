import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { capture } from "../../../tools/import-openclaw/dist/capture.js";
import { apply, dryRun, verify } from "../../../tools/import-openclaw/dist/apply.js";
import { inspect as inspectBatch } from "../../../tools/import-openclaw/dist/inspect.js";
import { stateHash } from "../../../tools/import-openclaw/dist/ledger.js";
import { hash, uid } from "../../../tools/import-openclaw/dist/safe.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { memoryRows } from "../dist/storage/context-records.js";
import { compile } from "../dist/context/compiler.js";
import { loadConfig } from "../dist/config.js";
import { projectRoot } from "../dist/server.js";
import { submission } from "../dist/conversations/submit.js";
import { fixture, inspect, put, key } from "./import-fixtures.js";
import type { Scope } from "../../../tools/import-openclaw/dist/types.js";
const code=(name:string)=>(e:unknown)=>(e as {code?:string}).code===name;
const memoryPath="workspace/memory/synthetic.md";
function fresh() {
  const f=fixture();
  f.definition.migrationMode="fresh-start-v1";
  f.definition.requireReasoning=false;
  f.definition.conversations=[{key,history:[]}];
  return f;
}
function delta(f:ReturnType<typeof fresh>,previous:ReturnType<typeof capture>,edit:(s:Scope)=>void=()=>{}) {
  const definition:Scope={...structuredClone(previous.manifest),files:previous.manifest.files.map(({path,kind})=>({path,kind})),
    batchId:randomUUID(),revision:previous.manifest.revision+1,parent:previous.manifestHash};
  // scope只接受未封存字段；不把上一批的收件时点冒充本批观测。
  delete (definition as unknown as Record<string,unknown>).consistency;
  delete (definition as unknown as Record<string,unknown>).capturedAt;
  delete definition.removedMemories;
  edit(definition);
  const batch=join(f.directory,"delta-"+definition.revision+"-"+randomUUID());
  return {definition,batch,build:()=>capture(f.input,batch,definition)};
}
const count=(target:string,table:string)=>inspect(target,db=>(db.prepare("SELECT count(*) AS n FROM "+table).get() as {n:number}).n);
function activate(f:ReturnType<typeof fresh>,t:{after(fn:()=>Promise<void>):void}) {
  const storage=new SqliteStorage({dataRoot:f.target,instanceId:randomUUID(),clock:{now:Date.now}});
  t.after(()=>storage.close());
  const character=uid(f.definition.sourceId,"character");
  const version=inspect(f.target,db=>(db.prepare("SELECT id FROM character_versions ORDER BY rowid DESC LIMIT 1").get() as {id:string}).id);
  storage.characterAccess().activate("owner",character,version);
  return {storage,character};
}

test("FS01：旧协议、摘要、图片和任务只存原档，新分支保持为空",()=>{
  const f=fresh(),path="sessions/"+f.sessionId+".jsonl";
  const archive=Buffer.from([255,0,1,2]); put(f.input,path,archive);
  put(f.input,"sessions/sessions.json","SYNTHETIC_OLD_INDEX_NOT_PARSED");
  put(f.input,"tasks/jobs.json","SYNTHETIC_OLD_TASK_NOT_EXECUTED");f.definition.files.push({path:"tasks/jobs.json",kind:"tasks"});
  f.build();const summary=inspectBatch(f.batch);
  assert.equal(summary.migrationMode,"fresh-start-v1");assert.equal(summary.historyRestored,false);assert.equal(summary.archivedSessionFiles,1);
  const result=apply(f.batch,f.target,"owner");assert.equal(result.applied,true);assert.equal(result.activated,false);
  for(const table of ["context_entries","messages","import_record_map","image_assets","scheduled_tasks"]) assert.equal(count(f.target,table),0);
  inspect(f.target,db=>{
    assert.deepEqual(db.prepare("SELECT head_entry_id,parent_branch_id FROM branches").get(),{head_entry_id:null,parent_branch_id:null});
    assert.equal((db.prepare("SELECT active_version_id FROM characters").get() as {active_version_id:null}).active_version_id,null);
    assert.ok((db.prepare("SELECT content FROM import_objects WHERE path=?").get(path) as {content:Buffer}).content.equals(archive));
  });
  assert.equal(verify(f.target).records,0);assert.equal(apply(f.batch,f.target,"owner").replay,true);
});

test("FS02：首轮实际编排保留人设和可检索记忆，旧原档不会进入新窗口",t=>{
  const f=fresh();put(f.input,"workspace/SOUL.md","SYNTHETIC_PERSONA");
  put(f.input,"workspace/MEMORY.md","SYNTHETIC_BASE_MEMORY");
  put(f.input,memoryPath,"纸船 SYNTHETIC_RETRIEVED_MEMORY");
  put(f.input,"sessions/"+f.sessionId+".jsonl","SYNTHETIC_OLD_CHAT_AND_SUMMARY");
  f.build();apply(f.batch,f.target,"owner");const {storage,character}=activate(f,t),ids={next:randomUUID};
  const limits=loadConfig({NODE_ENV:"development",APP_MODE:"synthetic"},projectRoot).limits;
  const store=storage.runAccess({context:true}),conversation=uid(f.definition.sourceId,key);
  store.submit("owner",conversation,submission({clientMessageId:randomUUID(),text:"纸船"}),Date.now(),ids,limits);
  const first=store.claim(Date.now(),ids)!,out=compile(storage.contextAccess().load(first),[]);
  assert.match(out.request.system,/SYNTHETIC_PERSONA/);assert.match(out.request.system,/SYNTHETIC_BASE_MEMORY/);
  assert.match(out.request.system,/SYNTHETIC_RETRIEVED_MEMORY/);assert.doesNotMatch(JSON.stringify(out.request),/SYNTHETIC_OLD_CHAT/);
  assert.deepEqual(out.request.messages.map(m=>m.content),["纸船"]);assert.equal(out.manifest.summaryEntryId,null);
  store.finish(first,"failed","RUN_INTERRUPTED",Date.now(),ids);
  const second=randomUUID();storage.write("owner",repo=>repo.createConversation(second,character,"另一个合成新窗口",Date.now()));
  store.submit("owner",second,submission({clientMessageId:randomUUID(),text:"新窗口里的纸船"}),Date.now(),ids,limits);
  const claim=store.claim(Date.now(),ids)!,next=compile(storage.contextAccess().load(claim),[]);
  assert.deepEqual(next.request.messages.map(m=>m.content),["新窗口里的纸船"]);assert.match(next.request.system,/SYNTHETIC_RETRIEVED_MEMORY/);
});

test("FS03：新模式拒绝旧分支映射、回放开关、未知模式及非法移除声明",()=>{
  const mutations:((s:Scope)=>void)[]=[
    s=>{s.requireReasoning=true;},s=>{s.conversations[0]!.history=[{sessionId:"old",leafId:null}];},
    s=>{(s as unknown as {migrationMode:string}).migrationMode="future";},
    s=>{(s as unknown as {reasoningReplay:object}).reasoningReplay={};},
    s=>{s.removedMemories=[memoryPath];},
    s=>{delete s.migrationMode;s.removedMemories=[];},
    s=>{s.conversations.push({key:"agent:main:another",history:[]});}
  ];
  for(const edit of mutations){const f=fresh();edit(f.definition);assert.throws(()=>f.build());assert.equal(count(f.target,"characters"),0);}
});

test("FS04：只有人设和记忆也可建候选，未知路径仍拒绝",()=>{
  const f=fresh();f.definition.files=f.definition.files.filter(v=>v.kind==="document"||v.kind==="memory");
  f.build();const output=join(f.directory,"preview");assert.equal(dryRun(f.batch,output).applied,true);
  assert.equal(verify(join(output,"candidate")).records,0);
  const bad=fresh();bad.definition.files.push({path:"openclaw.json",kind:"index"});assert.throws(()=>bad.build(),code("FILE_ALLOWLIST"));
});

test("FS05：候选不能在新会话和连续迁移模式之间切换",()=>{
  for(const initialFresh of [true,false]){
    const f=initialFresh?fresh():fixture(),base=f.build();apply(f.batch,f.target,"owner");
    const d=delta(f,base,s=>{if(initialFresh){delete s.migrationMode;s.requireReasoning=true;s.conversations=[{key,history:[{sessionId:f.sessionId,leafId:"a1"}]}];}
      else{s.migrationMode="fresh-start-v1";s.requireReasoning=false;s.conversations=[{key,history:[]}];}});
    d.build();assert.throws(()=>apply(d.batch,f.target,"owner"),code("MIGRATION_MODE_CHANGED"));assert.equal(verify(f.target).revision,1);
  }
});

test("FS06：原档改写、缩短和轮换保存所有版本，不制造历史消息",()=>{
  const f=fresh(),base=f.build();apply(f.batch,f.target,"owner");const path="sessions/"+f.sessionId+".jsonl";
  const old=inspect(f.target,db=>(db.prepare("SELECT content FROM import_objects WHERE path=?").get(path) as {content:Buffer}).content);
  put(f.input,path,"改写后的纯合成原档");const d=delta(f,base),second=d.build();apply(d.batch,f.target,"owner");
  const rotated="sessions/synthetic-rotated.jsonl";put(f.input,rotated,"另一份纯合成原档");
  const e=delta(f,second,s=>{s.files=s.files.filter(v=>v.path!==path);s.files.push({path:rotated,kind:"session"});});e.build();apply(e.batch,f.target,"owner");
  inspect(f.target,db=>assert.ok((db.prepare("SELECT content FROM import_objects WHERE path=? AND sha256=?").get(path,hash(old)) as {content:Buffer}).content.equals(old)));
  assert.equal(verify(f.target).revision,3);assert.equal(count(f.target,"messages"),0);assert.equal(count(f.target,"branches"),1);
  assert.equal(count(f.target,"import_objects"),12);
});

test("FS07：显式停用记忆仅移除当前指针，重加同内容也创建新版本",()=>{
  const f=fresh(),base=f.build();apply(f.batch,f.target,"owner");
  const d=delta(f,base,s=>{s.files=s.files.filter(v=>v.path!==memoryPath);s.removedMemories=[memoryPath];}),removed=d.build();
  apply(d.batch,f.target,"owner");assert.equal(count(f.target,"memory_heads"),1);assert.equal(count(f.target,"memory_versions"),2);
  inspect(f.target,db=>assert.deepEqual(memoryRows(db,uid(f.definition.sourceId,"character")).map(v=>v.key),["MEMORY.md"]));
  const e=delta(f,removed,s=>s.files.push({path:memoryPath,kind:"memory"}));e.build();apply(e.batch,f.target,"owner");
  inspect(f.target,db=>assert.deepEqual(db.prepare("SELECT version,parent_id FROM memory_versions WHERE logical_key='memory/synthetic.md' ORDER BY version").all(),
    [{version:1,parent_id:null},{version:2,parent_id:null}]));
  assert.equal(count(f.target,"memory_heads"),2);assert.equal(verify(f.target).revision,3);
});

test("FS08：省略记忆必须声明，不能移除未知键或迁移过程中换新窗口",()=>{
  for(const fault of ["missing","unknown","mapping"]){
    const f=fresh(),base=f.build();apply(f.batch,f.target,"owner");
    const d=delta(f,base,s=>{
      if(fault==="missing")s.files=s.files.filter(v=>v.path!==memoryPath);
      if(fault==="unknown")s.removedMemories=["workspace/memory/absent.md"];
      if(fault==="mapping")s.conversations=[{key:"agent:main:different",history:[]}];
    });d.build();
    assert.throws(()=>apply(d.batch,f.target,"owner"),code(fault==="missing"?"MEMORY_REMOVAL_REQUIRED":fault==="unknown"?"MEMORY_REMOVAL_INVALID":"FRESH_START_MAPPING_CHANGED"));
    assert.equal(verify(f.target).revision,1);
  }
});

test("FS09：目标出现本地新经历后拒绝任何旧源增量",()=>{
  const f=fresh(),base=f.build();apply(f.batch,f.target,"owner");const d=delta(f,base);d.build();
  inspect(f.target,db=>db.prepare("UPDATE memory_versions SET content=? WHERE logical_key='MEMORY.md'").run("合成新经历"));
  assert.throws(()=>apply(d.batch,f.target,"owner"),code("TARGET_DIVERGED"));assert.equal(count(f.target,"import_batches"),1);
});

test("FS10：停用记忆的事务失败会回滚新原档、版本和批次",()=>{
  const f=fresh(),base=f.build();apply(f.batch,f.target,"owner");
  const d=delta(f,base,s=>{s.files=s.files.filter(v=>v.path!==memoryPath);s.removedMemories=[memoryPath];});
  put(f.input,"workspace/MEMORY.md","合成新版本");d.build();
  inspect(f.target,db=>db.exec("CREATE TRIGGER reject_memory_removal BEFORE DELETE ON memory_heads BEGIN SELECT RAISE(ABORT,'synthetic'); END"));
  assert.throws(()=>apply(d.batch,f.target,"owner"));assert.equal(count(f.target,"import_objects"),10);
  assert.equal(count(f.target,"memory_versions"),2);assert.equal(verify(f.target).revision,1);
});

test("FS11：只存档也校验哈希，不能跳过篡改检查",()=>{
  const f=fresh();f.build();appendFileSync(join(f.batch,"sessions",f.sessionId+".jsonl"),"synthetic-tamper");
  assert.throws(()=>apply(f.batch,f.target,"owner"),code("HASH_MISMATCH"));assert.equal(count(f.target,"import_batches"),0);
});

test("FS12：验证覆盖退役原档；即使重算候选指纹也能检出缺失",()=>{
  const f=fresh(),base=f.build();apply(f.batch,f.target,"owner");const path="sessions/"+f.sessionId+".jsonl";
  const d=delta(f,base,s=>{s.files=s.files.filter(v=>v.path!==path);});d.build();apply(d.batch,f.target,"owner");
  inspect(f.target,db=>{
    db.prepare("DELETE FROM import_objects WHERE path=?").run(path);
    db.prepare("UPDATE import_sources SET state_sha256=?").run(stateHash(db));
  });
  assert.throws(()=>verify(f.target),code("RAW_ARCHIVE_INVALID"));
});

test("FS13：不可检索或超过运行预算的记忆阻止候选，不静默保管后宣称可用",()=>{
  for(const fault of ["read","budget","defaults"]){
    const f=fresh();
    if(fault==="read")f.definition.config.memoryReadKeys=["MEMORY.md"];
    else if(fault==="defaults")f.definition.config={} as Scope["config"];
    else put(f.input,memoryPath,"x".repeat(1024*1024));
    f.build();assert.ok(inspectBatch(f.batch).gaps.includes(fault==="budget"?"MEMORY_INDEX_REQUIRED":"MEMORY_NOT_READABLE"));
    assert.throws(()=>apply(f.batch,f.target,"owner"),code("COMPATIBILITY_GAPS"));assert.equal(count(f.target,"characters"),0);
  }
});

test("FS14：运行中重建停用键使用新版本号，不自动复活旧内容且CAS仍生效",t=>{
  const f=fresh();f.definition.config.memoryWriteKeys.push("memory/synthetic.md");
  const base=f.build();apply(f.batch,f.target,"owner");
  const d=delta(f,base,s=>{s.files=s.files.filter(v=>v.path!==memoryPath);s.removedMemories=[memoryPath];});d.build();apply(d.batch,f.target,"owner");
  const {storage,character}=activate(f,t);
  assert.equal(storage.memoryAccess().read("owner",character,"memory/synthetic.md"),undefined);
  const input={characterId:character,key:"memory/synthetic.md",expectedVersion:null,content:"新建立的纯合成记忆",provenance:{source:"synthetic" as const,reference:"fresh-recreate"}};
  const written=storage.memoryAccess().write("owner",input,randomUUID(),Date.now());
  assert.equal(written.version,2);assert.equal(written.parentId,null);assert.equal(written.content,input.content);
  assert.throws(()=>storage.memoryAccess().write("owner",input,randomUUID(),Date.now()),code("MEMORY_VERSION_CONFLICT"));
  assert.equal(storage.memoryAccess().read("owner",character,input.key)!.id,written.id);
});
