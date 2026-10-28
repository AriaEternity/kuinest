import { pathToFileURL } from "node:url";
import { prepareTextTrial, startTextTrial, textTrialPreflight } from "./text-trial.js";
import { check, json, read, safeFailure } from "./safe.js";
import { readTerminal } from "../../../apps/backend/dist/auth/terminal.js";
const terminalText=(text:string)=>text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,"");
export async function textTrialMain(args:string[]){
 const [command,...rest]=args,values=new Map<string,string>();for(const arg of rest){const at=arg.indexOf("=");check(arg.startsWith("--")&&at>2&&!values.has(arg.slice(2,at)),"TRIAL_ARGUMENT_INVALID");values.set(arg.slice(2,at),arg.slice(at+1));}
 const withExpression=values.has("expression-dir")||values.has("expression-sha256")||values.has("expression-mode");
 const keys=command==="prepare"?["input","output","seal-sha256","settings-dir",...(withExpression?["expression-dir","expression-sha256",...(values.has("expression-mode")?["expression-mode"]:[])]:[])]:command==="chat"?["directory","plan-sha256","allow-live"]:[];
 check(keys.length&&keys.length===values.size&&keys.every(k=>values.get(k)),"TRIAL_ARGUMENT_INVALID");const v=(k:string)=>values.get(k)!;
 if(command==="prepare")return prepareTextTrial(v("input"),v("output"),v("seal-sha256"),json(read(v("settings-dir"),"TRIAL-SETTINGS.json",16384)),withExpression?{bytes:read(v("expression-dir"),"EXPRESSION.md",65536),sha256:v("expression-sha256"),...(values.has("expression-mode")?{mode:v("expression-mode") as "reference"|"project-instructions"}:{})}:undefined);
 check(v("allow-live")==="true"&&process.stdin.isTTY&&process.stdout.isTTY,"TRIAL_INTERACTIVE_AUTHORIZATION_REQUIRED");
 const plan=textTrialPreflight(v("directory"),v("plan-sha256"));check(plan.mode==="private","TRIAL_PRIVATE_ONLY");
 process.stdout.write("即将在独立副本私下试聊。最多"+plan.settings.maxCalls+"次模型请求；新记忆需手动确认。正文仅在此终端显示，完整记录保存在私有试用库。\n");
 if(plan.expression)process.stdout.write(plan.config.expressionMode==="project-instructions"?"本包按原项目提示语组织对话；原人设和记忆作为配套资料保留。\n":"本包已加载独立表达参考；原人设和记忆保留。\n");
 check(await readTerminal("已核对试用参数及授权范围后，请输入 START：",false,16)==="START","TRIAL_AUTHORIZATION_REQUIRED");
 let token=await readTerminal("模型密钥（不回显，不写入文件）：",true,4096);check(!!token&&/^[\x21-\x7e]+$/.test(token),"TRIAL_CREDENTIAL_INVALID");
 let session:ReturnType<typeof startTextTrial>|undefined;
 try{
  session=startTextTrial(v("directory"),v("plan-sha256"),{allowLive:true,credential:()=>token});
  process.stdout.write("命令：/new 新窗口；/memories 列表；/more 下一页；/remember 正文；/edit ID 版本 哈希 新正文；/confirm ID 版本 哈希；/reject ID 版本 哈希；/quit 退出。\n");let cursor:string|undefined;
  for(;;){const line=await readTerminal("您：",false,32000);if(line==="/quit")break;if(!line.trim())continue;
   try{
    if(line==="/new"){session.newConversation();process.stdout.write("已创建空白聊天窗口，人设和已确认记忆仍保留。\n");continue;}
    if(line==="/memories"||line==="/more"){if(line==="/memories")cursor=undefined;else if(!cursor){process.stdout.write("没有下一页。\n");continue;}const page=session.review.list(session.owner,session.character,cursor,10);cursor=page.nextCursor??undefined;for(const r of page.items)process.stdout.write(terminalText(JSON.stringify(r,null,2))+"\n");if(cursor)process.stdout.write("/more 可查看下一页。\n");continue;}
    if(line.startsWith("/remember ")){const r=session.review.proposeUser(session.owner,session.character,{clientRequestId:session.ids.next(),content:line.slice(10)});process.stdout.write("已提出待确认候选："+r.id+"\n");continue;}
    const match=/^\/(confirm|reject|edit) (\S+) (\d+) ([0-9a-f]{64})(?: ([\s\S]+))?$/.exec(line);
    if(match){const [,action,id,revision,contentSha256,content]=match,input={revision:Number(revision),contentSha256:contentSha256!};const r=action==="edit"?session.review.edit(session.owner,id!,{...input,content:content??""}):session.review.decide(session.owner,id!,input,action==="confirm"?"confirmed":"rejected");process.stdout.write("候选状态："+r.status+"；版本："+r.revision+"\n");continue;}
    check(!line.startsWith("/"),"TRIAL_COMMAND_INVALID");const result=await session.chat(line);if(result.reply)process.stdout.write("回复："+terminalText(result.reply.content)+"\n");if(result.status!=="completed")process.stdout.write("本轮状态："+result.status+"\n");process.stdout.write("已使用请求数："+session.calls+"/"+session.maxCalls+"\n");
   }catch{process.stdout.write("操作未完成；请核对命令、候选版本和剩余调用额度。\n");}
  }
 }finally{token="";await session?.close();}
 return {ok:true,closed:true,productionSwitched:false};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){try{const result=await textTrialMain(process.argv.slice(2));process.stdout.write(JSON.stringify(result)+"\n");}catch(error){process.stderr.write(JSON.stringify(safeFailure(error))+"\n");process.exitCode=1;}}
