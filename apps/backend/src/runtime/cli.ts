import { randomUUID } from "node:crypto";
import { fileURLToPath,pathToFileURL } from "node:url";
import { join } from "node:path";
import { loadConfig,readConfigEnvironment } from "../config.js";
import { SqliteStorage } from "../storage/storage.js";
import { requireCondition } from "../storage/errors.js";
import { readTerminal } from "../auth/terminal.js";
import { passwords } from "../auth/password.js";
import { readBinding } from "./binding.js";
import { privatePath, privateDatabase } from "./files.js";

export async function runtimeCommand(args:string[],env:Readonly<Record<string,string|undefined>>=process.env,input=readTerminal){
 const [command,...rest]=args;requireCondition(rest.length===0&&["owner-setup","activate","check-runtime"].includes(command??""),"ARGUMENT_INVALID");
 const root=fileURLToPath(new URL("../../../../",import.meta.url)),c=loadConfig(readConfigEnvironment(env),root);
 requireCondition(c.mode==="private","PRIVATE_MODE_REQUIRED");privateDatabase(c.dataRoot);
 const binding=readBinding(c.dataRoot,c.runtimeBindingSha256),storage=new SqliteStorage({dataRoot:c.dataRoot,instanceId:randomUUID(),clock:{now:Date.now}});
 storage.startRenewal(()=>{});
 try{
  const current=storage.runtimeAccess().verify(binding,command==="check-runtime");
  if(command==="owner-setup"){
   const username=await input("设置个人登录账号：",false,128),password=await input("新口令（至少12字符，不回显）：",true,256),again=await input("再次输入口令：",true,256);
   requireCondition(password===again,"OWNER_INPUT_INVALID");storage.runtimeAccess().setOwnerLogin(binding.owner,username,await passwords.hash(password),Date.now());
  }else if(command==="activate"){
   requireCondition(current.accountReady,"OWNER_SETUP_REQUIRED");
   requireCondition(await input("核对固定角色版本后，输入 ACTIVATE 启用本地运行副本（不发模型请求）：",false,16)==="ACTIVATE","ACTIVATION_REQUIRED");
   storage.characterAccess().activate(binding.owner,binding.character,binding.version,true);storage.runtimeAccess().verify(binding);
  }
  return {ok:true,operation:command,modelCalls:0};
 }finally{await storage.close();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){try{console.log(JSON.stringify(await runtimeCommand(process.argv.slice(2))));}catch{process.stderr.write('{"error":{"code":"RUNTIME_MAINTENANCE_FAILED"}}\n');process.exitCode=1;}}
