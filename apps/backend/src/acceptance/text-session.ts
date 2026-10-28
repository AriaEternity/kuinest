import { randomBytes, randomUUID } from "node:crypto";
import type { ProviderAdapter, Clock } from "../ports.js";
import type { Profile } from "../context/types.js";
import { SqliteStorage } from "../storage/storage.js";
import { CharacterRuntime } from "../context/runtime.js";
import { Worker } from "../conversations/worker.js";
import { RunFailure } from "../conversations/types.js";
import { submission } from "../conversations/submit.js";
import { Queries } from "../application/queries.js";
import { Signing } from "../auth/secrets.js";
import { restrictedTools } from "../tools/registry.js";
import { ensure } from "../application/errors.js";
// 本地受控试用复用正式编排及数据库；不监听端口，不启动定时任务。
export class TextSession {
 readonly ids={next:randomUUID}; readonly review; readonly queries:Queries; readonly worker:Worker;
 #conversation:string; #calls=0; #busy=false; #closed=false;
 constructor(readonly storage:SqliteStorage,readonly owner:string,readonly character:string,readonly clock:Clock,resolve:(profile:Profile)=>ProviderAdapter,readonly maxCalls:number){
  ensure(Number.isInteger(maxCalls)&&maxCalls>=1&&maxCalls<=12,"INPUT_INVALID");
  this.review=storage.memoryReviewAccess();this.queries=new Queries(storage.apiAccess(),clock,this.ids,new Signing(randomBytes(32)));this.#conversation=this.queries.createConversation(owner,"私下文字试用").id;
  const store=storage.runAccess({context:true}),self=this;
  const context=new CharacterRuntime({storage:storage.contextAccess(),protocol:storage.protocolAccess(),clock,ids:this.ids,
   toolsForRun:(claim,input)=>restrictedTools(claim,input,{control:store.control,memory:storage.memoryAccess(),review:this.review,clock,ids:this.ids}),
   resolve(profile){const provider=resolve(profile);return {...(provider.description?{description:provider.description}:{}),async *stream(request,signal){if(self.#calls>=self.maxCalls)throw new RunFailure("TOOL_LIMIT");self.#calls++;yield* provider.stream(request,signal);}};}
  });
  this.worker=new Worker(store,{async *stream(){throw new RunFailure("PROFILE_INVALID");}},clock,this.ids,{context,pollMs:100,flushMs:25,onFault:()=>{void this.close();}});
  storage.startRenewal(()=>{void this.close();});this.worker.start();
 }
 get calls(){return this.#calls;} get conversation(){return this.#conversation;}
 newConversation(){ensure(!this.#busy&&!this.#closed,"SERVICE_NOT_READY");this.#conversation=this.queries.createConversation(this.owner,"新的私下文字窗口").id;return this.#conversation;}
 async chat(text:string){
  ensure(!this.#busy&&!this.#closed&&this.worker.ready,"SERVICE_NOT_READY");ensure(this.#calls<this.maxCalls,"RATE_LIMITED");this.#busy=true;
  try{
   const accepted=this.worker.store.submit(this.owner,this.#conversation,submission({clientMessageId:this.ids.next(),text,allowWebSearch:false}),this.clock.now(),this.ids,{perConversationQueue:1,globalQueue:1});this.worker.wake();
   for(;;){const result=this.queries.run(this.owner,accepted.runId);if(!["accepted","running"].includes(result.status))return result;ensure(!this.#closed&&this.worker.ready,"SERVICE_NOT_READY");await new Promise<void>(r=>setTimeout(r,25));}
  }finally{this.#busy=false;}
 }
 async close(){if(this.#closed)return;this.#closed=true;await this.worker.close();await this.storage.close();}
}
