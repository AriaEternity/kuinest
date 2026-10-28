import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync,writeFileSync,linkSync} from "node:fs";
import {join} from "node:path";
import Database from "better-sqlite3";
import {startServer,projectRoot} from "../dist/server.js";
import {loadConfig,readConfigEnvironment} from "../dist/config.js";
import {runtimeCommand} from "../dist/runtime/cli.js";
import {secretText} from "../dist/runtime/files.js";
import {readBinding} from "../dist/runtime/binding.js";
import {restoreDatabase} from "../dist/storage/backup.js";
import {SqliteStorage} from "../dist/storage/storage.js";
import {releaseFixture,password,reply,freePort} from "./release-fixtures.js";
const until=async(fn:()=>boolean|Promise<boolean>)=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}assert.fail("合成运行未完成");};

test("O01：private显式开关和凭据路径固定，synthetic不读取秘密入口",async()=>{
 const f=await releaseFixture();assert.equal(loadConfig(f.env,projectRoot).allowLiveModel,true);
 for(const key of ["PROVIDER_API_KEY_FILE","RUNTIME_BINDING_SHA256","ALLOWED_PROVIDER_ORIGIN"]){const env:Record<string,string>={...f.env};delete env[key];assert.throws(()=>loadConfig(env,projectRoot));}
 for(const env of [{...f.env,BIND_HOST:"0.0.0.0"},{...f.env,TRUST_PROXY:"true"},{...f.env,CURSOR_HMAC_KEY:"invalid"}])assert.throws(()=>loadConfig(env,projectRoot));
 let reads=0;const e:Record<string,string|undefined>={APP_MODE:"synthetic"};for(const key of ["PROVIDER_API_KEY_FILE","CURSOR_HMAC_KEY_FILE","CURSOR_HMAC_KEY","DEEPSEEK_API_KEY"])Object.defineProperty(e,key,{enumerable:true,get(){reads++;throw Error("SECRET_GETTER");}});
 assert.equal(loadConfig(readConfigEnvironment(e),projectRoot).allowLiveModel,false);assert.equal(reads,0);
 assert.equal(secretText(join(f.root,"provider.key")),"synthetic-token-never-network");
 const hard=join(f.root,"linked.key");linkSync(join(f.root,"provider.key"),hard);assert.throws(()=>secretText(hard));
});
test("O01/O04：私人HTTP经实际适配器装配，登录/消息/SSE/记忆确认/重启读回完整，无外网",async t=>{
 const f=await releaseFixture();let requests=0;const transport:typeof fetch=async(url,init)=>{requests++;assert.equal(String(url),"https://synthetic-provider.invalid/v1/chat/completions");assert.equal(new Headers(init?.headers).get("authorization"),"Bearer synthetic-token-never-network");const body=JSON.parse(String(init?.body));assert.ok(body.messages[0].content.includes("纯合成发布资料"));return reply();};
 let app=await startServer(f.env,{transport});t.after(()=>app.close());let origin="http://127.0.0.1:"+f.env.PORT;
 assert.equal(requests,0);assert.equal((await fetch(origin+"/health/ready")).status,200);
 const login=await fetch(origin+"/api/v1/auth/login",{method:"POST",headers:{origin:f.env.PUBLIC_ORIGIN,"content-type":"application/json"},body:JSON.stringify({username:f.username,password})});assert.equal(login.status,200);assert.match(login.headers.get("set-cookie")!,/Secure/);
 const session=await login.json() as {csrfToken:string},cookie=login.headers.get("set-cookie")!.split(";")[0]!;
 const headers={cookie,origin:f.env.PUBLIC_ORIGIN,"content-type":"application/json","x-csrf-token":session.csrfToken};
 const post=async(url:string,body:unknown)=>{const r=await fetch(origin+url,{method:"POST",headers,body:JSON.stringify(body)});assert.ok(r.ok,String(r.status));return r.json() as Promise<any>;};
 const meta=await(await fetch(origin+"/api/v1/meta",{headers:{cookie}})).json() as any;assert.equal(meta.mode,"private");assert.equal(meta.capabilities.chat,true);assert.equal(meta.capabilities.proactiveMessages,false);
 const c=await post("/api/v1/conversations",{title:"合成发布会话"});
 const message={clientMessageId:randomUUID(),text:"合成运行输入"},accepted=await post('/api/v1/conversations/'+c.id+'/messages',message);
 const duplicate=await post('/api/v1/conversations/'+c.id+'/messages',message);assert.equal(duplicate.runId,accepted.runId);
 const stream=await fetch(origin+'/api/v1/runs/'+accepted.runId+'/events',{headers:{cookie},signal:AbortSignal.timeout(10000)});assert.equal(stream.status,200);assert.match(await stream.text(),/run.completed/);assert.equal(requests,1);
 const proposal=await post('/api/v1/conversations/'+c.id+'/memory-proposals',{clientRequestId:randomUUID(),content:"合成待确认事实"});assert.equal(proposal.status,"pending");
 const confirmed=await post('/api/v1/memory-proposals/'+proposal.id+'/confirm',{revision:proposal.revision,contentSha256:proposal.contentSha256});assert.equal(confirmed.status,"confirmed");
 await app.close();f.env.PORT=String(await freePort());app=await startServer(f.env,{transport});origin="http://127.0.0.1:"+f.env.PORT;
 const history=await(await fetch(origin+'/api/v1/conversations/'+c.id+'/messages',{headers:{cookie}})).json() as any;assert.equal(history.items.length,2);assert.ok(JSON.stringify(history).includes("合成后端答复"));assert.ok(!JSON.stringify(history).includes("纯合成发布资料"));
 const next=await post('/api/v1/conversations',{});const empty=await(await fetch(origin+'/api/v1/conversations/'+next.id+'/messages',{headers:{cookie}})).json() as any;assert.equal(empty.items.length,0);
 assert.equal((await fetch(origin+'/api/v1/conversations/'+c.id+'/messages')).status,401);
 const candidates=await(await fetch(origin+'/api/v1/conversations/'+next.id+'/memory-proposals',{headers:{cookie}})).json() as any;assert.equal(candidates.items[0].status,"confirmed");
});
test("O01/O08：角色绑定与目的地址变化阻止启动，未激活不自动激活",async()=>{
 const f=await releaseFixture(false);let calls=0;
 await assert.rejects(()=>startServer(f.env,{transport:async()=>{calls++;return reply();}}));assert.equal(calls,0);
 const db=new Database(join(f.root,"kuinest.sqlite"),{readonly:true});try{assert.notEqual((db.prepare('SELECT active_version_id AS id FROM characters').get() as any).id,f.version);}finally{db.close();}
 writeFileSync(join(f.root,"runtime-binding.json"),JSON.stringify({...f.binding,version:"wrong-version"}));assert.throws(()=>readBinding(f.root,f.env.RUNTIME_BINDING_SHA256));
 const active=await releaseFixture();await assert.rejects(()=>startServer({...active.env,ALLOWED_PROVIDER_ORIGIN:"https://different.invalid"}));
});
test("O01/O08：离线账号设置和明确激活不发请求，检查入口保留profile未验证状态",async()=>{
 const f=await releaseFixture(false),answers=["synthetic-new-user",password,password];
 assert.equal((await runtimeCommand(["owner-setup"],f.env,async()=>answers.shift()!)).ok,true);
 await assert.rejects(()=>runtimeCommand(["activate"],f.env,async()=>"NO"));
 assert.equal((await runtimeCommand(["activate"],f.env,async()=>"ACTIVATE")).modelCalls,0);
 assert.equal((await runtimeCommand(["check-runtime"],f.env)).ok,true);
 const db=new Database(join(f.root,"kuinest.sqlite"),{readonly:true});try{assert.equal((db.prepare("SELECT compatibility_status AS s FROM provider_profiles WHERE id='profile-release'").get() as any).s,"unverified");assert.equal((db.prepare("SELECT count(*) AS n FROM provider_calls").get() as any).n,0);}finally{db.close();}
});
test("O05：私人模式数据库快照恢复保留绑定资料，撤销登录且恢复目录不自动启动",async()=>{
 const f=await releaseFixture(),store=new SqliteStorage({dataRoot:f.root,instanceId:randomUUID(),clock:{now:Date.now}}),backup=join(f.root,'backups',randomUUID()+'.sqlite');
 try{store.runtimeAccess().verify(f.binding);await store.backup(backup);}finally{await store.close();}
 const restored=join(f.root,'restores',randomUUID());await restoreDatabase(backup,restored,Date.now());
 const db=new Database(join(restored,'kuinest.sqlite'),{readonly:true});try{assert.equal((db.prepare('SELECT count(*) AS n FROM character_documents').get() as any).n,9);assert.equal((db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get() as any).n,0);assert.equal((db.prepare('SELECT count(*) AS n FROM scheduled_tasks WHERE enabled=1').get() as any).n,0);}finally{db.close();}
});
test("O01/O07：上游限流返回固定错误且不重试，服务可继续接受新请求",async t=>{
 const f=await releaseFixture();let calls=0;const app=await startServer(f.env,{transport:async()=>{calls++;return new Response('synthetic-upstream-secret',{status:429,headers:{'retry-after':'2'}});}});t.after(()=>app.close());
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:f.env.PUBLIC_ORIGIN},payload:{username:f.username,password}});const cookie=String(login.headers['set-cookie']).split(';')[0]!,headers={cookie,origin:f.env.PUBLIC_ORIGIN,'x-csrf-token':login.json().csrfToken};
 const c=(await app.inject({method:'POST',url:'/api/v1/conversations',headers,payload:{}})).json();const a=(await app.inject({method:'POST',url:'/api/v1/conversations/'+c.id+'/messages',headers,payload:{clientMessageId:randomUUID(),text:'合成限流输入'}})).json();
 let snapshot:any;await until(async()=>{snapshot=(await app.inject({url:'/api/v1/runs/'+a.runId,headers:{cookie}})).json();return snapshot.status==='failed';});assert.equal(snapshot.error.code,'UPSTREAM_RATE_LIMIT');assert.ok(!JSON.stringify(snapshot).includes('synthetic-upstream-secret'));assert.equal(calls,1);assert.equal((await app.inject('/health/ready')).statusCode,200);
});

test("O05/O08：全新运行候选先验证回退，来源和角色/记忆不变，已使用来源拒绝",async()=>{
 const {prepareRuntime,runtimeFileHash}=await import('../../../tools/import-openclaw/dist/runtime-prepare.js');
 const f=await releaseFixture(false),source=join(f.root,'kuinest.sqlite');const db=new Database(source);db.prepare('UPDATE characters SET active_version_id=NULL').run();db.close();
 const sha=runtimeFileHash(source),output=join(projectRoot,'.cache/stage10-tests','runtime-'+randomUUID());
 const result=await prepareRuntime(source,sha,f.version,output,'synthetic');assert.equal(result.rollbackVerified,true);assert.equal(result.documents,7);assert.equal(result.contextEntries,0);assert.equal(result.activated,false);assert.equal(result.modelCalls,0);assert.equal(runtimeFileHash(source),sha);
 const copy=new Database(join(output,'data/kuinest.sqlite'),{readonly:true});try{assert.equal((copy.prepare('SELECT count(*) AS n FROM characters WHERE active_version_id IS NOT NULL').get() as any).n,0);}finally{copy.close();}
 await assert.rejects(()=>prepareRuntime(source,'0'.repeat(64),f.version,join(projectRoot,'.cache/stage10-tests','runtime-'+randomUUID()),'synthetic'));
 const used=await releaseFixture();await assert.rejects(()=>prepareRuntime(join(used.root,'kuinest.sqlite'),runtimeFileHash(join(used.root,'kuinest.sqlite')),used.version,join(projectRoot,'.cache/stage10-tests','runtime-'+randomUUID()),'synthetic'));
});

test("O05：受控备份包含绑定与覆盖清单，实际恢复后才允许7日4周清理",async()=>{
 const {RuntimeBackups,restoreRuntimeBackup,selectBackups}=await import('../dist/runtime/backups.js');
 const f=await releaseFixture(),store=new SqliteStorage({dataRoot:f.root,instanceId:randomUUID(),clock:{now:Date.now}});store.startRenewal(()=>{});
 const manager=new RuntimeBackups(store,f.root,f.binding);try{
  assert.throws(()=>manager.prune());const first=await manager.create(Date.now()-50*86400000);
  const restored=await restoreRuntimeBackup(f.root,first.id);assert.equal(restored.coverageVerified,true);assert.equal(restored.started,false);assert.equal(restored.modelCalls,0);
  const bytes=readFileSync(join(f.root,'restores',restored.restoreId,'runtime-binding.json'));assert.ok(bytes.length>0);assert.equal(readFileSync(join(f.root,'restores',restored.restoreId,'cursor.key'),'utf8').trim().length,44);
  for(let i=12;i>=0;i--)await manager.create(Date.now()-i*86400000);
  const {readdirSync}=await import('node:fs');const before=readdirSync(join(f.root,'managed-backups')).filter(x=>x.endsWith('.sqlite')).length;
  const oldPath=join(f.root,'managed-backups',first.id+'.binding.json'),original=readFileSync(oldPath);writeFileSync(oldPath,'{}');assert.throws(()=>manager.prune());assert.equal(readdirSync(join(f.root,'managed-backups')).filter(x=>x.endsWith('.sqlite')).length,before);writeFileSync(oldPath,original);
  assert.ok(manager.prune()>0);assert.ok(readFileSync(join(f.root,'managed-backups',first.id+'.sqlite')).length>0);
  const rows=Array.from({length:60},(_,i)=>({id:String(i),createdAt:Date.now()-i*86400000}));const keep=selectBackups(rows);for(let i=0;i<7;i++)assert.ok(keep.has(String(i)));assert.ok(keep.size>=9&&keep.size<=11);
 }finally{await manager.close();await store.close();}
});

test("O06：仅回环代理头受信任，私有错误日志不回显正文、Cookie或原始URI",async t=>{
 const {createApp}=await import('../dist/app.js'),{foundationPorts}=await import('../dist/server.js'),{Writable}=await import('node:stream');
 const f=await releaseFixture();let logs='';const app=createApp(loadConfig(f.env,projectRoot),foundationPorts(),{logStream:new Writable({write(chunk,_enc,cb){logs+=String(chunk);cb();}})});t.after(()=>app.close());
 app.get('/synthetic-address',async request=>({ip:request.ip}));
 const forwarded={'x-forwarded-for':'203.0.113.17'};
 assert.equal((await app.inject({url:'/synthetic-address',remoteAddress:'127.0.0.1',headers:forwarded})).json().ip,'203.0.113.17');
 assert.equal((await app.inject({url:'/synthetic-address',remoteAddress:'198.51.100.22',headers:forwarded})).json().ip,'198.51.100.22');
 const response=await app.inject({method:'POST',url:'/synthetic-missing?secret=synthetic-log-secret',headers:{cookie:'synthetic-cookie-secret',authorization:'Bearer synthetic-auth-secret'},payload:{text:'synthetic-body-secret'}});assert.equal(response.statusCode,404);
 assert.doesNotMatch(logs,/synthetic-log-secret|synthetic-cookie-secret|synthetic-auth-secret|synthetic-body-secret|synthetic-missing/);
});
test("O01：私人数据库sidecar和凭据路径均拒绝硬链接，不绕过启动边界",async()=>{
 const {privateDatabase}=await import('../dist/runtime/files.js');const f=await releaseFixture();
 linkSync(join(f.root,'provider.key'),join(f.root,'kuinest.sqlite-wal'));assert.throws(()=>privateDatabase(f.root));await assert.rejects(()=>startServer(f.env));
});

test("O01：固定角色缺少原七份资料时拒绝装配，不把部分人设作为完整版本",async()=>{
 const f=await releaseFixture(),db=new Database(join(f.root,'kuinest.sqlite'));try{db.prepare("DELETE FROM character_documents WHERE version_id=? AND logical_name='SOUL.md'").run(f.version);}finally{db.close();}
 await assert.rejects(()=>startServer(f.env));
});
