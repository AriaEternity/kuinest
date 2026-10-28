// 只读源端程序：仅Node内置模块；不加载OpenClaw、不写远端文件、不读配置/凭据。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { once } from "node:events";
const CORE=["IDENTITY.md","SOUL.md","USER.md","AGENTS.md","TOOLS.md","HEARTBEAT.md","MEMORY.md"];
const KEY="agent:main:xiaokui-web", FILE_MAX=64*1024*1024, TOTAL_MAX=256*1024*1024;
const digest=b=>crypto.createHash("sha256").update(b).digest("hex");
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const identifier=v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const uuid=v=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
// 与后端memoryName保持一致；纯合成采集/收件回归验证两端同一边界。
const memoryName=v=>typeof v==="string"&&/^[A-Za-z0-9_\p{Script=Han}-]{1,80}\.md$/u.test(v)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\.md$/i.test(v);
class SourceError extends Error { constructor(code){super(code);this.code=code;} }
function need(v,code){if(!v)throw new SourceError(code);}
function decoded(bytes){try{return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new SourceError("SOURCE_UTF8_INVALID");}}
function parsed(bytes){try{return JSON.parse(decoded(bytes));}catch(e){if(e instanceof SourceError)throw e;throw new SourceError("SOURCE_JSON_INVALID");}}
function same(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;}
function checked(p,directory=false){
  need(path.isAbsolute(p)&&!p.includes("\0")&&!/^(\\\\|\/\/)/.test(p),"SOURCE_PATH_UNSAFE");
  const full=path.resolve(p),root=path.parse(full).root;
  let current=root;
  for(const part of path.relative(root,full).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    const info=fs.lstatSync(current,{bigint:true});
    need(!info.isSymbolicLink(),"SOURCE_PATH_UNSAFE");
    if(current!==full)need(info.isDirectory(),"SOURCE_PATH_UNSAFE");
  }
  const s=fs.lstatSync(full,{bigint:true});
  need(directory?s.isDirectory():s.isFile()&&s.nlink===1n,"SOURCE_PATH_UNSAFE");
  const real=fs.realpathSync(full);
  need(process.platform==="win32"?real.toLowerCase()===full.toLowerCase():real===full,"SOURCE_PATH_UNSAFE");
  return full;
}
function read(p,max=FILE_MAX){
  const full=checked(p),fd=fs.openSync(full,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    const before=fs.fstatSync(fd,{bigint:true});
    need(before.isFile()&&before.nlink===1n&&before.size<=BigInt(max),"SOURCE_FILE_LIMIT");
    const data=Buffer.alloc(Number(before.size));let used=0;
    while(used<data.length){const n=fs.readSync(fd,data,used,data.length-used,used);need(n>0,"SOURCE_CHANGED");used+=n;}
    need(fs.readSync(fd,Buffer.alloc(1),0,1,used)===0,"SOURCE_CHANGED");
    need(same(before,fs.fstatSync(fd,{bigint:true}))&&same(before,fs.lstatSync(checked(full),{bigint:true})),"SOURCE_CHANGED");
    return data;
  }finally{fs.closeSync(fd);}
}
function statOptional(p,directory=false){
  try{const full=checked(p,directory);return fs.lstatSync(full);}catch(e){if(e?.code==="ENOENT")return null;throw e;}
}
function version(mode){
  if(mode==="synthetic")return "2026.7.1-2";
  for(const folder of (process.env.PATH??"").split(path.delimiter)){
    try{
      const cli=fs.realpathSync(path.join(folder,"openclaw"));
      if(!cli.replaceAll("\\","/").includes("/node_modules/openclaw/"))continue;
      let dir=path.dirname(cli);
      for(let i=0;i<3;i++,dir=path.dirname(dir)){
        const p=path.join(dir,"package.json");
        if(!fs.existsSync(p))continue;
        const pkg=parsed(read(p,1024*1024));
        if(pkg?.name==="openclaw"&&typeof pkg.version==="string"&&/^[0-9]{4}\.[0-9]+\.[0-9]+(?:-[0-9]+)?$/.test(pkg.version))return pkg.version;
      }
    }catch{}
  }
  return null;
}
function requestRoot(request){
  need(object(request)&&Object.keys(request).every(k=>["mode","root","sourceId","batchId"].includes(k))&&["private","synthetic"].includes(request.mode),"SOURCE_REQUEST_INVALID");
  need(uuid(request.sourceId)&&uuid(request.batchId),"SOURCE_REQUEST_INVALID");
  if(request.mode==="private")need(request.root===undefined,"SOURCE_REQUEST_INVALID");
  else need(typeof request.root==="string","SOURCE_REQUEST_INVALID");
  return checked(request.mode==="private"?path.join(os.homedir(),".openclaw"):request.root,true);
}
function discover(request){
  const root=requestRoot(request),workspace=checked(path.join(root,"workspace"),true),sessions=checked(path.join(root,"agents","main","sessions"),true);
  const indexPath=path.join(sessions,"sessions.json"),indexBytes=read(indexPath),index=parsed(indexBytes);
  need(object(index)&&Object.hasOwn(index,KEY)&&object(index[KEY]),"WEB_SESSION_MISSING");
  const selected=index[KEY];need(identifier(selected.sessionId),"WEB_SESSION_INVALID");
  const rawPath=selected.sessionFile===undefined?path.join(sessions,selected.sessionId+".jsonl"):selected.sessionFile;
  need(typeof rawPath==="string"&&path.isAbsolute(rawPath),"WEB_SESSION_PATH_INVALID");
  const transcript=path.resolve(rawPath);
  need(path.dirname(transcript)===sessions&&/^[A-Za-z0-9_-]{1,160}\.jsonl$/.test(path.basename(transcript)),"WEB_SESSION_PATH_INVALID");
  checked(transcript);
  const entries=[],missingDocuments=[];
  for(const name of CORE){
    const source=path.join(workspace,name),s=statOptional(source);
    if(s)entries.push({path:"workspace/"+name,kind:"document",source,bytes:s.size});else missingDocuments.push(name);
  }
  let unsupportedMemoryEntries=0;
  const memory=path.join(workspace,"memory");
  if(statOptional(memory,true)){
    for(const e of fs.readdirSync(memory,{withFileTypes:true})){
      if(!memoryName(e.name)){unsupportedMemoryEntries++;continue;}
      const source=checked(path.join(memory,e.name)),s=fs.lstatSync(source);
      entries.push({path:"workspace/memory/"+e.name,kind:"memory",source,bytes:s.size});
    }
  }
  entries.push({path:"sessions/"+selected.sessionId+".jsonl",kind:"session",source:transcript,bytes:fs.lstatSync(transcript).size});
  entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  need(entries.length<2048,"SOURCE_FILE_COUNT_LIMIT");
  const archiveCount=fs.readdirSync(sessions,{withFileTypes:true}).filter(e=>e.isFile()&&/\.jsonl(?:\.(?:reset|deleted|bak)\..+)?$/.test(e.name)).length;
  return {root,indexPath,indexBytes,sessionId:selected.sessionId,entries,missingDocuments,unsupportedMemoryEntries,archiveCount,version:version(request.mode)};
}
function outline(bytes,sessionId){
  need(bytes.length<=FILE_MAX,"SOURCE_FILE_LIMIT");
  const lines=decoded(bytes).split("\n");if(lines.at(-1)==="")lines.pop();
  need(lines.length>0&&lines.length<=100001&&lines.every(l=>Buffer.byteLength(l)<=16*1024*1024),"SOURCE_RECORD_LIMIT");
  const values=lines.map(l=>parsed(Buffer.from(l))),header=values.shift();
  need(object(header)&&header.type==="session"&&header.id===sessionId,"SESSION_HEADER_MISMATCH");
  const recognized=["message","compaction","branch_summary","custom_message","custom","model_change","thinking_level_change","session_info","label"];
  const counts=Object.fromEntries([...recognized,"other"].map(k=>[k,0])),map=new Map(),parents=new Set();
  let invalid=0,sideControls=0;
  for(const e of values){
    if(!object(e)){invalid++;continue;}
    counts[recognized.includes(e.type)?e.type:"other"]++;
    if(e.appendMode!==undefined||e.type==="leaf")sideControls++;
    if(!identifier(e.id)||(e.parentId!==null&&!identifier(e.parentId))||map.has(e.id)){invalid++;continue;}
    map.set(e.id,e);if(e.parentId)parents.add(e.parentId);
  }
  let missingParents=0,cycles=0;const done=new Set();
  for(const e of map.values()){
    let at=e.id;const visiting=new Set();
    while(at&&!done.has(at)){
      if(visiting.has(at)){cycles++;break;}visiting.add(at);
      const next=map.get(at);if(!next){missingParents++;break;}at=next.parentId;
    }
    for(const id of visiting)done.add(id);
  }
  const leaves=[...map.keys()].filter(id=>!parents.has(id));
  return {format:Number.isSafeInteger(header.version)?header.version:null,records:values.length,counts,invalid,missingParents,cycles,leaves:leaves.length,sideControls,
    // 仅提供结构候选，不把唯一叶或最后一行冒充旧运行时已核实的活动叶。
    leafCandidate:leaves.length===1?leaves[0]:null,selectionVerified:false};
}
function signature(d){return JSON.stringify([d.entries.map(e=>[e.path,e.source,e.bytes]),d.sessionId,d.missingDocuments,d.unsupportedMemoryEntries,d.archiveCount,d.version,digest(d.indexBytes)]);}
export function collectSource(request,afterRead){
  const before=discover(request),files=[];let total=0;
  for(const e of before.entries){
    const content=read(e.source);total+=content.length;need(total<=TOTAL_MAX,"SOURCE_TOTAL_LIMIT");
    files.push({path:e.path,kind:e.kind,sha256:digest(content),bytes:content.length,content,representation:"original-bytes"});
  }
  if(afterRead)afterRead();
  const after=discover(request);need(signature(before)===signature(after),"SOURCE_CHANGED");
  for(let i=0;i<before.entries.length;i++)need(digest(read(before.entries[i].source))===files[i].sha256,"SOURCE_CHANGED");
  // 只投影指定网页键的必要索引字段；不复制其他会话、认证引用或索引缓存内容。
  const projected=Buffer.from(JSON.stringify({[KEY]:{sessionId:before.sessionId}}));
  files.push({path:"sessions/sessions.json",kind:"index",sha256:digest(projected),bytes:projected.length,content:projected,representation:"selected-index-projection"});
  const session=files.find(f=>f.kind==="session"),tree=outline(session.content,before.sessionId);
  const receipt={format:"kuinest-openclaw-source-v1",sourceId:request.sourceId,batchId:request.batchId,mode:request.mode,agentId:"main",sessionKey:KEY,
    scope:"main-workspace-and-current-web-session",sourceVersion:before.version,capturedAt:Date.now(),consistency:"double-read-matched",
    sessionId:before.sessionId,sourceIndexSha256:digest(before.indexBytes),sourceIndexPreserved:false,historyCoverage:"current-session-only",
    missingDocuments:before.missingDocuments,unsupportedMemoryEntries:before.unsupportedMemoryEntries,unmappedArchiveCount:Math.max(0,before.archiveCount-1),
    tree,files:files.map(({content,...metadata})=>metadata)};
  return {receipt,files};
}
export function sourceSummary(receipt){
  return {ok:true,sourceVersion:receipt.sourceVersion,files:receipt.files.length,bytes:receipt.files.reduce((n,f)=>n+f.bytes,0),
    documents:receipt.files.filter(f=>f.kind==="document").length,memoryFiles:receipt.files.filter(f=>f.kind==="memory").length,
    sessionFormat:receipt.tree.format,records:receipt.tree.records,recordTypes:receipt.tree.counts,
    invalidRecords:receipt.tree.invalid,missingParents:receipt.tree.missingParents,cycles:receipt.tree.cycles,leafCandidates:receipt.tree.leaves,sideControls:receipt.tree.sideControls,
    missingDocuments:receipt.missingDocuments,unsupportedMemoryEntries:receipt.unsupportedMemoryEntries,unmappedArchiveCount:receipt.unmappedArchiveCount,
    consistency:receipt.consistency,historyCoverage:receipt.historyCoverage,selectionVerified:false,sourceIndexPreserved:false};
}
async function output(bytes){if(!process.stdout.write(bytes))await once(process.stdout,"drain");}
export async function sourceMain(request,mode){
  try{
    need(["probe","export","metadata"].includes(mode),"SOURCE_REQUEST_INVALID");
    if(mode==="metadata"){await output(Buffer.from(JSON.stringify(collectSourceMetadata(request))+"\n"));return;}
    const {receipt,files}=collectSource(request);
    if(mode==="probe")await output(Buffer.from(JSON.stringify(sourceSummary(receipt))+"\n"));
    else{
      const header=Buffer.from(JSON.stringify(receipt)),size=Buffer.alloc(4);need(header.length<=2*1024*1024,"SOURCE_RECEIPT_LIMIT");size.writeUInt32BE(header.length);
      await output(size);await output(header);
      for(const file of files)for(let start=0;start<file.content.length;start+=65536)await output(file.content.subarray(start,start+65536));
    }
  }catch(e){
    process.stderr.write(JSON.stringify({ok:false,code:e instanceof SourceError?e.code:"SOURCE_READ_FAILED"})+"\n");process.exitCode=1;
  }
}

const META_TEXT=["modelProvider","model","providerOverride","modelOverride","modelOverrideSource","thinkingLevel","reasoningLevel","agentHarnessId"];
const META_NUMBER=["updatedAt","contextTokens","compactionCount"];
const REPORT_TEXT=["source","provider","model"];
const REPORT_NUMBER=["generatedAt","bootstrapMaxChars","bootstrapTotalMaxChars"];
function metadataValues(selected){
  const values={},problems=[];
  const strings=(from,to,keys,prefix="")=>{for(const key of keys)if(Object.hasOwn(from,key)){
    const v=from[key];if(typeof v==="string"&&/^[A-Za-z0-9._:/-]{1,256}$/.test(v))to[key]=v;else problems.push(prefix+key);
  }};
  const numbers=(from,to,keys,prefix="")=>{for(const key of keys)if(Object.hasOwn(from,key)){
    const v=from[key];if(Number.isSafeInteger(v)&&v>=0)to[key]=v;else problems.push(prefix+key);
  }};
  strings(selected,values,META_TEXT);numbers(selected,values,META_NUMBER);
  if(Object.hasOwn(selected,"liveModelSwitchPending")){if(typeof selected.liveModelSwitchPending==="boolean")values.liveModelSwitchPending=selected.liveModelSwitchPending;else problems.push("liveModelSwitchPending");}
  if(Object.hasOwn(selected,"systemPromptReport")){
    if(!object(selected.systemPromptReport))problems.push("systemPromptReport");
    else{
      const report={},r=selected.systemPromptReport;strings(r,report,REPORT_TEXT,"report.");numbers(r,report,REPORT_NUMBER,"report.");
      for(const [key,nested] of [["systemPromptChars",r.systemPrompt?.chars],["toolCount",Array.isArray(r.tools?.entries)?r.tools.entries.length:undefined],["skillCount",Array.isArray(r.skills?.entries)?r.skills.entries.length:undefined]]){
        if(nested!==undefined){if(Number.isSafeInteger(nested)&&nested>=0)report[key]=nested;else problems.push("report."+key);}
      }
      if(Array.isArray(r.injectedWorkspaceFiles)){
        report.workspaceFileCount=r.injectedWorkspaceFiles.length;
        report.truncatedFileCount=r.injectedWorkspaceFiles.filter(f=>object(f)&&f.truncated===true).length;
        report.missingFileCount=r.injectedWorkspaceFiles.filter(f=>object(f)&&f.missing===true).length;
      }
      values.report=report;
    }
  }
  return {values,problems};
}
export function collectSourceMetadata(request,afterRead){
  const root=requestRoot(request),indexPath=path.join(checked(path.join(root,"agents","main","sessions"),true),"sessions.json");
  const before=read(indexPath,16*1024*1024),index=parsed(before);
  need(object(index)&&object(index[KEY])&&identifier(index[KEY].sessionId),"WEB_SESSION_INVALID");
  const session=index[KEY],projection=metadataValues(session);
  if(afterRead)afterRead();
  need(digest(read(indexPath,16*1024*1024))===digest(before),"SOURCE_CHANGED");
  return {format:"kuinest-session-metadata-v1",sourceId:request.sourceId,batchId:request.batchId,sessionId:session.sessionId,
    sourceVersion:version(request.mode),capturedAt:Date.now(),sourceIndexSha256:digest(before),provenance:"selected-session-index",
    ...projection,runtimeConfigurationVerified:false};
}
