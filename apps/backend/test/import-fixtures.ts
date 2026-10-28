import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { projectRoot } from "../dist/server.js";
import { defaults, documentNames } from "../dist/context/profile.js";
import { openDatabase } from "../dist/storage/database.js";
import { loadMigrations, applyMigrationsInTransaction } from "../dist/storage/migrations.js";
import type { Scope, RawEntry } from "../../../tools/import-openclaw/dist/types.js";
import { capture } from "../../../tools/import-openclaw/dist/capture.js";
export const key = "agent:main:xiaokui-web";
export function entry(id:string,parentId:string|null,message:unknown): RawEntry {
  return {type:"message",id,parentId,timestamp:"2026-09-11T00:00:00.000Z",message};
}
export function messages(): RawEntry[] { return [
  entry("u1",null,{role:"user",content:[{type:"text",text:"合成测试：蓝色纸船。"}]}),
  entry("a1","u1",{role:"assistant",content:[{type:"thinking",thinking:"合成推理。"}, {type:"text",text:"合成回复：记下纸船。"}],stopReason:"stop"})
]; }
export function root(): string { const parent=join(projectRoot,".cache","stage09-tests"); mkdirSync(parent,{recursive:true}); return mkdtempSync(join(parent,"synthetic-")); }
export function put(directory:string,path:string,bytes:string|Buffer):void { const full=join(directory,path); mkdirSync(dirname(full),{recursive:true}); writeFileSync(full,bytes); }
export function sessionBytes(sessionId:string,records=messages()): string {
  return [JSON.stringify({type:"session",version:3,id:sessionId,timestamp:"2026-09-11T00:00:00.000Z",cwd:"/synthetic"}),...records.map(e=>JSON.stringify(e))].join("\n")+"\n";
}
export function fixture() {
  const directory=root(), input=join(directory,"input"), batch=join(directory,"batch"), target=join(directory,"target");
  mkdirSync(input); mkdirSync(target);
  const sessionId=randomUUID();
  const definition: Scope = {
    format:"kuinest-openclaw-v1",sourceId:randomUUID(),batchId:randomUUID(),revision:1,parent:null,
    agentId:"main",mode:"synthetic",sourceVersion:"2026.7.1-2",requireReasoning:true,
    files:[...documentNames.map(name=>({path:"workspace/"+name,kind:"document" as const})),{path:"workspace/memory/synthetic.md",kind:"memory"},{path:"sessions/sessions.json",kind:"index"},{path:"sessions/"+sessionId+".jsonl",kind:"session"}],
    conversations:[{key,history:[{sessionId,leafId:"a1"}]}],
    profile:{id:"synthetic-import",provider:"mock",model:"synthetic",endpoint:null,options:{},status:"synthetic"},
    config:{...structuredClone(defaults),memoryReadKeys:["MEMORY.md","memory/synthetic.md"]},
    compatibility:{model:"unverified",thinking:"unverified",bootstrap:"unverified",reset:"unverified",compaction:"unverified",memory:"unverified",tools:"unverified",proactive:"unverified",multimodal:"unverified"}
  };
  for(const name of documentNames) put(input,"workspace/"+name,"纯合成资料："+name+"。");
  put(input,"workspace/memory/synthetic.md","虚构测试：纸船在盒子里。");
  put(input,"sessions/sessions.json",JSON.stringify({[key]:{sessionId}}));
  put(input,"sessions/"+sessionId+".jsonl",sessionBytes(sessionId));
  const db=openDatabase(target);
  try { db.transaction(()=>{applyMigrationsInTransaction(db,loadMigrations(),Date.now());db.prepare("INSERT INTO owners VALUES ('owner','synthetic-owner','!',1)").run();}).immediate(); } finally { db.close(); }
  const build=()=>capture(input,batch,definition);
  return {directory,input,batch,target,definition,sessionId,build};
}
export function inspect<T>(target:string,fn:(db:Database.Database)=>T):T { const db=openDatabase(target,true);try{return fn(db);}finally{db.close();} }
export function next(f:ReturnType<typeof fixture>,parent:string,records:RawEntry[]=messages()) {
  const definition:Scope={...structuredClone(f.definition),batchId:randomUUID(),revision:2,parent};
  put(f.input,"sessions/"+f.sessionId+".jsonl",sessionBytes(f.sessionId,records));
  const batch=join(f.directory,"batch2");
  return {definition,batch,build:()=>capture(f.input,batch,definition)};
}
