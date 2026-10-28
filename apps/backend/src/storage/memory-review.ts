import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { MemoryProposal, MemoryProposalPage, ReviewMemoryRequest } from "@kuinest/contracts";
import type { Claim } from "../conversations/types.js";
import type { Clock } from "../ports.js";
import { ensure } from "../application/errors.js";
import { config, hash, validText } from "../context/profile.js";
import { activeVersion, liveContext, snapshot } from "./context-records.js";
type Row={id:string;owner_id:string;character_id:string;source_kind:"user"|"tool";source_id:string;initial_sha256:string;revision:number;status:MemoryProposal["status"];created_at:number;updated_at:number;decided_at:number|null;confirmed_memory_id:string|null;content:string;content_sha256:string};
const select="SELECT p.*,r.content,r.content_sha256 FROM memory_proposals p JOIN memory_proposal_revisions r ON r.proposal_id=p.id AND r.revision=p.revision";
const dto=(r:Row):MemoryProposal=>({id:r.id,characterId:r.character_id,revision:r.revision,content:r.content,contentSha256:r.content_sha256,status:r.status,source:r.source_kind,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString(),decidedAt:r.decided_at===null?null:new Date(r.decided_at).toISOString(),memoryKey:r.confirmed_memory_id===null?null:"memory/confirmed-"+r.id+".md"});
function body(content:string){ensure(validText(content)&&content.trim()&&content.length<=16000&&Buffer.byteLength(content)<=32768,"INPUT_INVALID");}
export function memoryReviewAccess(db:Database.Database,write:<T>(fn:()=>T)=>T,guard:()=>void,clock:Clock){
 const view=<T>(fn:()=>T):T=>{guard();return db.transaction(()=>{guard();return fn();})();};
 const enabled=(owner:string,character:string)=>{const v=activeVersion(db,owner,character);ensure(config(JSON.parse(v.config),v.status==="synthetic").memoryReviewEnabled,"SERVICE_NOT_READY");};
 const owned=(owner:string,id:string)=>{const r=db.prepare(select+" WHERE p.id=? AND p.owner_id=?").get(id,owner) as Row|undefined;ensure(r,"NOT_FOUND");return r;};
 const match=(r:Row,input:ReviewMemoryRequest)=>ensure(r.revision===input.revision&&r.content_sha256===input.contentSha256,"MEMORY_REVIEW_CONFLICT");
 function propose(owner:string,character:string,content:string,source:"user"|"tool",sourceId:string,runId:string|null,toolId:string|null){
  enabled(owner,character);body(content);
  const digest=hash(content),previous=db.prepare(select+" WHERE p.owner_id=? AND p.character_id=? AND p.source_id=?").get(owner,character,sourceId) as Row|undefined;
  if(previous){ensure(previous.initial_sha256===digest&&previous.source_kind===source,"IDEMPOTENCY_CONFLICT");return dto(previous);}
  const count=db.prepare("SELECT count(*) AS total,sum(status='pending') AS pending FROM memory_proposals WHERE owner_id=? AND character_id=?").get(owner,character) as {total:number;pending:number|null};
  ensure(count.total<2000&&(count.pending??0)<100,"MEMORY_REVIEW_LIMIT");
  const id=randomUUID(),now=clock.now();
  db.prepare("INSERT INTO memory_proposals(id,owner_id,character_id,source_kind,source_id,source_run_id,source_tool_call_id,initial_sha256,revision,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,'pending',?,?)").run(id,owner,character,source,sourceId,runId,toolId,digest,now,now);
  db.prepare("INSERT INTO memory_proposal_revisions VALUES(?,1,?,?,?,?)").run(id,content,digest,owner,now);
  return dto(owned(owner,id));
 }
 return Object.freeze({
  characterForConversation(owner:string,id:string){return view(()=>{const row=db.prepare("SELECT character_id FROM conversations WHERE owner_id=? AND id=?").get(owner,id) as {character_id:string}|undefined;ensure(row,"NOT_FOUND");return row.character_id;});},
  proposeUser(owner:string,character:string,request:{clientRequestId:string;content:string}){return write(()=>{ensure(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.clientRequestId),"INPUT_INVALID");return propose(owner,character,request.content,"user","user:"+request.clientRequestId.toLowerCase(),null,null);});},
  proposeTool(claim:Claim,character:string,content:string,toolId:string){return write(()=>{
   const run=liveContext(db,claim),p=snapshot(db,claim);ensure(run.origin==="user"&&p.manifest.characterId===character&&p.manifest.allowMemoryWrite===true,"SERVICE_NOT_READY");
   const v=db.prepare("SELECT config_json FROM character_versions WHERE id=?").get(p.versionId) as {config_json:string};ensure(config(JSON.parse(v.config_json)).memoryReviewEnabled,"SERVICE_NOT_READY");
   const call=db.prepare("SELECT name,arguments_json FROM tool_calls WHERE id=? AND run_id=? AND status='running'").get(toolId,claim.id) as {name:string;arguments_json:string}|undefined;
   ensure(call?.name==="memory_propose","INPUT_INVALID");const args=JSON.parse(call.arguments_json);ensure(Object.keys(args).length===1&&args.content===content,"INPUT_INVALID");
   return propose(claim.ownerId,character,content,"tool","tool:"+toolId,claim.id,toolId);
  });},
  get(owner:string,id:string){return view(()=>dto(owned(owner,id)));},
  list(owner:string,character:string,cursor?:string,limit=20):MemoryProposalPage{return view(()=>{
   enabled(owner,character);ensure(Number.isInteger(limit)&&limit>=1&&limit<=50,"INPUT_INVALID");
   const after=cursor?owned(owner,cursor):undefined;if(after)ensure(after.character_id===character,"CURSOR_INVALID");
   const rows=db.prepare(select+" WHERE p.owner_id=? AND p.character_id=?"+(after?" AND (p.created_at>? OR (p.created_at=? AND p.id>?))":"")+" ORDER BY p.created_at,p.id LIMIT ?").all(owner,character,...(after?[after.created_at,after.created_at,after.id]:[]),limit+1) as Row[];
   return {items:rows.slice(0,limit).map(dto),nextCursor:rows.length>limit?rows[limit-1]!.id:null};
  });},
  edit(owner:string,id:string,input:ReviewMemoryRequest&{content:string}){return write(()=>{
   const r=owned(owner,id);enabled(owner,r.character_id);match(r,input);ensure(r.status==="pending","MEMORY_REVIEW_CONFLICT");body(input.content);
   if(input.content===r.content)return dto(r);ensure(r.revision<20,"MEMORY_REVIEW_LIMIT");const now=clock.now();
   db.prepare("INSERT INTO memory_proposal_revisions VALUES(?,?,?,?,?,?)").run(id,r.revision+1,input.content,hash(input.content),owner,now);
   db.prepare("UPDATE memory_proposals SET revision=revision+1,updated_at=? WHERE id=?").run(now,id);return dto(owned(owner,id));
  });},
  decide(owner:string,id:string,input:ReviewMemoryRequest,decision:"confirmed"|"rejected"){return write(()=>{
   ensure(decision==="confirmed"||decision==="rejected","INPUT_INVALID");const r=owned(owner,id);enabled(owner,r.character_id);match(r,input);
   if(r.status===decision)return dto(r);ensure(r.status==="pending","MEMORY_REVIEW_CONFLICT");const now=clock.now();let memoryId:string|null=null;
   if(decision==="confirmed"){
    const count=db.prepare("SELECT count(*) AS n,COALESCE(sum(length(CAST(v.content AS BLOB))),0) AS bytes FROM memory_heads h JOIN memory_versions v ON v.id=h.version_id WHERE h.character_id=?").get(r.character_id) as {n:number;bytes:number};
    ensure(count.n<200&&count.bytes+Buffer.byteLength(r.content)<=1048576,"MEMORY_REVIEW_LIMIT");
    const key="memory/confirmed-"+r.id+".md";ensure(!db.prepare("SELECT 1 FROM memory_versions WHERE character_id=? AND logical_key=?").get(r.character_id,key),"MEMORY_REVIEW_CONFLICT");memoryId=randomUUID();
    const provenance={source:"user-confirmed-memory",proposalId:r.id,revision:r.revision,sha256:r.content_sha256,confirmedBy:owner,confirmedAt:now};
    db.prepare("INSERT INTO memory_versions(id,character_id,logical_key,version,parent_id,content,provenance_json,created_at) VALUES(?,?,?,1,NULL,?,?,?)").run(memoryId,r.character_id,key,r.content,JSON.stringify(provenance),now);
    db.prepare("INSERT INTO memory_heads VALUES(?,?,?)").run(r.character_id,key,memoryId);
   }
   db.prepare("UPDATE memory_proposals SET status=?,decided_at=?,updated_at=?,confirmed_memory_id=? WHERE id=?").run(decision,now,now,memoryId,id);return dto(owned(owner,id));
  });},
 });
}
export type MemoryReviewAccess=ReturnType<typeof memoryReviewAccess>;
