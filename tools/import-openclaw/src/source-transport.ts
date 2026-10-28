import { spawn, execFileSync } from "node:child_process";
import { readFileSync, openSync, writeSync, closeSync, chmodSync } from "node:fs";
import { dirname, join, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { checkedDirectory, checkedFile } from "../../../apps/backend/dist/storage/paths.js";
import { check, newDirectory, safeFailure, ImportError, uuid, write, limits } from "./safe.js";
import { receiveSource, verifySource } from "./source-receive.js";
export type SourceRequest={mode:"private"|"synthetic";root?:string;sourceId:string;batchId:string};
export type SshOptions={host:string;identity:string};
const base=fileURLToPath(new URL("../../../",import.meta.url));
export function sourceProgram(request:SourceRequest,mode:"probe"|"export"|"metadata"):string{
  return readFileSync(new URL("../source-reader.mjs",import.meta.url),"utf8")+"\nawait sourceMain("+JSON.stringify(request)+","+JSON.stringify(mode)+");\n";
}
export function secureNewOutput(directory:string):void{
  newDirectory(directory);
  if(process.platform!=="win32"){chmodSync(directory,0o700);return;}
  const identity=execFileSync("whoami",["/user","/fo","csv","/nh"],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]});
  const sid=identity.match(/S-1-\d+(?:-\d+)+/)?.[0];check(sid,"PRIVATE_ACL_FAILED");
  execFileSync("icacls",[directory,"/inheritance:r","/grant:r","*"+sid+":(OI)(CI)F","*S-1-5-18:(OI)(CI)F"],{windowsHide:true,stdio:"pipe"});
  const literal="'"+directory.replaceAll("'","''")+"'";
  const script="$a=[IO.Directory]::GetAccessControl("+literal+"); $ids=@($a.Access|ForEach-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}); "+
    "if(!$a.AreAccessRulesProtected -or $ids.Count -ne 2 -or @($ids|Where-Object {$_ -notin @('"+sid+"','S-1-5-18')}).Count -ne 0){exit 1}; 'OK'";
  const verified=execFileSync("powershell",["-NoProfile","-NonInteractive","-Command",script],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]});
  check(verified.trim()==="OK","PRIVATE_ACL_FAILED");
}
export function privatePath(directory:string):string{
  check(isAbsolute(directory),"PRIVATE_OUTPUT_REQUIRED");
  const parent=resolve(base,"runtime/private/imports"),target=resolve(directory);
  check(target.startsWith(parent+sep)&&dirname(target)===parent&&/^source-[0-9a-f-]{36}$/.test(target.slice(parent.length+1)),"PRIVATE_OUTPUT_REQUIRED");
  checkedDirectory(parent,true);return target;
}
function sshArguments(options:SshOptions):string[]{
  check(typeof process.env.KUINEST_IMPORT_SSH_HOST === "string" && /^[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(options.host) && options.host === process.env.KUINEST_IMPORT_SSH_HOST,"SSH_DESTINATION_INVALID");checkedFile(options.identity);
  return ["-T","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ConnectionAttempts=1","-o","StrictHostKeyChecking=yes","-o","LogLevel=ERROR","-o","ServerAliveInterval=10","-o","ServerAliveCountMax=2","-i",options.identity,options.host,"node --input-type=module"];
}
export function sourceFailure(stderr:string):ImportError{
  try{const r=JSON.parse(stderr);if(r&&typeof r.code==="string"&&["SOURCE_REQUEST_INVALID","SOURCE_PATH_UNSAFE","SOURCE_FILE_LIMIT","SOURCE_CHANGED","SOURCE_UTF8_INVALID","SOURCE_JSON_INVALID","WEB_SESSION_MISSING","WEB_SESSION_INVALID","WEB_SESSION_PATH_INVALID","SOURCE_FILE_COUNT_LIMIT","SOURCE_TOTAL_LIMIT","SOURCE_RECORD_LIMIT","SOURCE_RECEIPT_LIMIT","SOURCE_READ_FAILED","SESSION_HEADER_MISMATCH"].includes(r.code))return new ImportError(r.code);}catch{}
  if(/timed out|timeout/i.test(stderr))return new ImportError("SSH_CONNECT_TIMEOUT");
  if(/Permission denied/i.test(stderr))return new ImportError("SSH_AUTH_REJECTED");
  if(/Host key verification failed|host key has changed/i.test(stderr))return new ImportError("SSH_HOST_TRUST_REQUIRED");
  return new ImportError("SSH_SOURCE_FAILED");
}
export function runSource(options:SshOptions,request:SourceRequest,mode:"probe"|"export"|"metadata",wire?:string):Promise<Buffer>{
  return runProgram(options,sourceProgram(request,mode),wire);
}
export function runProgram(options:SshOptions,program:string,wire?:string):Promise<Buffer>{
  const args=sshArguments(options),chunks:Buffer[]=[];let size=0,stderr="",settled=false;
  const fd=wire?openSync(wire,"wx",0o600):undefined;
  return new Promise((resolvePromise,reject)=>{
    let child:ReturnType<typeof spawn>;
    const finish=(error?:Error)=>{
      if(settled)return;settled=true;clearTimeout(timer);if(fd!==undefined)closeSync(fd);
      if(error)reject(error);else resolvePromise(Buffer.concat(chunks));
    };
    const timer=setTimeout(()=>{child?.kill();finish(new ImportError("SSH_SOURCE_TIMEOUT"));},120000);
    try{child=spawn("ssh",args,{windowsHide:true,stdio:["pipe","pipe","pipe"]});}catch{finish(new ImportError("SSH_SOURCE_FAILED"));return;}
    child.stdout!.on("data",(data:Buffer)=>{
      if(settled)return;size+=data.length;
      if(size>(wire?limits.total+2*1024*1024+4:16384)){child.kill();finish(new ImportError("SOURCE_TRANSFER_LIMIT"));return;}
      try{
        if(fd!==undefined){let n=0;while(n<data.length){const count=writeSync(fd,data,n,data.length-n);check(count>0,"SOURCE_TRANSFER_FAILED");n+=count;}}
        else chunks.push(data);
      }catch{child.kill();finish(new ImportError("SOURCE_TRANSFER_FAILED"));}
    });
    child.stderr!.on("data",(b:Buffer)=>{if(stderr.length<16384)stderr+=b.toString("utf8").slice(0,16384-stderr.length);});
    child.on("error",()=>finish(new ImportError("SSH_SOURCE_FAILED")));
    child.stdin!.on("error",()=>{});child.stdin!.end(program);
    child.on("close",code=>finish(code===0?undefined:sourceFailure(stderr.trim())));
  });
}
export async function exportSource(options:SshOptions,directory:string,sourceId:string){
  check(uuid(sourceId),"SOURCE_IDENTITY");
  const target=privatePath(directory),batchId=randomUUID();secureNewOutput(target);
  const request:SourceRequest={mode:"private",sourceId,batchId},wire=join(target,"source-transfer.bin");
  try{
    await runSource(options,request,"export",wire);
    receiveSource(wire,target,request);
    return {...verifySource(target),batchId,sourceId,privateAcl:"verified",applied:false};
  }catch(error){
    const result=safeFailure(error);write(target,"failure.json",Buffer.from(JSON.stringify(result)));
    throw error;
  }
}
