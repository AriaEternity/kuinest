// O03一次性迁移预演：16MiB纯合成旧档，空聊天模式，不读取私人来源。
import {fixture,put,key} from '../apps/backend/dist-test/import-fixtures.js';
import {dryRun} from '../tools/import-openclaw/dist/apply.js';
import {projectRoot} from '../apps/backend/dist/server.js';
import Database from 'better-sqlite3';import {join} from 'node:path';import {statSync,writeFileSync,mkdirSync} from 'node:fs';import {randomUUID} from 'node:crypto';import assert from 'node:assert/strict';
const initialRss=process.memoryUsage().rss,f=fixture();f.definition.migrationMode='fresh-start-v1';f.definition.requireReasoning=false;f.definition.conversations=[{key,history:[]}];
const text=JSON.stringify({type:'message',id:'synthetic-archive',message:{role:'user',content:'x'.repeat(16300)}})+'\n';const bytes=text.repeat(1024);put(f.input,'sessions/'+f.sessionId+'.jsonl',bytes);
const start=performance.now();f.build();const result=dryRun(f.batch,join(f.directory,'preview'));assert.equal(result.ok,true);
const file=join(f.directory,'preview/candidate/kuinest.sqlite'),db=new Database(file,{readonly:true});let count;try{count=db.prepare('SELECT count(*) AS n FROM context_entries').get().n;assert.equal(count,0);}finally{db.close();}
const report={status:'passed',node:process.version,platform:process.platform,initialRss,peakRssBytes:process.resourceUsage().maxRSS*1024,archiveBytes:Buffer.byteLength(bytes),elapsedMs:performance.now()-start,databaseBytes:statSync(file).size,contextEntries:count,modelCalls:0,mode:'fresh-start-v1',note:'代表性16MiB原档预演；不是256MiB总输入上限或目标主机容量承诺'};
const directory=join(projectRoot,'.cache/stage10-tests');mkdirSync(directory,{recursive:true});const output=join(directory,'import-resources-'+randomUUID()+'.json');writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,path:output}));
