import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fixture,inspect,mutate,isCode,doc} from "./context-fixtures.js";
import {fixture as authFixture,writeHeaders} from "./auth-fixtures.js";
import {defaults} from "../dist/context/profile.js";
import {readContract} from "@kuinest/contracts";
import {restrictedTools} from "../dist/tools/registry.js";
import {compile} from "../dist/context/compiler.js";
import {projectRoot} from "../dist/server.js";
const reviewConfig={memoryReviewEnabled:true,memoryWriteKeys:[]};
const mark=(r:{revision:number;contentSha256:string})=>({revision:r.revision,contentSha256:r.contentSha256});
test("MR01：候选不可检索，确认独立新增，原记忆与角色文档保持字节一致",t=>{
 const f=fixture(t);f.publish("合成基线");f.storage.memoryAccess().write("owner-a",{characterId:"character-a",key:"MEMORY.md",expectedVersion:null,content:"合成冻结基线",provenance:{source:"synthetic",reference:"test"}},f.ids.next(),f.clock.now());f.publish("合成基线",reviewConfig);
 const baseline=inspect(f.root,db=>db.prepare("SELECT * FROM memory_versions").all()),docs=inspect(f.root,db=>db.prepare("SELECT * FROM character_documents").all());
 const r=f.storage.memoryReviewAccess(),p=r.proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content:"合成偏好海蓝积木"});
 assert.equal(f.storage.memoryAccess().search("owner-a","character-a","海蓝").length,0);assert.equal(p.status,"pending");readContract("memoryProposal",p);
 const saved=r.decide("owner-a",p.id,mark(p),"confirmed");assert.match(saved.memoryKey!,/^memory\/confirmed-/);assert.deepEqual(r.decide("owner-a",p.id,mark(p),"confirmed"),saved);
 assert.equal(f.storage.memoryAccess().search("owner-a","character-a","海蓝").length,1);
 inspect(f.root,db=>{assert.deepEqual(db.prepare("SELECT * FROM memory_versions WHERE logical_key='MEMORY.md'").all(),baseline);assert.deepEqual(db.prepare("SELECT * FROM character_documents").all(),docs);assert.equal((db.prepare("SELECT count(*) AS n FROM memory_versions").get() as {n:number}).n,2);});
});
test("MR02：编辑使旧确认失效；拒绝、重复拒绝与相反决定互斥",t=>{
 const f=fixture(t);f.publish("合成",reviewConfig);const r=f.storage.memoryReviewAccess(),p=r.proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content:"合成草稿"});
 const edited=r.edit("owner-a",p.id,{...mark(p),content:"合成修改"});assert.equal(edited.revision,2);assert.throws(()=>r.decide("owner-a",p.id,mark(p),"confirmed"),isCode("MEMORY_REVIEW_CONFLICT"));
 assert.throws(()=>r.decide("owner-a",p.id,{revision:2,contentSha256:"0".repeat(64)},"confirmed"),isCode("MEMORY_REVIEW_CONFLICT"));
 const rejected=r.decide("owner-a",p.id,mark(edited),"rejected");assert.deepEqual(r.decide("owner-a",p.id,mark(edited),"rejected"),rejected);
 assert.throws(()=>r.decide("owner-a",p.id,mark(edited),"confirmed"),isCode("MEMORY_REVIEW_CONFLICT"));assert.throws(()=>r.edit("owner-a",p.id,{...mark(edited),content:"合成再改"}),isCode("MEMORY_REVIEW_CONFLICT"));assert.equal(f.storage.memoryAccess().search("owner-a","character-a","合成修改").length,0);
});
test("MR03：跨用户、伪造归属、请求重放改内容及非法正文拒绝",t=>{
 const f=fixture(t);f.publish("合成",reviewConfig);const r=f.storage.memoryReviewAccess(),request={clientRequestId:f.ids.next(),content:"合成候选"},p=r.proposeUser("owner-a","character-a",request);
 assert.deepEqual(r.proposeUser("owner-a","character-a",request),p);assert.throws(()=>r.proposeUser("owner-a","character-a",{...request,content:"改动"}),isCode("IDEMPOTENCY_CONFLICT"));
 for(const action of [()=>r.get("other",p.id),()=>r.list("other","character-a"),()=>r.decide("other",p.id,mark(p),"confirmed"),()=>r.edit("other",p.id,{...mark(p),content:"伪造"})])assert.throws(action,isCode("NOT_FOUND"));
 for(const content of [" ","葵".repeat(11000),"x".repeat(16001),"\ud800"])assert.throws(()=>r.proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content}),isCode("INPUT_INVALID"));
});
test("MR04：容量耗尽时确认原子回滚，不留下有效记忆或确认标记",t=>{
 const f=fixture(t);f.publish("合成",reviewConfig);const r=f.storage.memoryReviewAccess(),p=r.proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content:"新合成记忆"});
 mutate(f,db=>{for(let i=0;i<200;i++){db.prepare("INSERT INTO memory_versions(id,character_id,logical_key,version,content,provenance_json,created_at) VALUES(?,'character-a',?,1,'合成','{}',1)").run("cap-"+i,"memory/cap-"+i+".md");db.prepare("INSERT INTO memory_heads VALUES('character-a',?,?)").run("memory/cap-"+i+".md","cap-"+i);}});
 assert.throws(()=>r.decide("owner-a",p.id,mark(p),"confirmed"),isCode("MEMORY_REVIEW_LIMIT"));assert.equal(r.get("owner-a",p.id).status,"pending");inspect(f.root,db=>assert.equal((db.prepare("SELECT count(*) AS n FROM memory_versions").get() as {n:number}).n,200));
});
test("MR05：待确认上限及修订上限防止无界累积，分页不跨角色",t=>{
 const f=fixture(t);f.publish("合成",reviewConfig);const r=f.storage.memoryReviewAccess();let first=r.proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content:"合成1"});
 for(let i=2;i<=20;i++)first=r.edit("owner-a",first.id,{...mark(first),content:"合成"+i});assert.throws(()=>r.edit("owner-a",first.id,{...mark(first),content:"第21次"}),isCode("MEMORY_REVIEW_LIMIT"));
 for(let i=1;i<100;i++)r.proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content:"合成"+i});assert.throws(()=>r.proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content:"超过上限"}),isCode("MEMORY_REVIEW_LIMIT"));
 const page=r.list("owner-a","character-a",undefined,50),next=r.list("owner-a","character-a",page.nextCursor!,50);assert.equal(page.items.length,50);assert.equal(next.items.length,50);assert.equal(next.nextCursor,null);assert.equal(new Set([...page.items,...next.items].map(p=>p.id)).size,100);
});
test("MR06：模型仅提出候选，真实工具档案绑定并幂等，伪造和取消后拒绝",async t=>{
 const f=fixture(t);f.publish("合成",reviewConfig);f.submit();const store=f.store,claim=store.claim(f.clock.now(),f.ids)!,input=f.storage.contextAccess().load(claim),r=f.storage.memoryReviewAccess();
 const tools=restrictedTools(claim,input,{control:store.control,memory:f.storage.memoryAccess(),review:r,clock:f.clock,ids:f.ids}),signal=new AbortController().signal;
 assert.deepEqual(tools.definitions.map(x=>(x.function as {name:string}).name),["clock_now","memory_search","memory_get","memory_propose"]);
 const tool={id:"synthetic-call",type:"function" as const,function:{name:"memory_propose",arguments:JSON.stringify({content:"合成蓝色飞船"})}},protocol=f.storage.protocolAccess(),callId=protocol.begin(claim,f.ids.next(),{system:"合成",messages:[],tools:tools.definitions,options:{}},f.clock.now());
 protocol.checkpoint(claim,callId,{assistant:{role:"assistant",content:"",tool_calls:[tool]},finish_reason:"tool_calls"},"completed",f.clock.now());const toolId=protocol.beginTool(claim,callId,f.ids.next(),tool,f.clock.now()).id;
 assert.equal((await tools.invoke(tool,signal,{toolCallId:"forged"})).failed,true);const answer=await tools.invoke(tool,signal,{toolCallId:toolId});assert.equal(answer.failed,false);assert.equal(JSON.parse(answer.message.content).result.saved,false);assert.deepEqual(await tools.invoke(tool,signal,{toolCallId:toolId}),answer);
 assert.equal(r.list("owner-a","character-a").items.length,1);assert.equal(f.storage.memoryAccess().search("owner-a","character-a","蓝色飞船").length,0);
 assert.equal((await tools.invoke({...tool,function:{name:"memory_confirm",arguments:"{}"}},signal)).failed,true);store.cancel("owner-a",claim.id,f.clock.now(),f.ids);assert.equal((await tools.invoke(tool,signal,{toolCallId:toolId})).failed,true);
});
test("MR07：确认后重启仍可检索，新窗口共享记忆且不带旧窗口上下文",async t=>{
 const f=fixture(t);f.publish("合成",reviewConfig);const r=f.storage.memoryReviewAccess(),p=r.proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content:"合成蓝色飞船"});r.decide("owner-a",p.id,mark(p),"confirmed");await f.reopen();
 assert.equal(f.storage.memoryAccess().search("owner-a","character-a","蓝色飞船").length,1);f.storage.write("owner-a",repo=>repo.createConversation("new-window","character-a","合成新窗口",f.clock.now()));
 const {submission}=await import("../dist/conversations/submit.js");f.store.submit("owner-a","new-window",submission({clientMessageId:f.ids.next(),text:"蓝色飞船"}),f.clock.now(),f.ids,f.config.limits);const claim=f.store.claim(f.clock.now(),f.ids)!,pinned=f.storage.contextAccess().load(claim),compiled=compile(pinned,[]);assert.equal(pinned.entries.length,1);assert.equal(compiled.request.messages.length,1);assert.match(compiled.request.system,/合成蓝色飞船/);
});
test("MR08：关闭审阅默认无新增权限，不能与直接写入同时启用",t=>{
 const f=fixture(t);assert.throws(()=>f.storage.memoryReviewAccess().proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content:"合成"}),isCode("SERVICE_NOT_READY"));assert.throws(()=>f.publish("合成",{memoryReviewEnabled:true}),isCode("PROFILE_INVALID"));
});
test("MR09：认证接口执行确认流程，CSRF/额外字段拒绝，日志无候选正文",async t=>{
 const f=authFixture(t);f.init();const version=f.storage.characterAccess().publish("owner-a",{characterId:"character-a",versionId:"review-v",profile:{id:"review-p",provider:"mock",model:"synthetic",endpoint:null,options:{},status:"synthetic"},config:{...defaults,...reviewConfig},documents:[doc("SOUL.md","合成")]},f.clock.now());f.storage.characterAccess().activate("owner-a","character-a",version);const session=await f.login(),headers=writeHeaders(session),c=f.api.queries.createConversation("owner-a","合成");const url="/api/v1/conversations/"+c.id+"/memory-proposals",payload={clientRequestId:"11111111-1111-4111-8111-111111111111",content:"SYNTHETIC_PRIVATE_BODY_MARKER"};
 assert.equal((await f.app.inject({method:"POST",url,payload})).statusCode,401);assert.equal((await f.app.inject({method:"POST",url,payload,headers:{cookie:session.cookie,origin:f.config.publicOrigin}})).statusCode,403);
 assert.equal((await f.app.inject({method:"POST",url,payload:{...payload,confirmed:true},headers})).statusCode,400);
 const response=await f.app.inject({method:"POST",url,payload,headers});assert.equal(response.statusCode,200,response.body);const p=readContract("memoryProposal",response.json());
 const confirm=await f.app.inject({method:"POST",url:"/api/v1/memory-proposals/"+p.id+"/confirm",payload:mark(p),headers});assert.equal(confirm.statusCode,200,confirm.body);assert.equal(confirm.json().status,"confirmed");
 const page=await f.app.inject({method:"GET",url,headers:{cookie:session.cookie}});readContract("memoryProposalPage",page.json());assert.equal(f.logs().includes(payload.content),false);
 readContract("memoryProposalPage",JSON.parse(readFileSync(join(projectRoot,"fixtures/chat/memory-proposals.json"),"utf8")));
});

test("MR10：同一用户的不同角色隔离检索、队列和分页游标",t=>{
 const f=fixture(t);f.publish("合成甲",reviewConfig);mutate(f,db=>db.prepare("INSERT INTO characters(id,owner_id,name,created_at) VALUES('character-b','owner-a','合成乙',1)").run());
 f.storage.characterAccess().publish("owner-a",{characterId:"character-b",versionId:"version-b",profile:{id:"profile-b",provider:"mock",model:"synthetic",endpoint:null,options:{},status:"synthetic"},config:{...defaults,...reviewConfig},documents:[doc("SOUL.md","合成乙")]},f.clock.now());f.storage.characterAccess().activate("owner-a","character-b","version-b");
 const r=f.storage.memoryReviewAccess(),p=r.proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content:"合成甲专属紫色积木"});r.decide("owner-a",p.id,mark(p),"confirmed");assert.equal(r.list("owner-a","character-b").items.length,0);assert.equal(f.storage.memoryAccess().search("owner-a","character-b","紫色积木").length,0);assert.throws(()=>r.list("owner-a","character-b",p.id),isCode("CURSOR_INVALID"));
});
test("MR11：确认事务末尾失败时新增头和版本一起回滚，可安全重新确认",t=>{
 const f=fixture(t);f.publish("合成",reviewConfig);const r=f.storage.memoryReviewAccess(),p=r.proposeUser("owner-a","character-a",{clientRequestId:f.ids.next(),content:"合成事务检查"});
 mutate(f,db=>db.exec("CREATE TRIGGER synthetic_review_failure BEFORE UPDATE ON memory_proposals WHEN NEW.status='confirmed' BEGIN SELECT RAISE(ABORT,'synthetic-failure'); END;"));
 assert.throws(()=>r.decide("owner-a",p.id,mark(p),"confirmed"));assert.equal(r.get("owner-a",p.id).status,"pending");inspect(f.root,db=>{for(const table of ["memory_versions","memory_heads"])assert.equal((db.prepare("SELECT count(*) AS n FROM "+table).get() as {n:number}).n,0);});
 mutate(f,db=>db.exec("DROP TRIGGER synthetic_review_failure"));const confirmed=r.decide("owner-a",p.id,mark(p),"confirmed");assert.equal(confirmed.status,"confirmed");assert.throws(()=>r.decide("owner-a",p.id,mark(p),"rejected"),isCode("MEMORY_REVIEW_CONFLICT"));
});
