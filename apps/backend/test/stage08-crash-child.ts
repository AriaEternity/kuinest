import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { projectRoot } from "../dist/server.js";
import { SqliteStorage } from "../dist/storage/storage.js";
import { restrictedTools } from "../dist/tools/registry.js";
import { compile } from "../dist/context/compiler.js";
const [root,mode]=process.argv.slice(2),base=resolve(projectRoot,".cache/stage07-tests");
if(!root||!["draft","append"].includes(mode??""))throw new Error("合成参数无效");
const part=relative(base,resolve(root));if(!part||isAbsolute(part)||part===".."||part.startsWith(".."+sep))throw new Error("合成路径越界");
const clock={now:()=>Date.now()},ids={next:()=>randomUUID()},storage=new SqliteStorage({dataRoot:root,instanceId:ids.next(),clock});
const store=storage.runAccess({context:true}),claim=store.claim(clock.now(),ids)!,input=storage.contextAccess().load(claim);
const tools=restrictedTools(claim,input,{control:store.control,memory:storage.memoryAccess(),clock,ids}),compiled=compile(input,tools.definitions);
storage.contextAccess().save(claim,compiled.manifest,clock.now());
const protocol=storage.protocolAccess(),call=protocol.begin(claim,ids.next(),compiled.request,clock.now());
if(mode==="draft")protocol.checkpoint(claim,call,{assistant:{role:"assistant",content:"synthetic-crash-private-draft"}},"started",clock.now());
else{
  const tool={id:"crash-append",type:"function" as const,function:{name:"memory_append",arguments:JSON.stringify({key:"memory/diary.md",expectedVersion:null,content:"synthetic-crash-committed-diary"})}};
  protocol.checkpoint(claim,call,{assistant:{role:"assistant",content:"",reasoning_content:"合成",tool_calls:[tool]},finish_reason:"tool_calls"},"completed",clock.now());
  const started=protocol.beginTool(claim,call,ids.next(),tool,clock.now());
  const result=await tools.invoke(tool,new AbortController().signal,{toolCallId:started.id});
  if(result.failed)throw new Error("合成写入失败");
  // 故意不提交finishTool：父进程强杀时处于副作用已提交、结果未确认的真实崩溃窗口。
}
process.send?.({state:"persisted"});setInterval(()=>{},1000);
