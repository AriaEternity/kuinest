import Database from "better-sqlite3";
import {existsSync,readFileSync,openSync,readSync,closeSync,statSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname,join,resolve,relative,isAbsolute,sep} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {secureNewOutput} from "./source-transport.js";
import {stateHash} from "./ledger.js";
import {runtimeAccess} from "../../../apps/backend/dist/storage/runtime-access.js";
import {restoreDatabase} from "../../../apps/backend/dist/storage/backup.js";
import {privatePath} from "../../../apps/backend/dist/runtime/files.js";
import {loadMigrations,appliedMigrations,hasTable,verifyIntegrity} from "../../../apps/backend/dist/storage/migrations.js";
import {requireNoActiveLease} from "../../../apps/backend/dist/storage/lease.js";
import {requireCondition as check} from "../../../apps/backend/dist/storage/errors.js";
import {hash} from "../../../apps/backend/dist/context/profile.js";
const project=fileURLToPath(new URL("../../../",import.meta.url));
function inside(base:string,target:string){const r=relative(resolve(base),resolve(target));return !!r&&r!==".."&&!r.startsWith(".."+sep)&&!isAbsolute(r);}
export function runtimeFileHash(file:string){privatePath(file);const fd=openSync(file,'r'),h=createHash('sha256'),b=Buffer.alloc(65536);try{for(;;){const n=readSync(fd,b,0,b.length,null);if(!n)break;h.update(b.subarray(0,n));}return h.digest('hex');}finally{b.fill(0);closeSync(fd);}}
function inspect(file:string,version:string){
 privatePath(dirname(file),true);privatePath(file);
 for(const suffix of ['-wal','-shm','-journal'])check(!existsSync(file+suffix),'RUNTIME_SOURCE_SIDECAR');
 const db=new Database(file,{readonly:true,fileMustExist:true});try{
  db.exec('BEGIN');requireNoActiveLease(db,Date.now());const migrations=appliedMigrations(db);check(migrations.length>=4,'SCHEMA_INCOMPLETE');verifyIntegrity(db,migrations);
  check(!db.prepare('SELECT 1 FROM characters WHERE active_version_id IS NOT NULL').get(),'RUNTIME_SOURCE_ACTIVE');
  for(const table of ['messages','runs','context_entries','context_snapshots','provider_calls','tool_calls','scheduled_tasks','auth_sessions','memory_proposals','image_assets'])check(!(db.prepare('SELECT count(*) AS n FROM '+table).get() as {n:number}).n,'RUNTIME_SOURCE_USED');
  if(hasTable(db,'kuisense_latest_context'))check(!(db.prepare('SELECT count(*) AS n FROM kuisense_latest_context').get() as {n:number}).n,'RUNTIME_SOURCE_USED');
  const row=db.prepare('SELECT c.owner_id AS owner,c.id AS character FROM characters c JOIN character_versions v ON v.character_id=c.id WHERE v.id=?').get(version) as {owner:string;character:string}|undefined;check(row,'RUNTIME_VERSION_INVALID');
  const current=runtimeAccess(db,()=>{throw Error('READ_ONLY');},()=>{}).inspect(row.owner,row.character,version);
  check(!current.accountReady,'RUNTIME_SOURCE_ACCOUNT_SET');
  const documents=(db.prepare('SELECT count(*) AS n FROM character_documents WHERE version_id=?').get(version) as {n:number}).n,memories=(db.prepare('SELECT count(*) AS n FROM memory_heads').get() as {n:number}).n;
  return {binding:current.binding,logicalSha256:stateHash(db),documents,memories,migrations};
 }finally{if(db.inTransaction)db.exec('ROLLBACK');db.close();}
}
export async function prepareRuntime(source:string,sourceSha256:string,version:string,output:string,mode:'private'|'synthetic'='private'){
 check(/^[0-9a-f]{64}$/.test(sourceSha256)&&/^[A-Za-z0-9_-]{1,128}$/.test(version),'RUNTIME_ARGUMENT_INVALID');
 const area=join(project,mode==='private'?'runtime/private/services':'.cache/stage10-tests');
 check(['private','synthetic'].includes(mode)&&isAbsolute(source)&&isAbsolute(output)&&inside(area,output)&&!existsSync(output)&&!inside(output,source)&&!inside(dirname(source),output),'RUNTIME_OUTPUT_INVALID');
 if(mode==='private')check(resolve(dirname(output))===resolve(area)&&/^runtime-[0-9a-f-]{36}$/.test(relative(area,output)),'RUNTIME_OUTPUT_INVALID');
 if(mode==='synthetic')check(inside(join(project,'.cache/stage10-tests'),source),'RUNTIME_SYNTHETIC_SCOPE');
 check(runtimeFileHash(source)===sourceSha256,'RUNTIME_SOURCE_CHANGED');const baseline=inspect(source,version);
 secureNewOutput(output);
 const rollback=join(output,'rollback'),rehearsal=join(output,'restore-rehearsal'),data=join(output,'data');
 await restoreDatabase(source,rollback,Date.now(),baseline.migrations);check(inspect(join(rollback,'kuinest.sqlite'),version).logicalSha256===baseline.logicalSha256,'RUNTIME_ROLLBACK_MISMATCH');
 await restoreDatabase(join(rollback,'kuinest.sqlite'),rehearsal,Date.now(),baseline.migrations);check(inspect(join(rehearsal,'kuinest.sqlite'),version).logicalSha256===baseline.logicalSha256,'RUNTIME_ROLLBACK_MISMATCH');
 await restoreDatabase(join(rollback,'kuinest.sqlite'),data,Date.now());const ready=inspect(join(data,'kuinest.sqlite'),version);check(ready.logicalSha256===baseline.logicalSha256&&hash(JSON.stringify(ready.binding))===hash(JSON.stringify(baseline.binding))&&ready.migrations.length===loadMigrations().length,'RUNTIME_CANDIDATE_MISMATCH');
 const binding=Buffer.from(JSON.stringify(baseline.binding,null,2)+'\n');writeFileSync(join(data,'runtime-binding.json'),binding,{flag:'wx',mode:0o600});
 check(runtimeFileHash(source)===sourceSha256,'RUNTIME_SOURCE_CHANGED');
 const files=['rollback/kuinest.sqlite','restore-rehearsal/kuinest.sqlite','data/kuinest.sqlite','data/runtime-binding.json'].map(path=>({source:path.endsWith('.sqlite')?resolve(source):'derived-from-verified-version',path,sha256:runtimeFileHash(join(output,path)),bytes:statSync(join(output,path)).size}));
 const manifest={format:'kuinest-runtime-preparation-v1',mode,source:{path:resolve(source),sha256:sourceSha256},version,bindingSha256:hash(binding),logicalSha256:baseline.logicalSha256,files,checks:{documents:baseline.documents,memoryHeads:baseline.memories,contextEntries:0,activated:false,modelCalls:0,rollbackVerified:true,sourceUnchanged:true}};
 const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');writeFileSync(join(output,'RUNTIME-PREPARE.json'),bytes,{flag:'wx',mode:0o600});
 return {ok:true,manifestSha256:hash(bytes),bindingSha256:hash(binding),files:files.length,...manifest.checks};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){try{
 const values=new Map<string,string>();for(const arg of process.argv.slice(2)){const m=/^--(source|source-sha256|version|output)=(.+)$/.exec(arg);check(m&&!values.has(m[1]!), 'RUNTIME_ARGUMENT_INVALID');values.set(m[1]!,m[2]!);}check(values.size===4,'RUNTIME_ARGUMENT_INVALID');
 console.log(JSON.stringify(await prepareRuntime(values.get('source')!,values.get('source-sha256')!,values.get('version')!,values.get('output')!)));
}catch{process.stderr.write('{"error":{"code":"RUNTIME_PREPARATION_FAILED"}}\n');process.exitCode=1;}}
