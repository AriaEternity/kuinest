// 纯合成持久化/SSE资源验收；不调用模型，不读取私人目录。独立运行，不属于普通单元测试。
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {cpus,totalmem,platform,release} from 'node:os';
import {Writable} from 'node:stream';
import Database from 'better-sqlite3';
import {SqliteStorage} from '../apps/backend/dist/storage/storage.js';
import {projectRoot,foundationPorts} from '../apps/backend/dist/server.js';
import {loadConfig} from '../apps/backend/dist/config.js';
import {createApp} from '../apps/backend/dist/app.js';
import {ApiServices} from '../apps/backend/dist/application/service.js';
import {EventStreams} from '../apps/backend/dist/http/routes/events.js';
import {submission} from '../apps/backend/dist/conversations/submit.js';
import {passwords} from '../apps/backend/dist/auth/password.js';
const arg=process.argv[2]??'--duration-ms=1800000';assert.match(arg,/^--duration-ms=[0-9]+$/);assert.equal(process.argv.length,3);
const duration=Number(arg.split('=')[1]);assert.ok(duration>=60000&&duration<=3600000);
const data=join(projectRoot,'runtime/dev-synthetic','release-soak-'+randomUUID());mkdirSync(data,{recursive:true,mode:0o700});
const output=join(projectRoot,'.cache/stage10-tests');mkdirSync(output,{recursive:true});
const resultFile=join(output,'soak-'+randomUUID()+'.json'),clock={now:Date.now},ids={next:randomUUID};
const owner='synthetic-soak',conversation=randomUUID();let store=new SqliteStorage({dataRoot:data,instanceId:randomUUID(),clock});
const sample=()=>({ms:Date.now(),...process.memoryUsage()}),initial=sample();let peak=initial.rss;
const sampler=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},10);
const encoded=await passwords.hash('synthetic-soak-password');clearInterval(sampler);
store.apiAccess().initializeOwner({id:owner,username:owner,passwordHash:encoded,characterId:'synthetic-character',versionId:'synthetic-version',profileId:'synthetic-profile',createdAt:Date.now()});
store.apiAccess().createConversation(owner,conversation,'纯合成资源验收',Date.now());await store.close();
const db=new Database(join(data,'kuinest.sqlite'));db.pragma('foreign_keys=ON');
const insert=db.prepare("INSERT INTO messages(id,conversation_id,seq,role,content,status,updated_revision,created_at) VALUES (?,?,?,'user',?,'complete',?,?)");
db.transaction(()=>{for(let i=1;i<=100000;i++)insert.run('synthetic-'+i,conversation,i,'纯合成历史消息 '+i,i,Date.now());db.prepare('UPDATE conversations SET next_public_seq=100001,change_revision=100000 WHERE id=?').run(conversation);})();db.close();
store=new SqliteStorage({dataRoot:data,instanceId:randomUUID(),clock});store.startRenewal(()=>{throw Error('SOAK_LEASE_LOST');});
const config=loadConfig({NODE_ENV:'test',APP_MODE:'synthetic',DATA_ROOT:data},projectRoot),api=new ApiServices(store.apiAccess(),config,clock,ids,Buffer.alloc(32,64)),runs=store.runAccess();
const history=[],accept=[];const p95=a=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*.95)-1];
for(let i=0;i<200;i++){let start=performance.now();assert.equal(api.queries.history(owner,conversation,undefined,50).items.length,50);history.push(performance.now()-start);start=performance.now();const a=runs.submit(owner,conversation,submission({clientMessageId:randomUUID(),text:'纯合成资源输入'}),Date.now(),ids,config.limits);accept.push(performance.now()-start);const c=runs.claim(Date.now(),ids);assert.equal(c.id,a.runId);runs.append(c,'纯合成答复',Date.now());runs.finish(c,'completed',undefined,Date.now(),ids);}
assert.ok(p95(history)<=200);assert.ok(p95(accept)<=200);
const accepted=runs.submit(owner,conversation,submission({clientMessageId:randomUUID(),text:'纯合成持续流输入'}),Date.now(),ids,config.limits),claim=runs.claim(Date.now(),ids);
assert.equal(claim.id,accepted.runId);
const events=new EventStreams(store.eventAccess(),wake=>store.subscribeCommits(wake),api.sessions,clock);
const app=createApp(config,{...foundationPorts(),storage:store},{api,events,logStream:new Writable({write(_chunk,_encoding,callback){callback();}})});
await app.listen({host:'127.0.0.1',port:0});const origin='http://127.0.0.1:'+app.server.address().port;
const login=await api.sessions.login(owner,'synthetic-soak-password','127.0.0.1');
const cookie=api.sessions.cookieName+"="+login.token;const abort=new AbortController(),counts=[0,0,0,0],readers=[];
for(let i=0;i<4;i++){const response=await fetch(origin+'/api/v1/runs/'+claim.id+'/events',{headers:{cookie:cookie.split(';')[0]},signal:abort.signal});assert.equal(response.status,200);readers.push((async()=>{try{for await(const bytes of response.body)counts[i]+=bytes.length;}catch(e){if(!abort.signal.aborted)throw e;}})());}
const started=Date.now(),samples=[],diskBefore=statSync(join(data,'kuinest.sqlite')).size;
process.stdout.write(JSON.stringify({status:'started',durationMs:duration,connections:events.diagnostics.connections,historyP95Ms:p95(history),acceptP95Ms:p95(accept),resultFile})+'\n');
let outcome;
try{
 while(Date.now()-started<duration){await new Promise(r=>setTimeout(r,1000));runs.append(claim,'合成流片段。',Date.now());assert.equal(events.diagnostics.connections,4);if(samples.length===0||Date.now()-samples.at(-1).ms>=30000){global.gc?.();samples.push({...sample(),connections:events.diagnostics.connections,peakWritableBytes:events.diagnostics.peakWritableBytes});}}
 assert.ok(counts.every(x=>x>0));assert.equal(events.diagnostics.backpressureClosures,0);
 const first=samples.slice(2,12),last=samples.slice(-10),avg=(a,k)=>a.reduce((s,x)=>s+x[k],0)/a.length;
 const heapGrowth=avg(last,'heapUsed')-avg(first,'heapUsed'),rssGrowth=avg(last,'rss')-avg(first,'rss');
 outcome={status:'passed',elapsedMs:Date.now()-started,qualification:duration>=1800000?'30-minute':'short-only',machine:{platform:platform(),release:release(),cpu:cpus()[0]?.model,memoryBytes:totalmem(),node:process.version},messages:100000,connections:4,initialRss:initial.rss,passwordPeakRss:peak,historyP95Ms:p95(history),acceptP95Ms:p95(accept),heapGrowthBytes:heapGrowth,rssGrowthBytes:rssGrowth,samples,bytesRead:counts,diskBefore,diskAfter:statSync(join(data,'kuinest.sqlite')).size,walBytes:(()=>{try{return statSync(join(data,'kuinest.sqlite-wal')).size;}catch{return 0;}})(),networkModelCalls:0};
 if(duration>=1800000){assert.ok(heapGrowth<10*1024*1024,'SOAK_HEAP_GROWTH');assert.ok(rssGrowth<32*1024*1024,'SOAK_RSS_GROWTH');}
}catch(e){outcome={status:'failed',code:e instanceof Error?e.message:'SOAK_FAILED',elapsedMs:Date.now()-started,samples};process.exitCode=1;}
finally{abort.abort();await Promise.allSettled(readers);events.close();await app.close();writeFileSync(resultFile,JSON.stringify(outcome,null,2),{mode:0o600});process.stdout.write(JSON.stringify({status:outcome.status,elapsedMs:outcome.elapsedMs,resultFile})+'\n');}
