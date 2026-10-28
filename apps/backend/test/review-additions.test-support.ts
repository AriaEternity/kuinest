import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { capture } from "../../../tools/import-openclaw/dist/capture.js";
import { scope } from "../../../tools/import-openclaw/dist/manifest.js";
import { apply, verify } from "../../../tools/import-openclaw/dist/apply.js";
import { analyze } from "../../../tools/import-openclaw/dist/validate.js";
import { hash } from "../../../tools/import-openclaw/dist/safe.js";
import { compile } from "../dist/context/compiler.js";
import { config } from "../dist/context/profile.js";
import { memoryRows } from "../dist/storage/context-records.js";
import { fixture, inspect, put, key } from "./import-fixtures.js";
import type { Scope } from "../../../tools/import-openclaw/dist/types.js";
import type { Document, Profile } from "../dist/context/types.js";
const failure=(code:string)=>(e:unknown)=>(e as {code?:string}).code===code;
function reviewed() {
  const f=fixture();f.definition.migrationMode="fresh-start-v1";f.definition.requireReasoning=false;f.definition.conversations=[{key,history:[]}];
  const baseline=f.definition.files.filter(f=>f.kind==="document"||f.kind==="memory").map(f=>({path:f.path,sha256:hash(f.kind==="document"?"纯合成资料："+f.path.slice(10)+"。":"虚构测试：纸船在盒子里。")}));
  const additions=[{path:"workspace/USER.addendum.md",role:"USER" as const,body:"USER_SYNTHETIC_ADDITION"},{path:"workspace/MEMORY.addendum.md",role:"MEMORY" as const,body:"MEMORY_SYNTHETIC_ADDITION"},{path:"workspace/memory/shared-synthetic.md",role:"memory" as const,body:"纸船 THEMATIC_SYNTHETIC_ADDITION"}];
  for(const a of additions){put(f.input,a.path,a.body);f.definition.files.push({path:a.path,kind:a.role==="memory"?"memory":"addition"});}
  f.definition.reviewedAdditions={reviewSha256:hash("synthetic-review"),rollbackSha256:hash("synthetic-rollback"),baselineReceiptSha256:hash("synthetic-receipt"),baseline,files:additions.map(({body,...a})=>({...a,sha256:hash(body)}))};
  f.definition.config.documentOrder=f.definition.config.documentOrder.flatMap(n=>n==="USER.md"||n==="MEMORY.md"?[n,n.replace(".md",".addendum.md")]:[n]);
  f.definition.config.memoryReadKeys.push("memory/shared-synthetic.md");f.definition.config.memoryWriteKeys=[];
  put(f.input,"sessions/"+f.sessionId+".jsonl","OLD_ARCHIVE_SYNTHETIC_DO_NOT_INJECT");
  return {...f,additions};
}
test("RA01：独立增补端到端入库，基线原字节保留，空会话与来源可验证",()=>{
  const f=reviewed(),bundle=f.build();assert.deepEqual(analyze(bundle).gaps,[]);apply(f.batch,f.target,"owner");assert.equal(verify(f.target).records,0);
  inspect(f.target,db=>{
    const v=db.prepare("SELECT id,character_id AS character,config_json AS config,provider_profile_id AS provider FROM character_versions").get() as {id:string;character:string;config:string;provider:string};
    const docs=db.prepare("SELECT logical_name AS name,content AS bytes,sha256 FROM character_documents WHERE version_id=?").all(v.id) as Document[];
    assert.equal(docs.length,9);for(const original of bundle.manifest.files.filter(f=>f.kind==="document")){const d=docs.find(d=>d.name===original.path.slice(10))!;assert.ok(Buffer.from(d.bytes).equals(bundle.files.get(original.path)!));}
    const memories=memoryRows(db,v.character),added=memories.find(m=>m.key==="memory/shared-synthetic.md")!;
    assert.equal((added.provenance as {kind:string}).kind,"confirmed-review-addition");
    const p=db.prepare("SELECT id,provider,model,endpoint,options_json AS options,compatibility_status AS status FROM provider_profiles WHERE id=?").get(v.provider) as Omit<Profile,"options">&{options:string};
    const entry={id:"new-user",parentId:null,branchId:"new-branch",kind:"message",payload:{role:"user",content:"纸船"}};
    const output=compile({snapshotId:"synthetic",characterId:v.character,versionId:v.id,profile:{...p,options:JSON.parse(p.options)},config:JSON.parse(v.config),documents:docs,memories,entries:[entry],boundary:entry.id,branchId:entry.branchId,receivedAt:1},[]);
    for(const a of f.additions)assert.ok(output.request.system.includes(a.body));
    assert.ok(!output.request.system.includes("OLD_ARCHIVE_SYNTHETIC_DO_NOT_INJECT"));assert.equal(output.request.messages.length,1);
    assert.equal((db.prepare("SELECT active_version_id FROM characters").get() as {active_version_id:null}).active_version_id,null);
    assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries").get() as {n:number}).n,0);
  });
});
test("RA02：没有审阅绑定的附加层及直接REVIEW格式均拒绝",()=>{
  const f=reviewed();delete f.definition.reviewedAdditions;assert.throws(()=>f.build(),failure("REVIEW_REQUIRED"));assert.throws(()=>scope({format:"review-manifest",status:"confirmed"}),failure("MANIFEST_INVALID"));
});
test("RA03：USER与MEMORY层必须紧随对应基线，不允许SOUL层",()=>{
  const f=reviewed();f.definition.config.documentOrder.reverse();assert.throws(()=>config(f.definition.config));
  const g=reviewed();g.definition.files.find(f=>f.kind==="addition")!.path="workspace/SOUL.addendum.md";assert.throws(()=>g.build(),failure("FILE_ALLOWLIST"));
});
test("RA04：基线正文被改写时拒绝候选",()=>{const f=reviewed();put(f.input,"workspace/USER.md","CHANGED_SYNTHETIC_BASELINE");assert.throws(()=>f.build(),failure("REVIEW_BASELINE_INVALID"));});
test("RA05：附加层正文与确认哈希不同则拒绝",()=>{const f=reviewed();put(f.input,"workspace/USER.addendum.md","CHANGED_SYNTHETIC_ADDITION");assert.throws(()=>f.build(),failure("REVIEW_HASH_MISMATCH"));});
test("RA06：新增主题必须可读，基线清单不得遗漏或冒领原档",()=>{
  const f=reviewed();f.definition.config.memoryReadKeys=["MEMORY.md","memory/synthetic.md"];assert.throws(()=>f.build(),failure("REVIEW_NOT_READABLE"));
  const g=reviewed();g.definition.reviewedAdditions!.baseline.pop();assert.throws(()=>g.build(),failure("REVIEW_COVERAGE"));
  const h=reviewed();h.definition.reviewedAdditions!.files[2]!.path="sessions/"+h.sessionId+".jsonl";assert.throws(()=>h.build(),failure("REVIEW_TARGET"));
});
test("RA07：缺失基线、缺失附加层或重复绑定均拒绝",()=>{
  const f=reviewed();f.definition.files=f.definition.files.filter(f=>f.path!=="workspace/USER.md");assert.throws(()=>f.build(),failure("DOCUMENT_MISSING"));
  const g=reviewed();g.definition.files=g.definition.files.filter(f=>f.path!=="workspace/USER.addendum.md");assert.throws(()=>g.build(),failure("REVIEW_TARGET"));
  const h=reviewed();h.definition.reviewedAdditions!.files[1]=h.definition.reviewedAdditions!.files[0]!;assert.throws(()=>h.build(),failure("REVIEW_INVALID"));
});
test("RA08：附加层超预算只标缺口，不静默截断后应用",()=>{
  const f=reviewed();f.definition.config.totalChars=10;const a=analyze(f.build());assert.ok(a.gaps.includes("BOOTSTRAP_TRUNCATION"));assert.throws(()=>apply(f.batch,f.target,"owner"),failure("COMPATIBILITY_GAPS"));
});
function delta(f:ReturnType<typeof reviewed>,parent:string):Scope{return {...structuredClone(f.definition),batchId:randomUUID(),revision:2,parent};}
test("RA09：后续增量不能移除审阅保护或改写已确认基线",()=>{
  const f=reviewed(),b=f.build();apply(f.batch,f.target,"owner");const d=delta(f,b.manifestHash);put(f.input,"workspace/USER.md","NEW_SYNTHETIC_BASELINE");d.reviewedAdditions!.baseline.find(f=>f.path==="workspace/USER.md")!.sha256=hash("NEW_SYNTHETIC_BASELINE");
  const batch=join(f.directory,"delta");capture(f.input,batch,d);assert.throws(()=>apply(batch,f.target,"owner"),failure("REVIEW_BASELINE_CHANGED"));
  const g=delta(f,b.manifestHash);delete g.reviewedAdditions;g.files=g.files.filter(f=>f.kind!=="addition");g.config.documentOrder=g.config.documentOrder.filter(n=>!n.includes(".addendum"));const drop=join(f.directory,"drop");capture(f.input,drop,g);assert.throws(()=>apply(drop,f.target,"owner"),failure("REVIEW_BASELINE_CHANGED"));
});
test("RA10：仅更新旧聊天归档的增量仍被允许且不注入",()=>{
  const f=reviewed(),b=f.build();apply(f.batch,f.target,"owner");put(f.input,"sessions/"+f.sessionId+".jsonl","SECOND_SYNTHETIC_ARCHIVE");const d=delta(f,b.manifestHash),batch=join(f.directory,"delta");capture(f.input,batch,d);assert.equal(apply(batch,f.target,"owner").applied,true);assert.equal(verify(f.target).records,0);
});
