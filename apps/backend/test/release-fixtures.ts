import { randomUUID } from "node:crypto";
import { mkdirSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { SqliteStorage } from "../dist/storage/storage.js";
import { secureNewOutput } from "../../../tools/import-openclaw/dist/source-transport.js";
import { config,documentNames,hash } from "../dist/context/profile.js";
import { passwords } from "../dist/auth/password.js";
import { projectRoot } from "../dist/server.js";
export const password="synthetic-release-password-2026";
let encoded:Promise<string>|undefined;
export async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const port=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return port;}
export async function releaseFixture(active=true){
 const parent=join(projectRoot,".cache/stage10-tests");mkdirSync(parent,{recursive:true});const root=join(parent,"release-"+randomUUID());secureNewOutput(root);
 const owner="owner-release",character="character-release",version="version-release",username="synthetic-release";
 const store=new SqliteStorage({dataRoot:root,instanceId:randomUUID(),clock:{now:Date.now}});
 try{
  store.apiAccess().initializeOwner({id:owner,username,passwordHash:active?await(encoded??=passwords.hash(password)):"!",characterId:character,versionId:"seed-release",profileId:"seed-profile",createdAt:Date.now()});
  const p={id:"profile-release",provider:"deepseek" as const,model:"synthetic-release-model",endpoint:"https://synthetic-provider.invalid/v1/chat/completions",options:{allowedOrigin:"https://synthetic-provider.invalid",maxTokens:256,thinking:"disabled",imageInput:false},status:"unverified"};
  store.characterAccess().publish(owner,{characterId:character,versionId:version,profile:p,config:config({memoryReviewEnabled:true,memoryWriteKeys:[],memoryReadKeys:["MEMORY.md"]}),documents:documentNames.map(name=>{const text="纯合成发布资料 "+name;return {name,bytes:Buffer.from(text),sha256:hash(text)};})},Date.now());
  const binding=store.runtimeAccess().inspect(owner,character,version).binding;
  if(active)store.characterAccess().activate(owner,character,version,true);
  const bytes=Buffer.from(JSON.stringify(binding,null,2));writeFileSync(join(root,"runtime-binding.json"),bytes,{mode:0o600});
  writeFileSync(join(root,"provider.key"),"synthetic-token-never-network\n",{mode:0o600});writeFileSync(join(root,"cursor.key"),Buffer.alloc(32,47).toString("base64")+"\n",{mode:0o600});
  return {root,owner,character,version,username,binding,env:{NODE_ENV:"production",APP_MODE:"private",DATA_ROOT:root,PUBLIC_ORIGIN:"https://synthetic-chat.invalid",CURSOR_HMAC_KEY_FILE:join(root,"cursor.key"),PROVIDER_API_KEY_FILE:join(root,"provider.key"),RUNTIME_BINDING_SHA256:hash(bytes),ALLOWED_PROVIDER_ORIGIN:"https://synthetic-provider.invalid",ALLOW_LIVE_MODEL:"true",PORT:String(await freePort()),TRUST_PROXY:"loopback",ENABLE_BACKUPS:"false"}};
 }finally{await store.close();}
}
export function reply(text="合成后端答复"){return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}]})+'\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}});}
