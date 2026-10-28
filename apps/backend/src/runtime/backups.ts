import Database from "better-sqlite3";
import {createHash,randomUUID,randomBytes} from "node:crypto";
import {openSync,readSync,closeSync,writeFileSync,readdirSync,existsSync,unlinkSync,mkdirSync} from "node:fs";
import {join,dirname,resolve} from "node:path";
import type {SqliteStorage} from "../storage/storage.js";
import {restoreDatabase} from "../storage/backup.js";
import {appliedMigrations,verifyIntegrity} from "../storage/migrations.js";
import {requireCondition as check} from "../storage/errors.js";
import {privateBytes,privatePath} from "./files.js";
import {digest,validateBinding,type RuntimeBinding} from "./binding.js";
import {runtimeAccess} from "../storage/runtime-access.js";
import {hash} from "../context/profile.js";
import {object} from "../providers/messages.js";
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,hex=/^[0-9a-f]{64}$/;
type Backup={format:'kuinest-backup-v1';id:string;createdAt:number;databaseSha256:string;bindingSha256:string;coverage:Record<string,number>};
export function backupFileHash(file:string){privatePath(file);const fd=openSync(file,'r'),b=Buffer.alloc(65536),h=createHash('sha256');try{for(;;){const n=readSync(fd,b,0,b.length,null);if(!n)break;h.update(b.subarray(0,n));}return h.digest('hex');}finally{b.fill(0);closeSync(fd);}}
const tables=['owners','characters','character_versions','character_documents','memory_heads','memory_versions','memory_proposals','memory_proposal_revisions','conversations','messages','context_entries','provider_calls','tool_calls','runs','run_events','scheduled_tasks','image_assets','message_images','import_objects','auth_sessions'] as const;
// 旧备份按已登记前缀核验，不要求先修改源备份。整库SHA-256覆盖包括设备单槽在内的全部字节。
function coverage(file:string){const db=new Database(privatePath(file),{readonly:true,fileMustExist:true});try{const migrations=appliedMigrations(db);check(migrations.length>=4,'SCHEMA_INCOMPLETE');verifyIntegrity(db,migrations);return Object.fromEntries(tables.map(t=>[t,(db.prepare('SELECT count(*) AS n FROM '+t).get() as {n:number}).n]));}finally{db.close();}}
function readManifest(directory:string,id:string):Backup{
 check(idPattern.test(id),'BACKUP_ID_INVALID');const v:unknown=JSON.parse(privateBytes(join(directory,id+'.json'),16384).toString('utf8'));
 check(object(v)&&Object.keys(v).sort().join(',')==='bindingSha256,coverage,createdAt,databaseSha256,format,id'&&v.format==='kuinest-backup-v1'&&v.id===id&&Number.isSafeInteger(v.createdAt)&&Number(v.createdAt)>=0&&hex.test(String(v.databaseSha256))&&hex.test(String(v.bindingSha256))&&object(v.coverage)&&Object.keys(v.coverage).sort().join(',')===[...tables].sort().join(',')&&Object.values(v.coverage).every(n=>Number.isSafeInteger(n)&&Number(n)>=0),'BACKUP_MANIFEST_INVALID');return v as unknown as Backup;
}
function verified(directory:string,id:string){const m=readManifest(directory,id),file=join(directory,id+'.sqlite'),bindingBytes=privateBytes(join(directory,id+'.binding.json'),16384);check(backupFileHash(file)===m.databaseSha256&&hash(bindingBytes)===m.bindingSha256,'BACKUP_CHANGED');const binding=validateBinding(JSON.parse(bindingBytes.toString('utf8')));check(digest(coverage(file))===digest(m.coverage),'BACKUP_COVERAGE_CHANGED');return {manifest:m,binding,bindingBytes,file};}
export function selectBackups(rows:readonly Pick<Backup,'id'|'createdAt'>[]):Set<string>{
 const sorted=[...rows].sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id)),keep=new Set(sorted.slice(0,7).map(x=>x.id)),weeks=new Set<number>();
 for(const row of sorted){const week=Math.floor((row.createdAt+3*86400000)/(7*86400000));if(!weeks.has(week)){if(weeks.size===4)break;weeks.add(week);keep.add(row.id);}}return keep;
}
export class RuntimeBackups{
 readonly directory:string;#busy:Promise<unknown>|undefined;#timer:ReturnType<typeof setInterval>|undefined;#closed=false;#healthy=true;
 constructor(readonly store:SqliteStorage,readonly root:string,readonly binding:RuntimeBinding,readonly retention=false,readonly notify:(ok:boolean)=>void=()=>{}){this.directory=join(privatePath(root,true),'managed-backups');mkdirSync(this.directory,{recursive:true,mode:0o700});privatePath(this.directory,true);}
 get ready(){return this.#healthy;}
 #rows(){return readdirSync(this.directory).filter(f=>idPattern.test(f.slice(0,-5))&&f.endsWith('.json')).map(f=>readManifest(this.directory,f.slice(0,-5)));}
 async create(now=Date.now()):Promise<Backup>{
  check(!this.#closed&&!this.#busy,'BACKUP_BUSY');const pending=this.#create(now);this.#busy=pending;
  try{const result=await pending;this.#healthy=true;return result;}catch(e){this.#healthy=false;throw e;}finally{this.#busy=undefined;}
 }
 async #create(now:number){
  check(Number.isSafeInteger(now)&&now>=0,'TIME_INVALID');this.store.runtimeAccess().verify(this.binding);
  const id=randomUUID(),file=join(this.directory,id+'.sqlite');await this.store.backup(file);
  const bytes=Buffer.from(JSON.stringify(this.binding,null,2)+'\n');writeFileSync(join(this.directory,id+'.binding.json'),bytes,{flag:'wx',mode:0o600});
  const m:Backup={format:'kuinest-backup-v1',id,createdAt:now,databaseSha256:backupFileHash(file),bindingSha256:hash(bytes),coverage:coverage(file)};
  writeFileSync(join(this.directory,id+'.json'),JSON.stringify(m,null,2)+'\n',{flag:'wx',mode:0o600});
  if(this.retention)this.prune();return m;
 }
 prune(){
  const proof:unknown=JSON.parse(privateBytes(join(this.directory,'RESTORE-VERIFIED.json'),16384).toString('utf8'));
  check(object(proof)&&Object.keys(proof).sort().join(',')==='bindingDigest,format,manifestDigest,sourceId'&&proof.format==='kuinest-restore-verified-v1'&&proof.bindingDigest===digest(this.binding)&&idPattern.test(String(proof.sourceId))&&hex.test(String(proof.manifestDigest)),'BACKUP_RESTORE_PROOF_REQUIRED');
  const rows=this.#rows(),keep=selectBackups(rows);keep.add(String(proof.sourceId));
  const source=verified(this.directory,String(proof.sourceId));check(digest(source.manifest)===proof.manifestDigest&&digest(source.binding)===digest(this.binding),'BACKUP_RESTORE_PROOF_INVALID');
  // 先完成全部校验，再删除清单明确指向且哈希一致的三个文件；没有递归目录删除。
  const drop=rows.filter(m=>!keep.has(m.id));for(const row of drop)verified(this.directory,row.id);
  for(const row of drop)for(const suffix of ['.sqlite','.binding.json','.json']){const file=join(this.directory,row.id+suffix);check(dirname(resolve(file))===resolve(this.directory),'BACKUP_PATH_INVALID');privatePath(file);unlinkSync(file);}
  return drop.length;
 }
 start(){
  check(!this.#timer&&!this.#closed,'BACKUP_ALREADY_STARTED');const tick=()=>{if(this.#closed||this.#busy)return;try{const latest=Math.max(0,...this.#rows().map(x=>x.createdAt));if(Date.now()-latest<86400000){if(!this.#healthy){if(this.retention)this.prune();this.#healthy=true;this.notify(true);}return;}void this.create().then(()=>this.notify(true),()=>this.notify(false));}catch{this.#healthy=false;this.notify(false);}};
  tick();this.#timer=setInterval(tick,300000);this.#timer.unref();
 }
 async close(){this.#closed=true;clearInterval(this.#timer);await this.#busy?.catch(()=>{});}
}
export async function restoreRuntimeBackup(root:string,id:string){
 const directory=join(privatePath(root,true),'managed-backups');privatePath(directory,true);const source=verified(directory,id),restoreId=randomUUID(),destination=join(root,'restores',restoreId);
 await restoreDatabase(source.file,destination,Date.now());check(digest(coverage(join(destination,'kuinest.sqlite')))===digest(source.manifest.coverage),'RESTORE_COVERAGE_MISMATCH');
 const db=new Database(join(destination,'kuinest.sqlite'),{readonly:true,fileMustExist:true});try{
  runtimeAccess(db,()=>{throw Error('READ_ONLY');},()=>{}).verify(source.binding,false);
  check(!db.prepare('SELECT 1 FROM auth_sessions WHERE revoked_at IS NULL').get()&&!db.prepare('SELECT 1 FROM scheduled_tasks WHERE enabled=1').get(),'RESTORE_STATE_INVALID');
 }finally{db.close();}
 writeFileSync(join(destination,'runtime-binding.json'),source.bindingBytes,{flag:'wx',mode:0o600});
 writeFileSync(join(destination,'cursor.key'),randomBytes(32).toString('base64')+'\n',{flag:'wx',mode:0o600});
 // 证明仅记录已经实际恢复并校验的备份，不接受手填“已验证”开关。
 const proof={format:'kuinest-restore-verified-v1',sourceId:id,manifestDigest:digest(source.manifest),bindingDigest:digest(source.binding)};
 const proofFile=join(directory,'RESTORE-VERIFIED.json');if(existsSync(proofFile))privatePath(proofFile);
 writeFileSync(proofFile,JSON.stringify(proof,null,2)+'\n',{mode:0o600});
 return {restoreId,bindingSha256:source.manifest.bindingSha256,coverageVerified:true,started:false,modelCalls:0};
}
