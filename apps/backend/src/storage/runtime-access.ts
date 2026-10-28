import type Database from "better-sqlite3";
import { config,profile,documents,documentNames } from "../context/profile.js";
import type { Document,Profile } from "../context/types.js";
import { digest,type RuntimeBinding } from "../runtime/binding.js";
import { requireCondition } from "./errors.js";
import { validPasswordHash } from "../auth/password.js";

export function runtimeAccess(db:Database.Database,write:<T>(fn:()=>T)=>T,guard:()=>void){
 const inspect=(owner:string,character:string,version:string,active=false)=>{
  guard();
  return db.transaction(()=>{
   const row=db.prepare("SELECT v.config_json AS config,p.id,p.provider,p.model,p.endpoint,p.options_json AS options,p.compatibility_status AS status,c.active_version_id AS active,o.password_hash AS password FROM character_versions v JOIN characters c ON c.id=v.character_id JOIN provider_profiles p ON p.id=v.provider_profile_id AND p.owner_id=c.owner_id JOIN owners o ON o.id=c.owner_id WHERE c.owner_id=? AND c.id=? AND v.id=?").get(owner,character,version) as {config:string;id:string;provider:Profile["provider"];model:string;endpoint:string|null;options:string;status:string;active:string|null;password:string}|undefined;
   requireCondition(row,"RUNTIME_VERSION_INVALID");
   const p=profile({id:row.id,provider:row.provider,model:row.model,endpoint:row.endpoint,options:JSON.parse(row.options),status:row.status}),c=config(JSON.parse(row.config));
   requireCondition(p.provider==="deepseek"&&p.status==="unverified"&&c.memoryReviewEnabled&&c.memoryWriteKeys.length===0&&c.memoryAppendKeys.length===0&&!c.memoryReplaceEnabled,"RUNTIME_POLICY_INVALID");
   const docs=db.prepare("SELECT logical_name AS name,content AS bytes,sha256 FROM character_documents WHERE version_id=? ORDER BY logical_name").all(version) as Document[];
   requireCondition(documentNames.every(name=>docs.some(d=>d.name===name)&&c.documentOrder.includes(name)),"RUNTIME_DOCUMENTS_INCOMPLETE");
   requireCondition(documents(docs,c).every(d=>!d.truncated),"RUNTIME_DOCUMENTS_TRUNCATED");
   requireCondition((db.prepare("SELECT count(*) AS n FROM owners").get() as {n:number}).n===1 && (db.prepare("SELECT count(*) AS n FROM characters").get() as {n:number}).n===1,"RUNTIME_SCOPE_INVALID");
   if(active)requireCondition(row.active===version&&validPasswordHash(row.password),"RUNTIME_NOT_ACTIVATED");
   const binding:RuntimeBinding={format:"kuinest-runtime-v1",owner,character,version,profileSha256:digest(p),configSha256:digest(c),documentsSha256:digest(docs.map(({name,sha256})=>({name,sha256})))};
   return {binding,profile:p,config:c,accountReady:validPasswordHash(row.password)};
  })();
 };
 return Object.freeze({inspect,verify(expected:RuntimeBinding,active=true){const found=inspect(expected.owner,expected.character,expected.version,active);requireCondition(digest(found.binding)===digest(expected),"RUNTIME_BINDING_CHANGED");return found;},
  setOwnerLogin(owner:string,username:string,passwordHash:string,now:number){write(()=>{requireCondition(username.length>0&&Buffer.byteLength(username)<=512&&validPasswordHash(passwordHash),"OWNER_INPUT_INVALID");const r=db.prepare("UPDATE owners SET username=?,password_hash=? WHERE id=?").run(username,passwordHash,owner);requireCondition(r.changes===1,"OWNER_NOT_FOUND");db.prepare("UPDATE auth_sessions SET revoked_at=? WHERE revoked_at IS NULL").run(now);});}
 });
}
