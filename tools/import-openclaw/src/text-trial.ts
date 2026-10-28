import { restrictedTools } from "../../../apps/backend/dist/tools/registry.js";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { acceptancePreflight } from "./acceptance.js";
import { secureNewOutput } from "./source-transport.js";
import { check, hash, hex, json, object, read, write } from "./safe.js";
import { stateHash } from "./ledger.js";
import { restoreDatabase } from "../../../apps/backend/dist/storage/backup.js";
import { checkedFile, checkSidecars } from "../../../apps/backend/dist/storage/paths.js";
import { appliedMigrations, loadMigrations, verifyIntegrity } from "../../../apps/backend/dist/storage/migrations.js";
import { requireNoActiveLease } from "../../../apps/backend/dist/storage/lease.js";
import { SqliteStorage } from "../../../apps/backend/dist/storage/storage.js";
import { config, profile, expressionDocumentName, decodeDocument } from "../../../apps/backend/dist/context/profile.js";
import { compile } from "../../../apps/backend/dist/context/compiler.js";
import { memoryRows } from "../../../apps/backend/dist/storage/context-records.js";
import { TextSession } from "../../../apps/backend/dist/acceptance/text-session.js";
import { DeepSeekProvider } from "../../../apps/backend/dist/providers/deepseek.js";
import { thinkingPolicy } from "../../../apps/backend/dist/providers/policy.js";
import type { ProviderAdapter } from "../../../apps/backend/dist/ports.js";
import type { Document, Profile, CharacterConfig, Pinned } from "../../../apps/backend/dist/context/types.js";
const project=fileURLToPath(new URL("../../../",import.meta.url));
const normalize=(p:string)=>process.platform==="win32"?resolve(p).toLowerCase():resolve(p);
function within(parent:string,target:string){const p=relative(normalize(parent),normalize(target));return !!p&&p!==".."&&!p.startsWith(".."+sep)&&!isAbsolute(p);}
export type TrialSettings={thinking:"provider-default"|"enabled"|"disabled";maxTokens:number;timezone:string;windowTokens:number;reserveTokens:number;maxCalls:number};
export function trialSettings(v:unknown):TrialSettings{
 check(object(v)&&Object.keys(v).sort().join(",")===["thinking","maxTokens","timezone","windowTokens","reserveTokens","maxCalls"].sort().join(","),"TRIAL_SETTINGS_INVALID");
 check(["provider-default","enabled","disabled"].includes(String(v.thinking))&&Number.isInteger(v.maxTokens)&&Number(v.maxTokens)>=1&&Number(v.maxTokens)<=32768&&Number.isInteger(v.maxCalls)&&Number(v.maxCalls)>=1&&Number(v.maxCalls)<=12,"TRIAL_SETTINGS_INVALID");
 const c=config({timezone:v.timezone,windowTokens:v.windowTokens,reserveTokens:v.reserveTokens});check(c.windowTokens>Number(v.maxTokens)+c.reserveTokens,"TRIAL_SETTINGS_INVALID");return v as TrialSettings;
}
export type ExpressionReference={bytes:Uint8Array;sha256:string;mode?:"reference"|"project-instructions"};
function expressionDocument(input:ExpressionReference):Document {
 check(input && (input.mode===undefined || input.mode==="reference" || input.mode==="project-instructions") && input.bytes instanceof Uint8Array && input.bytes.byteLength>0 && input.bytes.byteLength<=65536 && hex(input.sha256) && hash(input.bytes)===input.sha256,"TRIAL_EXPRESSION_INVALID");
 const doc={name:expressionDocumentName,bytes:Buffer.from(input.bytes),sha256:input.sha256};
 try{decodeDocument(doc);}catch{check(false,"TRIAL_EXPRESSION_INVALID");}return doc;
}
type Plan={format:"kuinest-text-trial-v1";mode:"private"|"synthetic";source:{path:string;sealSha256:string};status:"offline-ready-awaiting-authorization";owner:string;character:string;version:string;profile:Profile;config:CharacterConfig;settings:TrialSettings;expression?:{path:"EXPRESSION.md";sha256:string;bytes:number};files:{path:string;sha256:string}[];checks:{documents:number;memoryHeads:number;contextEntries:0;activated:false;realCalls:0;rollbackVerified:true}};
function candidate(file:string){
 checkSidecars(checkedFile(file));for(const suffix of ["-wal","-journal"])if(existsSync(file+suffix))check(read(dirname(file),"kuinest.sqlite"+suffix).length===0,"TRIAL_SOURCE_JOURNAL");
 const db=new Database(file,{readonly:true,fileMustExist:true});try{
  db.exec("BEGIN");requireNoActiveLease(db,Date.now());const migrations=appliedMigrations(db);verifyIntegrity(db,migrations);
  check(!db.prepare("SELECT 1 FROM characters WHERE active_version_id IS NOT NULL").get(),"TRIAL_ALREADY_ACTIVE");
  for(const table of ["context_entries","messages","runs","provider_calls","scheduled_tasks"])check(!(db.prepare("SELECT count(*) AS n FROM "+table).get() as {n:number}).n,"TRIAL_NOT_EMPTY");
  return {migrations,logicalHash:stateHash(db)};
 }finally{if(db.inTransaction)db.exec("ROLLBACK");db.close();}
}
export async function prepareTextTrial(input:string,output:string,sealSha:string,values:unknown,expression?:ExpressionReference){
 const expressionDoc=expression===undefined?undefined:expressionDocument(expression);
 const settings=trialSettings(values),source=acceptancePreflight(input,sealSha),m=source.bundle.manifest;
 const area=m.mode==="private"?join(project,"runtime/private/acceptance"):join(project,".cache/stage09-tests");
 check(isAbsolute(output)&&within(area,output)&&!existsSync(output)&&!within(input,output)&&!within(output,input),"TRIAL_OUTPUT_INVALID");
 if(m.mode==="private")check(normalize(dirname(output))===normalize(area)&&/^trial-[0-9a-f-]{36}$/.test(relative(area,output)),"TRIAL_OUTPUT_INVALID");
 // 模型身份与端点直接继承已封存候选；只能单独选择新系统试用参数。
 const p=profile({...m.profile,id:randomUUID(),options:{allowedOrigin:m.profile.options.allowedOrigin,maxTokens:settings.maxTokens,thinking:settings.thinking,imageInput:false}});
 // mock没有网络来源字段，不人为写入undefined影响配置快照。
 if(p.options.allowedOrigin===undefined)delete p.options.allowedOrigin;
 check(!config(m.config).expressionEnabled,"TRIAL_SOURCE_EXPRESSION_INVALID");
 const c=config({...m.config,...(expressionDoc?{expressionEnabled:true,expressionMode:expression!.mode??"reference",documentOrder:[...m.config.documentOrder,expressionDocumentName]}:{}),timezone:settings.timezone,windowTokens:settings.windowTokens,reserveTokens:settings.reserveTokens,memoryReviewEnabled:true,memoryWriteKeys:[],memoryAppendKeys:[],memoryReplaceEnabled:false});
 secureNewOutput(output);
 const original=join(input,"preview/candidate/kuinest.sqlite"),rollback=join(output,"rollback"),restore=join(output,"restore-rehearsal"),database=join(output,"database");
 await restoreDatabase(original,rollback,Date.now(),source.migrations);const baseline=candidate(join(rollback,"kuinest.sqlite"));check(baseline.logicalHash===source.logicalHash,"TRIAL_ROLLBACK_MISMATCH");
 await restoreDatabase(join(rollback,"kuinest.sqlite"),restore,Date.now(),source.migrations);check(candidate(join(restore,"kuinest.sqlite")).logicalHash===baseline.logicalHash,"TRIAL_ROLLBACK_MISMATCH");
 // 完成回退验证后才生成可升级的试用副本。
 await restoreDatabase(join(rollback,"kuinest.sqlite"),database,Date.now(),source.migrations);
 const sourceDb=new Database(checkedFile(join(rollback,"kuinest.sqlite")),{readonly:true,fileMustExist:true});let owner:string,character:string,documents:Document[],memories:Pinned["memories"];
 try{const row=sourceDb.prepare("SELECT c.owner_id AS owner,c.id AS character,v.id AS version FROM characters c JOIN character_versions v ON v.character_id=c.id").get() as {owner:string;character:string;version:string};owner=row.owner;character=row.character;documents=sourceDb.prepare("SELECT logical_name AS name,content AS bytes,sha256 FROM character_documents WHERE version_id=? ORDER BY logical_name").all(row.version) as Document[];memories=memoryRows(sourceDb,character);}finally{sourceDb.close();}
 if(expressionDoc){check(!documents.some(d=>d.name===expressionDocumentName),"TRIAL_SOURCE_EXPRESSION_INVALID");documents.push(expressionDoc);}
 const version=randomUUID(),entry={id:"trial-probe",parentId:null,branchId:"trial-probe",kind:"message",payload:{role:"user",content:"离线检查"}},pinned:Pinned={snapshotId:"trial-probe",characterId:character,versionId:version,profile:p,config:c,documents,memories,entries:[entry],boundary:entry.id,branchId:entry.branchId,receivedAt:Date.now()};
 const probeTools=restrictedTools({id:"offline-probe",conversationId:"offline-probe",ownerId:owner,fence:1,claimOwner:"offline-probe",contextUserEntryId:entry.id,origin:"user"},{...pinned,origin:"user",allowMemoryWrite:true},{control:()=>"running",memory:{toolMemories:()=>memories,write(){throw new Error("OFFLINE_ONLY");}},review:{proposeTool(){throw new Error("OFFLINE_ONLY");}},clock:{now:Date.now},ids:{next:randomUUID}});
 const probe=compile(pinned,probeTools.definitions);check(probe.budget.fits&&probe.manifest.documents.every(d=>!d.truncated),"TRIAL_BUDGET_INVALID");
 const storage=new SqliteStorage({dataRoot:database,instanceId:randomUUID(),clock:{now:Date.now}});
 try{storage.characterAccess().publish(owner,{characterId:character,versionId:version,profile:p,config:c,documents},Date.now());}finally{await storage.close();}
 check(acceptancePreflight(input,sealSha).logicalHash===source.logicalHash,"TRIAL_SOURCE_CHANGED");
 if(expressionDoc)write(output,expressionDocumentName,expressionDoc.bytes);
 const plan:Plan={format:"kuinest-text-trial-v1",mode:m.mode,source:{path:input,sealSha256:sealSha},status:"offline-ready-awaiting-authorization",owner,character,version,profile:p,config:c,settings,...(expressionDoc?{expression:{path:expressionDocumentName as "EXPRESSION.md",sha256:expressionDoc.sha256,bytes:expressionDoc.bytes.byteLength}}:{}),
 files:["database/kuinest.sqlite","rollback/kuinest.sqlite","restore-rehearsal/kuinest.sqlite"].map(path=>({path,sha256:hash(read(output,path))})),checks:{documents:documents.length,memoryHeads:memories.length,contextEntries:0,activated:false,realCalls:0,rollbackVerified:true}};
 const bytes=Buffer.from(JSON.stringify(plan,null,2));write(output,"TRIAL-PLAN.json",bytes);
 return {ok:true,planSha256:hash(bytes),databases:3,rollbackVerified:true,sourceUnchanged:true,schema:loadMigrations().length,documentCount:documents.length,memoryHeads:memories.length,contextEntries:0,activated:false,realCalls:0,parameterStatus:"proposed-awaiting-approval"};
}
export function textTrialPreflight(directory:string,expectedSha:string){
 check(isAbsolute(directory)&&hex(expectedSha)&&(within(join(project,"runtime/private/acceptance"),directory)||within(join(project,".cache/stage09-tests"),directory)),"TRIAL_PATH_INVALID");
 const bytes=read(directory,"TRIAL-PLAN.json",1024*1024);check(hash(bytes)===expectedSha,"TRIAL_PLAN_CHANGED");const raw=json(bytes);
 check(object(raw)&&raw.format==="kuinest-text-trial-v1"&&raw.status==="offline-ready-awaiting-authorization"&&["private","synthetic"].includes(String(raw.mode))&&Array.isArray(raw.files)&&raw.files.length===3&&typeof raw.owner==="string"&&typeof raw.character==="string"&&typeof raw.version==="string","TRIAL_PLAN_INVALID");
 const plan=raw as unknown as Plan;trialSettings(plan.settings);profile(plan.profile);config(plan.config);check(plan.config.memoryReviewEnabled&&plan.profile.options.imageInput===false,"TRIAL_PLAN_INVALID");
 if(plan.mode==="private")check(within(join(project,"runtime/private/acceptance"),directory)&&plan.profile.status==="unverified"&&plan.profile.provider==="deepseek","TRIAL_PLAN_INVALID");else check(plan.profile.status==="synthetic","TRIAL_PLAN_INVALID");
 const c=config(plan.config);
 check(c.expressionEnabled===!!plan.expression,"TRIAL_EXPRESSION_INVALID");
 if(plan.expression){const e=plan.expression;check(object(e)&&Object.keys(e).sort().join(",")==="bytes,path,sha256"&&e.path===expressionDocumentName&&Number.isInteger(e.bytes),"TRIAL_EXPRESSION_INVALID");const d=expressionDocument({bytes:read(directory,expressionDocumentName,65536),sha256:e.sha256});check(d.bytes.byteLength===e.bytes,"TRIAL_EXPRESSION_INVALID");}
 const expected=["database/kuinest.sqlite","rollback/kuinest.sqlite","restore-rehearsal/kuinest.sqlite"];
 for(let i=0;i<3;i++){const f=plan.files[i]!;check(f.path===expected[i]&&hex(f.sha256)&&hash(read(directory,f.path))===f.sha256,"TRIAL_FILE_CHANGED");candidate(join(directory,f.path));}
 check(candidate(join(directory,expected[1]!)).logicalHash===candidate(join(directory,expected[2]!)).logicalHash,"TRIAL_ROLLBACK_MISMATCH");
 if(plan.expression){const db=new Database(join(directory,"database/kuinest.sqlite"),{readonly:true,fileMustExist:true});try{const row=db.prepare("SELECT d.sha256,v.config_json FROM character_documents d JOIN character_versions v ON v.id=d.version_id WHERE d.version_id=? AND d.logical_name=?").get(plan.version,expressionDocumentName) as {sha256:string;config_json:string}|undefined;check(row?.sha256===plan.expression.sha256,"TRIAL_EXPRESSION_INVALID");check(config(JSON.parse(row!.config_json)).expressionMode===c.expressionMode,"TRIAL_EXPRESSION_INVALID");}finally{db.close();}}
 check(!existsSync(join(directory,"TRIAL-STARTED.json")),"TRIAL_ALREADY_STARTED");return plan;
}
export function startTextTrial(directory:string,expectedSha:string,authorization:{allowLive?:boolean;credential?:()=>string;syntheticProvider?:ProviderAdapter}){
 const plan=textTrialPreflight(directory,expectedSha);
 check(plan.mode==="private"?authorization.allowLive===true&&typeof authorization.credential==="function"&&!authorization.syntheticProvider:authorization.allowLive!==true&&!!authorization.syntheticProvider,"TRIAL_AUTHORIZATION_REQUIRED");
 const resolveProvider=(p:Profile):ProviderAdapter=>{
  check(p.model===plan.profile.model&&p.endpoint===plan.profile.endpoint&&p.provider===plan.profile.provider,"TRIAL_PROFILE_CHANGED");
  if(plan.mode==="synthetic")return authorization.syntheticProvider!;
  return new DeepSeekProvider({mode:"private",endpoint:p.endpoint!,allowedOrigin:String(p.options.allowedOrigin),model:p.model,maxTokens:Number(p.options.maxTokens),...thinkingPolicy(p.options),imageInput:false,allowLive:true},authorization.credential!);
 };
 write(directory,"TRIAL-STARTED.json",Buffer.from(JSON.stringify({planSha256:expectedSha,startedAt:new Date().toISOString(),scope:"isolated-text-test",maxCalls:plan.settings.maxCalls})));
 const clock={now:Date.now},storage=new SqliteStorage({dataRoot:join(directory,"database"),instanceId:randomUUID(),clock});
 try{storage.characterAccess().activate(plan.owner,plan.character,plan.version,plan.mode==="private");return new TextSession(storage,plan.owner,plan.character,clock,resolveProvider,plan.settings.maxCalls);}
 catch(error){void storage.close();throw error;}
}
