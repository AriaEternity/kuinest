import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { fixture, doc, inspect } from "./context-fixtures.js";
import { defaults } from "../dist/context/profile.js";
import type { CharacterConfig } from "../dist/context/types.js";
import type { ProviderAdapter } from "../dist/ports.js";
import type { SearchProvider } from "../dist/tools/search.js";
import { CharacterRuntime } from "../dist/context/runtime.js";
import { restrictedTools } from "../dist/tools/registry.js";
import { ApiServices } from "../dist/application/service.js";
import { RunService } from "../dist/conversations/service.js";
import { createApp } from "../dist/app.js";
import { EventStreams } from "../dist/http/routes/events.js";
import { Scheduler } from "../dist/scheduler/tick.js";
export { fixture, inspect, until, mutate, controlled, isCode } from "./context-fixtures.js";
export type Fixture = ReturnType<typeof fixture>;
export function publishTask(f: Fixture, overrides: Partial<CharacterConfig> = {}, text = "合成主动任务：检查是否需要问候；无需发送时仅返回HEARTBEAT_OK。") {
  const versionId = f.ids.next();
  f.storage.characterAccess().publish("owner-a",{ characterId:"character-a",versionId,
    profile:{ id:f.ids.next(),provider:"mock",model:"synthetic",endpoint:null,options:{},status:"synthetic" },
    config:{ ...defaults,...overrides }, documents:[doc("SOUL.md","纯合成角色"),doc("HEARTBEAT.md",text)] },f.clock.now());
  f.storage.characterAccess().activate("owner-a","character-a",versionId); return versionId;
}
export function task(f: Fixture, options: { versionId?: string; dueAt?: number; enabled?: boolean; allowMemoryWrite?: boolean; allowWebSearch?: boolean; conversationId?: string } = {}) {
  const id = f.ids.next(), versionId = options.versionId ?? publishTask(f);
  const input = { conversationId: options.conversationId ?? "conversation-a", intervalSeconds:60,timezone:"Asia/Shanghai",
    definition:{ documentVersionId:versionId,documentName:"HEARTBEAT.md" as const,allowMemoryWrite:options.allowMemoryWrite ?? false,allowWebSearch:options.allowWebSearch ?? false,silenceMarkers:["HEARTBEAT_OK","NO_REPLY"],delivery:"web" as const },
    nextDueAt:options.dueAt ?? f.clock.now() };
  const port = f.storage.schedulerAccess(); port.create("owner-a",id,input,f.clock.now());
  if (options.enabled !== false) port.setEnabled("owner-a",id,1,true);
  return { id,versionId,input };
}
export function enqueue(f: Fixture) {
  assert.equal(f.storage.schedulerAccess().tick(f.clock.now(),f.ids),1);
  return inspect(f.root,db => (db.prepare("SELECT id FROM runs WHERE origin='heartbeat' ORDER BY created_at DESC,id DESC LIMIT 1").get() as { id:string }).id);
}
export function harness(t: TestContext, f: Fixture, provider: ProviderAdapter, search?: SearchProvider, options: { timeoutMs?: number } = {}) {
  let logs = "";
  const api = new ApiServices(f.storage.apiAccess(),f.config,f.clock,f.ids,Buffer.alloc(32,8),{ async hash(){ return "synthetic-only"; },async verify(){ return true; } });
  const store = f.storage.runAccess({context:true,webSearch:!!search});
  const context = new CharacterRuntime({ storage:f.storage.contextAccess(),protocol:f.storage.protocolAccess(),clock:f.clock,ids:f.ids,resolve:()=>provider,
    toolsForRun:(claim,input)=>restrictedTools(claim,input,{control:store.control,memory:f.storage.memoryAccess(),clock:f.clock,ids:f.ids,...(search ? {search}: {})}) });
  const runs = new RunService(store,api.queries,f.clock,f.ids,f.config,provider,{ context,webSearch:!!search,pollMs:10,flushMs:5,timeoutMs:options.timeoutMs ?? 3000,abortDrainMs:100 });
  const scheduler = new Scheduler(f.storage.schedulerAccess(),f.clock,f.ids,()=>runs.worker.wake());
  const events = new EventStreams(f.storage.eventAccess(),wake=>f.storage.subscribeCommits(wake),api.sessions,f.clock);
  const app = createApp(f.config,{storage:f.storage,clock:f.clock,ids:f.ids,provider},{api,runs,events,scheduler,logStream:new Writable({write(chunk,_enc,cb){logs+=chunk.toString();cb();}})});
  f.cleanup(()=>app.close()); runs.start(); scheduler.start();
  return {api,runs,store,app,scheduler,logs:()=>logs, async headers(){
    const response = await app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin:f.config.publicOrigin},payload:{username:"synthetic-context",password:"synthetic"}});
    assert.equal(response.statusCode,200);
    return {cookie:String(response.headers["set-cookie"]).split(";")[0]!,origin:f.config.publicOrigin,"x-csrf-token":response.json().csrfToken as string};
  }};
}
