// O03合成极限上下文编排资源记录；不读取任何角色或真实聊天。
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {compile} from '../apps/backend/dist/context/compiler.js';
import {config,hash} from '../apps/backend/dist/context/profile.js';
import {projectRoot} from '../apps/backend/dist/server.js';
const startRss=process.memoryUsage().rss,c=config({memoryReviewEnabled:true,memoryWriteKeys:[]});
const documents=[['IDENTITY.md','合'.repeat(60000)],['SOUL.md','成'.repeat(60000)]].map(([name,text])=>({name,bytes:Buffer.from(text),sha256:hash(text)}));
const profile={id:'synthetic-resource',provider:'mock',model:'synthetic',endpoint:null,options:{maxTokens:32768},status:'synthetic'};
const pinned={snapshotId:'synthetic-snapshot',characterId:'synthetic-character',versionId:'synthetic-version',profile,config:c,documents,memories:[],entries:[],boundary:'current',branchId:'synthetic-branch',receivedAt:0};
const run=units=>compile({...pinned,entries:[{id:'current',parentId:null,branchId:'synthetic-branch',kind:'message',payload:{role:'user',content:'x'.repeat(units)}}]},[]);
let low=1,high=1000000;while(low<high){const mid=Math.ceil((low+high)/2);if(run(mid).budget.fits)low=mid;else high=mid-1;}
const max=run(low),overflow=run(low+1);assert.equal(max.budget.fits,true);assert.equal(overflow.budget.fits,false);assert.equal(max.budget.input,max.budget.available);
// 完整父链可到1万条/32MiB；选择约30MiB的合成链，必须报告超预算，不能静默丢旧条目。
const entries=Array.from({length:10000},(_,i)=>({id:'entry-'+i,parentId:i?'entry-'+(i-1):null,branchId:'synthetic-branch',kind:'message',payload:{role:i%2?'assistant':'user',content:'s'.repeat(3000)}}));
const large=compile({...pinned,entries,boundary:entries.at(-1).id},[]);assert.equal(large.budget.fits,false);assert.equal(large.manifest.selectedEntryIds.length,10000);
const result={status:'passed',node:process.version,platform:process.platform,initialRss:startRss,peakRssBytes:process.resourceUsage().maxRSS*1024,endingRss:process.memoryUsage().rss,window:c.windowTokens,available:max.budget.available,exactFitInput:max.budget.input,overByOneRejected:!overflow.budget.fits,largeChainEntries:10000,largeChainTextBytes:30000000,largeChainFits:false,modelCalls:0};
const output=join(projectRoot,'.cache/stage10-tests');mkdirSync(output,{recursive:true});const path=join(output,'resources-'+randomUUID()+'.json');writeFileSync(path,JSON.stringify(result,null,2));process.stdout.write(JSON.stringify({...result,path})+'\n');
