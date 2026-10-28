import { pathToFileURL } from "node:url";
import { protocolReadiness, reviewReadiness } from "../../../tools/import-openclaw/dist/source-readiness.js";
import { receiveMetadata, metadata, metadataSummary, verifyMetadata, compareMetadata } from "../../../tools/import-openclaw/dist/source-metadata.js";
import { persistedSelection } from "../../../tools/import-openclaw/dist/source-selection.js";
import { parse } from "../../../tools/import-openclaw/dist/parse.js";
import {diffSource} from "../../../tools/import-openclaw/dist/source-diff.js";
import {auditSource} from "../../../tools/import-openclaw/dist/source-audit.js";
import {hash} from "../../../tools/import-openclaw/dist/safe.js";
import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,symlinkSync,linkSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {sourceProgram,secureNewOutput,sourceFailure} from "../../../tools/import-openclaw/dist/source-transport.js";
import {receiveSource,verifySource,receipt,safeProbe} from "../../../tools/import-openclaw/dist/source-receive.js";
import type {SourceRequest} from "../../../tools/import-openclaw/dist/source-transport.js";
import {fixture,put,messages,sessionBytes,key,entry} from "./import-fixtures.js";
import {projectRoot} from "../dist/server.js";
function sourceFixture(){
  const f=fixture(),root=join(f.directory,"source"),sessions=join(root,"agents/main/sessions");
  mkdirSync(sessions,{recursive:true});
  for(const file of f.definition.files.filter(f=>f.kind==="document"||f.kind==="memory"))put(root,file.path,readFileSync(join(f.input,file.path)));
  put(sessions,f.sessionId+".jsonl",sessionBytes(f.sessionId));
  put(sessions,"sessions.json",JSON.stringify({[key]:{sessionId:f.sessionId,sessionFile:join(sessions,f.sessionId+".jsonl"),secret:"SYNTHETIC_INDEX_SECRET"},
    "agent:main:unrelated":{sessionId:"unrelated",secret:"SYNTHETIC_OTHER_CHANNEL_SECRET"}}));
  put(sessions,"unrelated.jsonl","SYNTHETIC_UNRELATED_CHAT");
  put(root,"openclaw.json","SYNTHETIC_CONFIG_SECRET");
  const request:SourceRequest={mode:"synthetic",root,sourceId:randomUUID(),batchId:randomUUID()};
  const run=(mode:"probe"|"export"|"metadata")=>spawnSync(process.execPath,["--input-type=module"],{input:sourceProgram(request,mode),maxBuffer:8*1024*1024,windowsHide:true,timeout:10000});
  const exportTo=(tag="received")=>{
    const result=run("export");assert.equal(result.status,0,result.stderr.toString());
    const wire=join(f.directory,tag+".bin"),output=join(f.directory,tag);writeFileSync(wire,result.stdout);mkdirSync(output);
    return {wire,output,result};
  };
  return {...f,root,sessions,request,run,exportTo};
}
const isCode=(value:string)=>(e:unknown)=>(e as {code?:string}).code===value;
test("M09：真实子进程源端采集只传当前网页与授权文档，完整校验原始字节",()=>{
  const f=sourceFixture(),{wire,output}=f.exportTo();
  const result=receiveSource(wire,output,f.request);assert.equal(result.records,2);assert.equal(result.files,10);assert.equal(result.unmappedArchiveCount,1);
  assert.equal(verifySource(output).files,10);
  assert.ok(readFileSync(join(output,"sessions",f.sessionId+".jsonl")).equals(readFileSync(join(f.sessions,f.sessionId+".jsonl"))));
  assert.equal(existsSync(join(output,"openclaw.json")),false);assert.equal(existsSync(join(output,"sessions","unrelated.jsonl")),false);
});
test("M09：索引只投影目标键，不复制凭据引用、其他渠道或缓存",()=>{
  const f=sourceFixture(),{wire,output,result}=f.exportTo();receiveSource(wire,output,f.request);
  assert.deepEqual(JSON.parse(readFileSync(join(output,"sessions/sessions.json"),"utf8")),{[key]:{sessionId:f.sessionId}});
  for(const sentinel of ["SYNTHETIC_INDEX_SECRET","SYNTHETIC_OTHER_CHANNEL_SECRET","SYNTHETIC_UNRELATED_CHAT","SYNTHETIC_CONFIG_SECRET"])
    assert.equal(result.stdout.includes(Buffer.from(sentinel)),false);
  const r=receipt(JSON.parse(readFileSync(join(output,"source-receipt.json"),"utf8")));assert.equal(r.sourceIndexPreserved,false);
});
test("M09：probe仅输出闭集计数，不泄漏文件名、会话ID和正文",()=>{
  const f=sourceFixture();put(f.root,"workspace/memory/SYNTHETIC_PRIVATE_FILENAME.md","SYNTHETIC_BODY");
  const r=f.run("probe");assert.equal(r.status,0,r.stderr.toString());const value=JSON.parse(r.stdout.toString());
  assert.equal(value.memoryFiles,2);
  for(const sentinel of ["SYNTHETIC_PRIVATE_FILENAME","SYNTHETIC_BODY",f.sessionId,f.root])assert.equal(r.stdout.includes(Buffer.from(sentinel)),false);
});
test("M09：源端缺少逻辑文档显式登记，不能造空文档补齐",()=>{
  const f=sourceFixture();
  const fs=spawnSync(process.execPath,["--input-type=module"],{input:'import fs from "node:fs";fs.unlinkSync('+JSON.stringify(join(f.root,"workspace/HEARTBEAT.md"))+');',windowsHide:true});assert.equal(fs.status,0);
  const {wire,output}=f.exportTo();const summary=receiveSource(wire,output,f.request);
  assert.deepEqual(summary.missingDocuments,["HEARTBEAT.md"]);assert.equal(existsSync(join(output,"workspace/HEARTBEAT.md")),false);
});
test("M09：目录联接和文件硬链接拒绝，不跟随到范围外",()=>{
  const f=sourceFixture();const outside=join(f.directory,"outside");mkdirSync(outside);put(outside,"x.md","SYNTHETIC_OUTSIDE");
  symlinkSync(outside,join(f.root,"workspace/memory/linked"),process.platform==="win32"?"junction":"dir");
  // 不匹配md的目录只统计不访问；匹配md的联接必须拒绝。
  symlinkSync(outside,join(f.root,"workspace/memory/linked.md"),process.platform==="win32"?"junction":"dir");
  const r=f.run("probe");assert.equal(r.status,1);assert.match(r.stderr.toString(),/SOURCE_PATH_UNSAFE/);assert.doesNotMatch(r.stderr.toString(),/SYNTHETIC_OUTSIDE/);
  const other=sourceFixture();linkSync(join(other.root,"workspace/SOUL.md"),join(other.directory,"alias.md"));
  assert.equal(other.run("export").status,1);
});
test("M09：索引指向范围外、其他会话头或不存在网页键时拒绝",()=>{
  for(const fault of ["escape","header","key"]){
    const f=sourceFixture();
    if(fault==="escape")put(f.sessions,"sessions.json",JSON.stringify({[key]:{sessionId:f.sessionId,sessionFile:join(f.root,"openclaw.json")}}));
    if(fault==="header")put(f.sessions,f.sessionId+".jsonl",sessionBytes("wrong-session"));
    if(fault==="key")put(f.sessions,"sessions.json",JSON.stringify({"agent:main:other":{sessionId:f.sessionId}}));
    const r=f.run("export");assert.equal(r.status,1);assert.equal(r.stdout.length,0);assert.doesNotMatch(r.stderr.toString(),/SYNTHETIC_CONFIG_SECRET|wrong-session/);
  }
});
test("M09：复制期间追加、轮换或新日记使批次失败",()=>{
  for(const mutation of ["append","rotate","new-memory"]){
    const f=sourceFixture();const code=sourceProgram(f.request,"probe").split("\nawait sourceMain(")[0]!;
    const action=mutation==="append"?'fs.appendFileSync('+JSON.stringify(join(f.sessions,f.sessionId+".jsonl"))+',"\\n")':
      mutation==="rotate"?'fs.writeFileSync('+JSON.stringify(join(f.sessions,"sessions.json"))+','+JSON.stringify(JSON.stringify({[key]:{sessionId:"changed"}}))+')':
      'fs.writeFileSync('+JSON.stringify(join(f.root,"workspace/memory/new.md"))+',"合成新记忆")';
    const script=code+'\ntry{collectSource('+JSON.stringify(f.request)+',()=>{'+action+'});process.exitCode=2;}catch(e){process.stdout.write(JSON.stringify({code:e.code??"SAFE_FAILED"}));}';
    const result=spawnSync(process.execPath,["--input-type=module"],{input:script,windowsHide:true,timeout:10000});
    assert.equal(result.status,0);assert.notEqual(result.stdout.length,0);
  }
});
test("M09：传输截断、篡改、多余字节或错误绑定均不发布完成receipt",()=>{
  for(const fault of ["truncated","tampered","extra","binding"]){
    const f=sourceFixture(),{wire,output}=f.exportTo(),bytes=readFileSync(wire);
    if(fault==="truncated")writeFileSync(wire,bytes.subarray(0,-1));
    if(fault==="tampered"){bytes[bytes.length-1]=bytes[bytes.length-1]!^1;writeFileSync(wire,bytes);}
    if(fault==="extra")writeFileSync(wire,Buffer.concat([bytes,Buffer.from("x")]));
    const expected=fault==="binding"?{...f.request,sourceId:randomUUID()}:f.request;
    assert.throws(()=>receiveSource(wire,output,expected));assert.equal(existsSync(join(output,"source-receipt.json")),false);
  }
});
test("M09：恶意receipt路径和伪造representation在写出文件前拒绝",()=>{
  const f=sourceFixture(),{wire,output}=f.exportTo();const bytes=readFileSync(wire),size=bytes.readUInt32BE(),r=JSON.parse(bytes.subarray(4,size+4).toString());
  for(const path of ["../escape.md","workspace/../SOUL.md","sessions/other.jsonl"]){
    const changed=structuredClone(r);changed.files.find((x:{kind:string})=>x.kind==="session").path=path;
    assert.throws(()=>receipt(changed));
  }
  r.files[0].representation="selected-index-projection";assert.throws(()=>receipt(r));
  assert.equal(existsSync(join(output,"source-receipt.json")),false);
});
test("M09：旧reset档案仅计入待映射数量，活动叶不靠最后一行猜",()=>{
  const f=sourceFixture();put(f.sessions,"old.jsonl.reset.2026-09-01","SYNTHETIC_OLD_UNMAPPED");
  const r=f.run("probe");assert.equal(r.status,0,r.stderr.toString());const result=JSON.parse(r.stdout.toString());
  assert.equal(result.unmappedArchiveCount,2);assert.equal(result.selectionVerified,false);assert.equal(result.leafCandidates,1);
});
test("M09：新的私人输出目录设定并核实ACL，不能覆盖已有目录",()=>{
  const f=sourceFixture(),directory=join(f.directory,"private-output");secureNewOutput(directory);
  assert.ok(existsSync(directory));assert.throws(()=>secureNewOutput(directory));
});
test("M09：source-verify CLI仅返回安全汇总，缺失文件不回显路径",()=>{
  const f=sourceFixture(),{wire,output}=f.exportTo();receiveSource(wire,output,f.request);
  const run=(input:string)=>spawnSync(process.execPath,["tools/import-openclaw/dist/cli.js","source-verify","--input="+input],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:10000});
  const good=run(output);assert.equal(good.status,0,good.stderr);assert.equal(JSON.parse(good.stdout).applied,false);
  const bad=run(join(f.directory,"SYNTHETIC_PRIVATE"));assert.equal(bad.status,1);assert.doesNotMatch(bad.stdout+bad.stderr,/SYNTHETIC_PRIVATE|[A-Z]:\\/);
});

test("M09：接收端不信任SSH返回的摘要，未知字段和正文伪装均拒绝",()=>{
  const f=sourceFixture(),result=f.run("probe");assert.equal(result.status,0);const valid=JSON.parse(result.stdout.toString());
  assert.equal(safeProbe(valid).ok,true);
  for(const bad of [{...valid,content:"SYNTHETIC_PRIVATE_BODY"},{...valid,sourceVersion:"SYNTHETIC_PRIVATE_BODY"},{...valid,missingDocuments:["SYNTHETIC_PRIVATE_FILENAME"]},
    {...valid,recordTypes:{...valid.recordTypes,message:"SYNTHETIC_BODY"}}])assert.throws(()=>safeProbe(bad),isCode("SOURCE_SUMMARY_INVALID"));
});

test("M09：远端错误只接受固定代码，不能通过错误名泄漏正文",()=>{
  assert.equal(sourceFailure('{"ok":false,"code":"SOURCE_CHANGED"}').code,"SOURCE_CHANGED");
  for(const raw of ['{"code":"SOURCE_SYNTHETIC_PRIVATE_SECRET"}',"SYNTHETIC_PRIVATE_BODY",'<html>SYNTHETIC_PRIVATE_BODY</html>'])
    assert.equal(sourceFailure(raw).code,"SSH_SOURCE_FAILED");
});


test("M10：本地审计只输出诊断，不把结构唯一叶当作运行时确认",()=>{
  const f=sourceFixture(),{wire,output}=f.exportTo();receiveSource(wire,output,f.request);
  const value=auditSource(output);
  assert.equal(value.archiveMessages.total,2);assert.equal(value.archiveMessages.protocolValid,true);
  assert.equal(value.candidate.uniqueStructuralLeaf,true);assert.equal(value.candidate.contextStatus,"valid");
  assert.equal(value.candidate.selectionVerified,false);assert.equal(value.readyForApply,false);
  const result=spawnSync(process.execPath,["tools/import-openclaw/dist/cli.js","source-audit","--input="+output],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).format,"kuinest-source-audit-v1");
  for(const sentinel of [f.sessionId,f.root,"蓝色纸船","合成推理"])assert.equal(result.stdout.includes(sentinel),false);
});
test("M10：诊断图片、思考签名、中断和工具思考缺口，原档不改写",()=>{
  const f=sourceFixture(),records=[
    entry("u",null,{role:"user",content:[{type:"text",text:"SYNTHETIC_PRIVATE_TEXT"},{type:"image",data:"SYNTHETIC_IMAGE_BYTES",mimeType:"image/png"}]}),
    entry("a","u",{role:"assistant",content:[{type:"thinking",thinking:"SYNTHETIC_PRIVATE_THOUGHT",thinkingSignature:"SYNTHETIC_SIGNATURE"},{type:"text",text:"合成部分回复"}],stopReason:"aborted"}),
    entry("tc","a",{role:"assistant",content:[{type:"toolCall",id:"tool1",name:"fake_tool",arguments:{secret:"SYNTHETIC_ARGUMENT"}}]}),
    entry("tr","tc",{role:"toolResult",toolCallId:"tool1",content:[{type:"text",text:"SYNTHETIC_RESULT"}]})
  ];
  put(f.sessions,f.sessionId+".jsonl",sessionBytes(f.sessionId,records));const {wire,output}=f.exportTo();receiveSource(wire,output,f.request);
  const before=readFileSync(join(output,"sessions",f.sessionId+".jsonl")),value=auditSource(output),encoded=JSON.stringify(value);
  const gaps=value.archiveMessages.gaps;
  assert.equal(gaps.MULTIMODAL_UNSUPPORTED,1);assert.equal(gaps.THINKING_SIGNATURE_UNSUPPORTED,1);
  assert.equal(gaps.ASSISTANT_INCOMPLETE,1);assert.equal(gaps.REASONING_MISSING,1);assert.equal(value.archiveMessages.protocolValid,true);
  assert.equal(value.archiveMessages.missingWhenReasoningRequired,1);assert.doesNotMatch(encoded,/SYNTHETIC_|fake_tool|tool1/);
  assert.ok(readFileSync(join(output,"sessions",f.sessionId+".jsonl")).equals(before));
});
test("M10：旧超长摘要仍计入诊断，被短摘要替代后可重建候选上下文",()=>{
  const f=sourceFixture(),time="2026-09-12T00:00:00.000Z";
  const records=[...messages(),{type:"compaction",id:"c1",parentId:"a1",timestamp:time,summary:"合".repeat(32769),firstKeptEntryId:"a1",tokensBefore:500},
    entry("u2","c1",{role:"user",content:"合成下一轮"}),entry("a2","u2",{role:"assistant",content:"合成回答",reasoning_content:"合成"}),
    {type:"compaction",id:"c2",parentId:"a2",timestamp:time,summary:"合成短摘要",firstKeptEntryId:"u2",tokensBefore:600}];
  put(f.sessions,f.sessionId+".jsonl",sessionBytes(f.sessionId,records));const {wire,output}=f.exportTo();receiveSource(wire,output,f.request);
  const value=auditSource(output);
  assert.equal(value.compactions.total,2);assert.equal(value.compactions.summaryOverLimit,1);
  assert.equal(value.candidate.latestSummaryOverLimit,false);assert.equal(value.candidate.tailMessages?.total,2);
  assert.equal(value.candidate.contextStatus,"valid");
});
test("M10：非法压缩锚点给固定缺口，不回显恶意摘要或标识",()=>{
  const f=sourceFixture(),records=[...messages(),{type:"compaction",id:"c",parentId:"a1",timestamp:"2026-09-12T00:00:00.000Z",summary:"SYNTHETIC_PRIVATE_SUMMARY",firstKeptEntryId:"SYNTHETIC_PRIVATE_ID",tokensBefore:10}];
  put(f.sessions,f.sessionId+".jsonl",sessionBytes(f.sessionId,records));const {wire,output}=f.exportTo();receiveSource(wire,output,f.request);
  const value=auditSource(output);assert.equal(value.mappingStatus,"COMPACTION_INVALID");assert.equal(value.compactions.invalidKeep,1);
  assert.equal(value.candidate.tailMessages,null);assert.doesNotMatch(JSON.stringify(value),/SYNTHETIC_PRIVATE/);
});
test("M10：存在多个结构叶时不擅自挑末行，未知条目名不输出",()=>{
  const f=sourceFixture(),records=[...messages(),{type:"SYNTHETIC_PRIVATE_TYPE",id:"other",parentId:"u1",timestamp:"2026-09-12T00:00:00.000Z"}];
  put(f.sessions,f.sessionId+".jsonl",sessionBytes(f.sessionId,records));const {wire,output}=f.exportTo();receiveSource(wire,output,f.request);
  const value=auditSource(output);assert.equal(value.candidate.uniqueStructuralLeaf,false);assert.equal(value.candidate.contextStatus,"not_assessed");
  assert.ok(value.mappingGaps.includes("UNKNOWN_ENTRY"));assert.doesNotMatch(JSON.stringify(value),/SYNTHETIC_PRIVATE_TYPE/);
});
test("M10：审计复验文档字节，不能只信收件单或只核对JSONL",()=>{
  const f=sourceFixture(),{wire,output}=f.exportTo();receiveSource(wire,output,f.request);put(output,"workspace/SOUL.md","SYNTHETIC_TAMPER");
  assert.throws(()=>auditSource(output),isCode("SOURCE_HASH_MISMATCH"));
  const result=spawnSync(process.execPath,["tools/import-openclaw/dist/cli.js","source-audit","--input="+output],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:10000});
  assert.equal(result.status,1);assert.doesNotMatch(result.stdout+result.stderr,/SYNTHETIC_TAMPER|[A-Z]:\\/);
});
test("M10：哈希一致但索引投影指向另一会话时仍拒绝",()=>{
  const f=sourceFixture(),{wire,output}=f.exportTo();receiveSource(wire,output,f.request);
  const bytes=Buffer.from(JSON.stringify({[key]:{sessionId:"different"}}));put(output,"sessions/sessions.json",bytes);
  const r=JSON.parse(readFileSync(join(output,"source-receipt.json"),"utf8"));const file=r.files.find((v:{kind:string})=>v.kind==="index");
  file.bytes=bytes.length;file.sha256=hash(bytes);put(output,"source-receipt.json",JSON.stringify(r));
  assert.throws(()=>auditSource(output),isCode("INDEX_MAPPING_MISMATCH"));
});

test("M09：中文及扩展汉字文件名端到端采集收件，名称和正文不进入摘要",()=>{
  const f=sourceFixture(),name="合成𠀀中文日记.md",content="SYNTHETIC_HAN_PRIVATE_BODY";
  put(f.root,"workspace/memory/"+name,content);const {wire,output}=f.exportTo();
  const summary=receiveSource(wire,output,f.request);assert.equal(summary.memoryFiles,2);
  assert.equal(readFileSync(join(output,"workspace/memory",name),"utf8"),content);assert.equal(verifySource(output).memoryFiles,2);
  const result=f.run("probe");assert.equal(result.status,0);assert.equal(result.stdout.includes(Buffer.from(name)),false);assert.equal(result.stdout.includes(Buffer.from(content)),false);
});
test("M09：不安全Unicode记忆名称只计未覆盖，不能随中文支持扩大路径边界",()=>{
  const f=sourceFixture();for(const name of ["含 空格.md","隐\u202e藏.md",".隐藏.md","混合é.md"])put(f.root,"workspace/memory/"+name,"SYNTHETIC_OUTSIDE_NAME");
  const {wire,output}=f.exportTo();const result=receiveSource(wire,output,f.request);
  assert.equal(result.unsupportedMemoryEntries,4);assert.equal(result.memoryFiles,1);
  assert.equal(readFileSync(wire).includes(Buffer.from("SYNTHETIC_OUTSIDE_NAME")),false);
  const r=receipt(JSON.parse(readFileSync(join(output,"source-receipt.json"),"utf8")));
  for(const path of ["workspace/memory/中文/旁路.md","workspace/memory/../SOUL.md","workspace/memory/CON.md","workspace/memory/隐\u202e藏.md"]) {
    const copy=structuredClone(r);copy.files.find(v=>v.kind==="memory")!.path=path;assert.throws(()=>receipt(copy));
  }
});
test("M09：中文命名的目录链接和多硬链接同样拒绝",()=>{
  for(const mode of ["junction","hardlink"]){
    const f=sourceFixture(),target=join(f.root,"workspace/memory/合成链接.md");
    if(mode==="junction")symlinkSync(f.input,target,process.platform==="win32"?"junction":"dir");
    else linkSync(join(f.root,"workspace/SOUL.md"),target);
    const result=f.run("export");assert.equal(result.status,1);assert.equal(result.stdout.length,0);
  }
});

function received(f:ReturnType<typeof sourceFixture>,tag:string) {
  const {wire,output}=f.exportTo(tag);receiveSource(wire,output,f.request);return output;
}
test("M11：源副本差异命令按稳定ID核对真实追加、中文新增与资料版本变化",()=>{
  const f=sourceFixture(),before=received(f,"before");
  f.request.batchId=randomUUID();put(f.root,"workspace/memory/合成新增.md","SYNTHETIC_NEW_BODY");put(f.root,"workspace/SOUL.md","SYNTHETIC_UPDATED_BODY");
  const records=[...messages(),entry("u2","a1",{role:"user",content:"合成新增输入"}),entry("a2","u2",{role:"assistant",content:"合成新增回复",reasoning_content:"合成"})];
  put(f.sessions,f.sessionId+".jsonl",sessionBytes(f.sessionId,records));const after=received(f,"after"),value=diffSource(before,after);
  assert.equal(value.structuralDeltaValid,true);assert.equal(value.records!.retained,2);assert.equal(value.records!.added,2);assert.equal(value.records!.bytePrefixPreserved,true);
  assert.equal(value.files.added.memory,1);assert.equal(value.files.changed.document,1);assert.equal(value.applied,false);
  const same=diffSource(after,after);assert.equal(same.records!.added,0);assert.deepEqual(same.reviewCodes,[]);
  const result=spawnSync(process.execPath,["tools/import-openclaw/dist/cli.js","source-diff","--before="+before,"--after="+after],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).needsMigrationManifest,true);
  for(const sentinel of [f.sessionId,f.root,"合成新增","SYNTHETIC_"])assert.equal(result.stdout.includes(sentinel),false);
});
test("M11：原条目改写或缩短不能伪装成追加",()=>{
  for(const kind of ["rewrite","remove"]){
    const f=sourceFixture(),before=received(f,"before");f.request.batchId=randomUUID();
    const records=kind==="rewrite"?[messages()[0]!,entry("a1","u1",{role:"assistant",content:"合成改写",reasoning_content:"合成"})]:messages().slice(0,1);
    put(f.sessions,f.sessionId+".jsonl",sessionBytes(f.sessionId,records));const after=received(f,"after"),value=diffSource(before,after);
    assert.equal(value.structuralDeltaValid,false);assert.ok(value.reviewCodes.includes("SOURCE_REWRITTEN"));
    assert.equal(kind==="rewrite"?value.records!.rewritten:value.records!.removed,1);
  }
});
test("M11：会话轮换要求显式映射，其他来源不能混合比较",()=>{
  const f=sourceFixture(),before=received(f,"before");f.request.batchId=randomUUID();const session=randomUUID();
  put(f.sessions,session+".jsonl",sessionBytes(session));put(f.sessions,"sessions.json",JSON.stringify({[key]:{sessionId:session}}));
  const after=received(f,"after"),value=diffSource(before,after);
  assert.equal(value.records,null);assert.equal(value.sameSession,false);assert.ok(value.reviewCodes.includes("SESSION_ROTATED_MAPPING_REQUIRED"));
  const other=sourceFixture(),outside=received(other,"outside");assert.throws(()=>diffSource(before,outside),isCode("SOURCE_BINDING_MISMATCH"));
});
test("M11：批次ID冲突与反向时间只给复核代码，不能自动应用",()=>{
  const f=sourceFixture(),before=received(f,"before");put(f.root,"workspace/SOUL.md","合成改动");
  const after=received(f,"after");assert.ok(diffSource(before,after).reviewCodes.includes("BATCH_ID_REUSED"));
  const original=JSON.parse(readFileSync(join(before,"source-receipt.json"),"utf8")),r=JSON.parse(readFileSync(join(after,"source-receipt.json"),"utf8"));
  r.batchId=randomUUID();r.capturedAt=original.capturedAt-1;put(after,"source-receipt.json",JSON.stringify(r));
  assert.ok(diffSource(before,after).reviewCodes.includes("SOURCE_ORDER_REVERSED"));
});
test("M11：差异比较也复验全部原档字节，损坏和异常不回显内容",()=>{
  const f=sourceFixture(),before=received(f,"before");f.request.batchId=randomUUID();const after=received(f,"after");
  put(after,"workspace/SOUL.md","SYNTHETIC_BAD_DIFF");assert.throws(()=>diffSource(before,after),isCode("SOURCE_HASH_MISMATCH"));
  const result=spawnSync(process.execPath,["tools/import-openclaw/dist/cli.js","source-diff","--before="+before,"--after="+after],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:10000});
  assert.equal(result.status,1);assert.doesNotMatch(result.stdout+result.stderr,/SYNTHETIC_BAD_DIFF|[A-Z]:\\/);
});

test("M10：区分中断原档与有效回放数量，实际CLI不泄漏partial或思考",()=>{
  const f=sourceFixture(),records=[messages()[0]!,entry("p","u1",{role:"assistant",api:"openai-completions",stopReason:"aborted",
    content:[{type:"text",text:"SYNTHETIC_PRIVATE_PARTIAL"}]}),
    entry("q","p",{role:"assistant",api:"openai-completions",stopReason:"error",content:[]}),
    entry("a1","q",{role:"assistant",content:"合成完成",reasoning_content:"合成"})];
  put(f.sessions,f.sessionId+".jsonl",sessionBytes(f.sessionId,records));const value=auditSource(received(f,"interrupted"));
  assert.equal(value.archiveMessages.total,4);assert.equal(value.archiveMessages.mapped,4);assert.equal(value.archiveMessages.replayMessages,2);
  assert.equal(value.archiveMessages.excludedFromReplay,2);assert.deepEqual(value.archiveMessages.interrupted,{aborted:1,error:1,visiblePartials:1});
  assert.equal(value.archiveMessages.gaps.ASSISTANT_INCOMPLETE,0);assert.equal(value.archiveMessages.missingWhenReasoningRequired,0);
  assert.equal(value.archiveMessages.protocolValid,true);assert.equal(value.candidate.contextStatus,"valid");assert.equal(value.readyForApply,false);
  const result=spawnSync(process.execPath,["tools/import-openclaw/dist/cli.js","source-audit","--input="+join(f.directory,"interrupted")],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:10000});
  assert.equal(result.status,0);assert.doesNotMatch(result.stdout+result.stderr,/SYNTHETIC_|合成完成/);
});

test("M10：固定版本线性档案可核实持久化默认分支，仍不代签现场状态",()=>{
  const session=parse(Buffer.from(sessionBytes("synthetic-session")));
  const result=persistedSelection(session,"2026.7.1-2");assert.equal(result.verified,true);assert.equal(result.records,2);
  assert.deepEqual(result.reviewCodes,[]);assert.equal(result.runtimeStateVerified,false);assert.equal(result.explicitOverrideVerified,false);
  assert.equal(persistedSelection(session,null).verified,false);assert.equal(persistedSelection(session,"2026.7.2").verified,false);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-session|蓝色纸船|u1|a1/);
});
test("M10：旁支、未知类型和side导航不能落入线性默认分支证明",()=>{
  const base=messages(),time=base[0]!.timestamp;
  const variants=[
    [...base,entry("branch","u1",{role:"assistant",content:"合成旁支"})],
    [...base,{id:"opaque",parentId:"a1",timestamp:time,type:"SYNTHETIC_PRIVATE_TYPE"}],
    [...base,{...entry("side","a1",{role:"assistant",content:"合成旁路"}),appendMode:"side"}],
    [...base,{id:"leaf",parentId:"a1",targetId:null,timestamp:time,type:"leaf"}],
    [base[1]!,base[0]!]
  ];
  for(const records of variants){const result=persistedSelection(parse(Buffer.from(sessionBytes("synthetic-session",records))),"2026.7.1-2");
    assert.equal(result.verified,false);assert.ok(result.reviewCodes.length);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE|合成旁/);}
});
test("M10：真实审计入口携带默认选择依据，收件单不能把非线性档案冒充已核实",()=>{
  for(const branched of [false,true]){
    const f=sourceFixture(),records=branched?[...messages(),entry("branch","u1",{role:"assistant",content:"合成旁支"})]:messages();
    put(f.sessions,f.sessionId+".jsonl",sessionBytes(f.sessionId,records));const output=received(f,"selection");
    const r=JSON.parse(readFileSync(join(output,"source-receipt.json"),"utf8"));r.sourceVersion="2026.7.1-2";put(output,"source-receipt.json",JSON.stringify(r));
    const result=auditSource(output);assert.equal(result.candidate.persistedDefault.verified,!branched);
    assert.equal(result.candidate.selectionVerified,false);assert.equal(result.readyForApply,false);
  }
});

function metadataFixture(){
  const f=sourceFixture(),index=JSON.parse(readFileSync(join(f.sessions,"sessions.json"),"utf8"));
  Object.assign(index[key],{modelProvider:"synthetic-provider",model:"SYNTHETIC_MODEL",thinkingLevel:"high",reasoningLevel:"off",contextTokens:12345,compactionCount:2,
    authProfileOverride:"SYNTHETIC_AUTH",pendingFinalDeliveryText:"SYNTHETIC_PENDING_TEXT",
    systemPromptReport:{source:"run",provider:"synthetic-provider",model:"SYNTHETIC_MODEL",bootstrapMaxChars:80000,bootstrapTotalMaxChars:120000,
      workspaceDir:"SYNTHETIC_PRIVATE_PATH",systemPrompt:{chars:1200,private:"SYNTHETIC_PROMPT"},tools:{entries:[{name:"SYNTHETIC_TOOL_NAME"}]},
      skills:{entries:[{name:"SYNTHETIC_SKILL_NAME"}]},injectedWorkspaceFiles:[{path:"SYNTHETIC_FILE",truncated:false,missing:false}]}});
  put(f.sessions,"sessions.json",JSON.stringify(index));
  const run=f.run("metadata");assert.equal(run.status,0,run.stderr.toString());
  const output=join(f.directory,"metadata");mkdirSync(output);receiveMetadata(run.stdout,output,f.request);
  return {...f,index,metadataBytes:run.stdout,metadataOutput:output};
}
test("M12：会话元数据只选白名单，凭据引用、待投递文本和提示词信息不复制",()=>{
  const f=metadataFixture(),raw=f.metadataBytes.toString(),m=metadata(JSON.parse(raw));
  assert.equal(m.values.model,"SYNTHETIC_MODEL");assert.equal((m.values.report as {toolCount:number}).toolCount,1);
  for(const sentinel of ["SYNTHETIC_AUTH","SYNTHETIC_PENDING_TEXT","SYNTHETIC_PROMPT","SYNTHETIC_PRIVATE_PATH","SYNTHETIC_TOOL_NAME","SYNTHETIC_SKILL_NAME","SYNTHETIC_FILE","SYNTHETIC_OTHER_CHANNEL_SECRET","SYNTHETIC_CONFIG_SECRET"])
    assert.equal(raw.includes(sentinel),false);
  const summary=metadataSummary(m);assert.equal(summary.modelPairPresent,true);assert.equal(summary.reportModelMatchesSession,true);
  assert.equal(summary.runtimeConfigurationVerified,false);assert.equal(summary.applied,false);assert.doesNotMatch(JSON.stringify(summary),/SYNTHETIC_MODEL|synthetic-provider/);
});
test("M12：类型异常只报固定字段名，收件端拒绝未知字段或伪造运行时确认",()=>{
  const f=metadataFixture();f.index[key].model="SYNTHETIC_BAD\nBODY";f.index[key].contextTokens=-1;
  put(f.sessions,"sessions.json",JSON.stringify(f.index));const r=f.run("metadata");assert.equal(r.status,0);
  const m=metadata(JSON.parse(r.stdout.toString()));assert.ok(m.problems.includes("model"));assert.ok(m.problems.includes("contextTokens"));
  assert.doesNotMatch(r.stdout.toString(),/SYNTHETIC_BAD|BODY/);
  for(const changed of [{...m,secret:"SYNTHETIC_SECRET"},{...m,runtimeConfigurationVerified:true},{...m,values:{...m.values,authProfileOverride:"SYNTHETIC_AUTH"}},{...m,problems:["SYNTHETIC_BODY"]}])
    assert.throws(()=>metadata(changed),isCode("METADATA_INVALID"));
});
test("M12：元数据采集中索引变化拒绝，不读取工作区文档或完整配置",()=>{
  const f=sourceFixture(),code=readFileSync(join(projectRoot,"tools/import-openclaw/source-reader.mjs"),"utf8");
  const script=code+'\ntry{collectSourceMetadata('+JSON.stringify(f.request)+',()=>fs.appendFileSync('+JSON.stringify(join(f.sessions,"sessions.json"))+'," "));process.exitCode=2;}catch(e){console.log(JSON.stringify({code:e.code}));}';
  const r=spawnSync(process.execPath,["--input-type=module"],{input:script,windowsHide:true,timeout:10000});assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout.toString()).code,"SOURCE_CHANGED");
  const outside=join(f.directory,"outside-metadata");mkdirSync(outside);put(outside,"target.md","SYNTHETIC_TRAP");
  // 文档改为 reader 明确拒绝的多硬链接；Windows 无需符号链接权限，元数据命令不碰该路径。
  const doc=join(f.root,"workspace/SOUL.md");
  const setup=spawnSync(process.execPath,["--input-type=module"],{input:'import fs from "node:fs";fs.unlinkSync('+JSON.stringify(doc)+');fs.linkSync('+JSON.stringify(join(outside,"target.md"))+','+JSON.stringify(doc)+');',windowsHide:true});
  assert.equal(setup.status,0,setup.stderr.toString());const result=f.run("metadata");assert.equal(result.status,0);assert.doesNotMatch(result.stdout.toString(),/SYNTHETIC_TRAP/);
});
test("M12：元数据与源副本按来源和会话绑定，模型只比较布尔结果",()=>{
  const f=metadataFixture(),records=[messages()[0]!,entry("a1","u1",{role:"assistant",provider:"synthetic-provider",model:"SYNTHETIC_MODEL",content:"合成答复",reasoning_content:"合成"})];
  put(f.sessions,f.sessionId+".jsonl",sessionBytes(f.sessionId,records));const source=received(f,"metadata-source"),value=compareMetadata(f.metadataOutput,source);
  assert.equal(value.sameSession,true);assert.equal(value.indexHashMatchesSource,true);assert.equal(value.modelPairMatchesLastArchivedAssistant,true);
  assert.equal(value.profileVerified,false);assert.doesNotMatch(JSON.stringify(value),/SYNTHETIC_MODEL|synthetic-provider/);
  const different={...JSON.parse(f.metadataBytes.toString()),sessionId:"different"};const other=join(f.directory,"metadata-other");mkdirSync(other);receiveMetadata(Buffer.from(JSON.stringify(different)),other,f.request);
  assert.ok(compareMetadata(other,source).reviewCodes.includes("SESSION_ROTATED_MAPPING_REQUIRED"));
  const outsider=sourceFixture(),otherSource=received(outsider,"other-source");assert.throws(()=>compareMetadata(f.metadataOutput,otherSource),isCode("SOURCE_BINDING_MISMATCH"));
});
test("M12：元数据实际CLI仅输出安全汇总，篡改后复核拒绝且无正文异常",()=>{
  const f=metadataFixture(),args=["tools/import-openclaw/dist/cli.js","metadata-verify","--input="+f.metadataOutput];
  const run=()=>spawnSync(process.execPath,args,{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:10000});
  let result=run();assert.equal(result.status,0);assert.doesNotMatch(result.stdout+result.stderr,/SYNTHETIC_|synthetic-provider/);
  put(f.metadataOutput,"source-metadata.json","SYNTHETIC_CORRUPTION");result=run();assert.equal(result.status,1);assert.doesNotMatch(result.stdout+result.stderr,/SYNTHETIC_CORRUPTION|[A-Z]:\\/);
});
test("M12：元数据绑定与长度限制在发布前检查，既有收件不能覆盖",()=>{
  const f=metadataFixture(),out=join(f.directory,"bad-metadata");mkdirSync(out);
  assert.throws(()=>receiveMetadata(f.metadataBytes,out,{sourceId:randomUUID(),batchId:f.request.batchId}),isCode("SOURCE_BINDING_MISMATCH"));
  assert.equal(existsSync(join(out,"source-metadata.json")),false);
  assert.throws(()=>receiveMetadata(Buffer.alloc(16385),out,f.request),isCode("METADATA_LIMIT"));
  const before=readFileSync(join(f.metadataOutput,"source-metadata.json"));assert.throws(()=>receiveMetadata(f.metadataBytes,f.metadataOutput,f.request));
  assert.ok(readFileSync(join(f.metadataOutput,"source-metadata.json")).equals(before));assert.equal(verifyMetadata(f.metadataOutput).modelPairPresent,true);
});

test("M12：索引时点、源版本与待切换状态分别复核，不冒充同一快照",()=>{
  const f=metadataFixture(),source=received(f,"metadata-time-source");
  const receipt=JSON.parse(readFileSync(join(source,"source-receipt.json"),"utf8"));
  const v={...JSON.parse(f.metadataBytes.toString()),sourceVersion:"2026.7.2",capturedAt:receipt.capturedAt-1,sourceIndexSha256:"b".repeat(64)};
  v.values.liveModelSwitchPending=true;
  const out=join(f.directory,"metadata-different-time");mkdirSync(out);receiveMetadata(Buffer.from(JSON.stringify(v)),out,f.request);
  const result=compareMetadata(out,source);
  assert.equal(result.sourceVersionMatches,false);
  assert.deepEqual(result.reviewCodes,["SOURCE_VERSION_CHANGED","INDEX_CHANGED_SINCE_SOURCE","METADATA_PREDATES_SOURCE","MODEL_SWITCH_PENDING"]);
  assert.throws(()=>reviewReadiness(out,source),isCode("READINESS_BINDING_MISMATCH"));
});
test("M13：缺思考按记录模型对分类，中断和未知身份不能冒充当前协议缺失",()=>{
  const raw=(id:string,message:Record<string,unknown>)=>entry(id,null,message);
  const records=[
    raw("same",{role:"assistant",model:"SYNTHETIC_MODEL",provider:"synthetic-provider",content:"合成"}),
    raw("other",{role:"assistant",model:"SYNTHETIC_OTHER",provider:"synthetic-provider",content:[{type:"toolCall",id:"t1",name:"SYNTHETIC_TOOL",arguments:{}}]}),
    raw("unknown",{role:"assistant",content:"合成"}),
    raw("thought",{role:"assistant",model:"SYNTHETIC_MODEL",provider:"synthetic-provider",content:[{type:"thinking",thinking:"SYNTHETIC_REASONING"}]}),
    raw("aborted",{role:"assistant",api:"openai-responses",stopReason:"aborted",content:[]})
  ];
  const result=protocolReadiness(records,{model:"SYNTHETIC_MODEL",modelProvider:"synthetic-provider"});
  assert.equal(result.reasoning.replayAssistants,4);assert.equal(result.reasoning.missing,3);assert.equal(result.reasoning.missingWithTools,1);
  assert.equal(result.reasoning.missingSameRecordedPair,1);assert.equal(result.reasoning.missingDifferentRecordedPair,1);assert.equal(result.reasoning.missingUnknownRecordedPair,1);
  assert.equal(result.reasoning.apiUnverified,true);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_|synthetic-provider/);
});
test("M13：图片按角色、格式与字节结构诊断，图片数据与源自定义键不输出",()=>{
  const png=Buffer.from([137,80,78,71,13,10,26,10]).toString("base64");
  const result=protocolReadiness([
    entry("u",null,{role:"user",content:[{type:"text",text:"SYNTHETIC_BODY"},{type:"image",mimeType:"image/png",data:png},{type:"image",mimeType:"image/png",data:png}]}),
    entry("t","u",{role:"toolResult",toolCallId:"SYNTHETIC_ID",content:[{type:"image",mimeType:"image/jpeg",data:Buffer.from([255,216,255]).toString("base64")}]}),
    entry("bad","t",{role:"assistant",content:[{type:"image",mimeType:"SYNTHETIC_MIME",data:"!",SYNTHETIC_KEY:"SYNTHETIC_SECRET"}]})
  ],{});
  assert.equal(result.images.blocks,4);assert.equal(result.images.user,2);assert.equal(result.images.tool,1);assert.equal(result.images.assistant,1);
  assert.equal(result.images.structurallySupported,3);assert.equal(result.images.invalidBase64,1);assert.equal(result.images.unsupportedFields,1);
  assert.equal(result.images.mixedWithText,1);assert.equal(result.images.multipleInMessage,1);
  assert.equal(result.images.decoderVerified,false);assert.doesNotMatch(JSON.stringify(result),new RegExp("SYNTHETIC_|"+png));
});
test("M13：不规范base64、内容签名错配与未知MIME不能成为结构通过",()=>{
  for(const data of ["Zh==","a===","Zg==\\n","https://example.invalid/image"]){
    const result=protocolReadiness([entry("u",null,{role:"user",content:[{type:"image",mimeType:"image/png",data}]})],{});
    assert.equal(result.images.invalidBase64,1);assert.equal(result.images.structurallySupported,0);
  }
  const result=protocolReadiness([entry("u",null,{role:"user",content:[{type:"image",mimeType:"image/png",data:Buffer.from("SYNTHETIC_NOT_IMAGE").toString("base64")}]})],{});
  assert.equal(result.images.signatureMismatch,1);assert.equal(result.images.structurallySupported,0);
});
test("M13：多MiB合成图片不靠深层正则回溯，魔数通过不等于可解码",()=>{
  const bytes=Buffer.alloc(3*1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const result=protocolReadiness([entry("u",null,{role:"user",content:[{type:"image",mimeType:"image/png",data:bytes.toString("base64")}]})],{});
  assert.equal(result.images.largestBytes,bytes.length);assert.equal(result.images.structurallySupported,1);assert.equal(result.images.decoderVerified,false);
});
test("M13：实际readiness CLI只输出缺口与布尔对照，仍禁止apply和代签",()=>{
  const f=metadataFixture(),source=received(f,"readiness-source");
  const r=spawnSync(process.execPath,["tools/import-openclaw/dist/cli.js","source-readiness","--metadata="+f.metadataOutput,"--source="+source],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:10000});
  assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.readyForApply,false);assert.equal(result.applied,false);
  assert.equal(result.bootstrap.compilerEquivalent,false);assert.equal(result.userAcceptance,"pending");
  assert.doesNotMatch(r.stdout+r.stderr,/SYNTHETIC_|synthetic-provider|SYNTHETIC_ID/);
  put(source,"workspace/SOUL.md","SYNTHETIC_TAMPER");
  assert.throws(()=>reviewReadiness(f.metadataOutput,source),isCode("SOURCE_HASH_MISMATCH"));
});

function projectConfigFixture(input:unknown,extra=""){
  const projection=readFileSync(join(projectRoot,"tools/import-openclaw/config-projection.mjs"),"utf8");
  const script=projection+'\nconst value='+JSON.stringify(input)+';'+extra+'\ntry{process.stdout.write(JSON.stringify(projectLegacyConfiguration(value,{modelProvider:"synthetic-provider",model:"SYNTHETIC_MODEL"})));}catch{process.stdout.write(JSON.stringify({code:"CONFIG_PROJECTION_FAILED"}));process.exitCode=1;}';
  return spawnSync(process.execPath,["--input-type=module"],{input:script,encoding:"utf8",windowsHide:true,timeout:10000});
}
function configFixture(){
  return {models:{providers:{"synthetic-provider":{baseUrl:"https://example.invalid/v1",api:"openai-completions",apiKey:"SYNTHETIC_CREDENTIAL",
    headers:{Authorization:"SYNTHETIC_AUTH_HEADER"},params:{temperature:0.5},models:[
      {id:"SYNTHETIC_MODEL",reasoning:true,input:["text","image"],maxTokens:16000,contextWindow:1000000,params:{thinking:{type:"disabled"}},compat:{thinkingFormat:"deepseek"}},
      {id:"SYNTHETIC_OTHER_MODEL",apiKey:"SYNTHETIC_OTHER_SECRET"}]}}},
    agents:{defaults:{thinkingDefault:"high",bootstrapMaxChars:80000,bootstrapTotalMaxChars:120000,userTimezone:"Asia/Shanghai",
      models:{"synthetic-provider/SYNTHETIC_MODEL":{params:{maxTokens:8000}}},
      compaction:{customInstructions:"SYNTHETIC_PRIVATE_PROMPT",memoryFlush:{enabled:true,prompt:"SYNTHETIC_FLUSH_PROMPT"}},
      heartbeat:{every:"30m",prompt:"SYNTHETIC_HEARTBEAT_PROMPT",to:"SYNTHETIC_RECIPIENT"}},list:[{id:"main",params:{reasoning_effort:"low"}}]},
    channels:{token:"SYNTHETIC_CHANNEL_SECRET"},env:{API_KEY:"SYNTHETIC_ENV_SECRET"}};
}
test("M14：配置投影只保留声明白名单和分层参数，不复制凭据或提示词",()=>{
  const result=projectConfigFixture(configFixture());assert.equal(result.status,0,result.stderr);const p=JSON.parse(result.stdout);
  assert.deepEqual(p.declared.input,["text","image"]);assert.equal(p.parameterLayers.model.thinking.type,"disabled");
  assert.equal(p.parameterLayers.defaultsModel.maxTokens,8000);assert.equal(p.parameterLayers.mainAgent.reasoning_effort,"low");
  assert.equal(p.compaction.customInstructionsPresent,true);assert.equal(p.heartbeat.every,"30m");
  assert.equal(p.effectiveRuntimeVerified,false);assert.equal(p.configurationResolved,false);assert.equal(p.credentialsPreserved,false);
  assert.doesNotMatch(result.stdout,/SYNTHETIC_(CREDENTIAL|AUTH_HEADER|OTHER_MODEL|OTHER_SECRET|PRIVATE_PROMPT|FLUSH_PROMPT|HEARTBEAT_PROMPT|RECIPIENT|CHANNEL_SECRET|ENV_SECRET)/);
});
test("M14：秘密字段getter不被访问，不能通过整体复制悄悄读取其他字段",()=>{
  const extra='for(const key of ["apiKey","headers"]){Object.defineProperty(value.models.providers["synthetic-provider"],key,{get(){throw Error("SYNTHETIC_SECRET_GETTER");}});}for(const key of ["channels","env"]){Object.defineProperty(value,key,{get(){throw Error("SYNTHETIC_SECRET_GETTER");}});}';
  const result=projectConfigFixture(configFixture(),extra);assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/SYNTHETIC_SECRET_GETTER/);
});
test("M14：带凭据或未确认路径的端点不回传，未知参数只给固定复核代码",()=>{
  for(const url of ["https://user:SYNTHETIC_URL_SECRET@example.invalid/v1","https://example.invalid/v1?key=SYNTHETIC_URL_SECRET","https://example.invalid/SYNTHETIC_URL_SECRET","http://example.invalid/v1"]){
    const config=configFixture();config.models.providers["synthetic-provider"].baseUrl=url;
    const result=projectConfigFixture(config);assert.equal(result.status,0);const p=JSON.parse(result.stdout);
    assert.equal(p.declared.baseUrl,undefined);assert.ok(p.issues.includes("ENDPOINT_REQUIRES_REVIEW"));assert.doesNotMatch(result.stdout,/SYNTHETIC_URL_SECRET/);
  }
  const config=configFixture() as Record<string,any>;config.models.providers["synthetic-provider"].params={temperature:"SYNTHETIC_BAD_NUMBER",secret:"SYNTHETIC_PARAM_SECRET"};
  const r=projectConfigFixture(config);assert.equal(r.status,0);assert.ok(JSON.parse(r.stdout).issues.includes("PARAMETERS_REQUIRE_REVIEW"));assert.doesNotMatch(r.stdout,/SYNTHETIC_BAD_NUMBER|SYNTHETIC_PARAM_SECRET/);
});
test("M14：include、歧义模型和未知输入能力不从其他配置猜补",()=>{
  const config=configFixture() as Record<string,any>;config.$include="SYNTHETIC_OTHER_CONFIG";
  config.models.providers["synthetic-provider"].models[0].input=["SYNTHETIC_MODALITY"];
  config.models.providers["synthetic-provider"].models.push({...config.models.providers["synthetic-provider"].models[0]});
  const r=projectConfigFixture(config);assert.equal(r.status,0);const p=JSON.parse(r.stdout);
  assert.ok(p.issues.includes("INCLUDED_CONFIGURATION_NOT_RESOLVED"));assert.ok(p.issues.includes("MODEL_DECLARATION_MISSING_OR_AMBIGUOUS"));
  assert.equal(p.dynamicConfigurationPresent,true);assert.equal(p.declared.input,undefined);assert.doesNotMatch(r.stdout,/SYNTHETIC_OTHER_CONFIG|SYNTHETIC_MODALITY/);
});

function configModule(code:string){
  const moduleUrl=pathToFileURL(join(projectRoot,"tools/import-openclaw/profile-capture.mjs")).href;
  return spawnSync(process.execPath,["--input-type=module"],{input:'import {configurationProgram,validateConfigurationReview} from '+JSON.stringify(moduleUrl)+';import {spawnSync} from "node:child_process";'+code,encoding:"utf8",windowsHide:true,timeout:15000});
}
test("M14：预备采集程序实际子进程只读配置和目标索引，正文不进入投影",()=>{
  const f=metadataFixture();put(f.root,"openclaw.json",JSON.stringify(configFixture()));
  put(f.root,"workspace/SOUL.md","SYNTHETIC_WORKSPACE_NOT_READ");
  const code='const request='+JSON.stringify(f.request)+';const r=spawnSync(process.execPath,["--input-type=module"],{input:configurationProgram(request),encoding:"utf8",windowsHide:true});if(r.status!==0){process.stderr.write(r.stderr);process.exitCode=1;}else{const v=validateConfigurationReview(Buffer.from(r.stdout),request);process.stdout.write(JSON.stringify(v));}';
  const r=configModule(code);assert.equal(r.status,0,r.stderr);const v=JSON.parse(r.stdout);
  assert.equal(v.format,"kuinest-config-review-v1");assert.equal(v.projection.configurationResolved,false);
  assert.doesNotMatch(r.stdout+r.stderr,/SYNTHETIC_(WORKSPACE_NOT_READ|CREDENTIAL|AUTH_HEADER|PRIVATE_PROMPT|CHANNEL_SECRET|ENV_SECRET)/);
});
test("M14：配置采集拒绝路径联接、损坏JSON与未知回包字段",()=>{
  const f=metadataFixture();put(f.root,"openclaw.json",JSON.stringify(configFixture()));
  const request=JSON.stringify(f.request);
  const r=configModule('const request='+request+';const r=spawnSync(process.execPath,["--input-type=module"],{input:configurationProgram(request),encoding:"utf8",windowsHide:true});const original=JSON.parse(r.stdout);let rejected=0;for(const kind of ["root","nested","url","binding","shape"]){const v=structuredClone(original);if(kind==="root")v.secret="SYNTHETIC_SECRET";if(kind==="nested")v.projection.declared.apiKey="SYNTHETIC_SECRET";if(kind==="url")v.projection.declared.baseUrl="https://example.invalid/v1?key=SYNTHETIC_SECRET";if(kind==="binding")v.sourceId="00000000-0000-0000-0000-000000000000";if(kind==="shape")v.projection.declared.reasoning={model:"SYNTHETIC_SECRET"};try{validateConfigurationReview(Buffer.from(JSON.stringify(v)),request);}catch{rejected++;}}process.stdout.write(JSON.stringify({rejected}));');
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).rejected,5);
  put(f.root,"openclaw.json","SYNTHETIC_MALFORMED_SECRET");
  const bad=configModule('const r=spawnSync(process.execPath,["--input-type=module"],{input:configurationProgram('+request+'),encoding:"utf8",windowsHide:true});process.stdout.write(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr}));');
  assert.equal(bad.status,0);assert.equal(JSON.parse(bad.stdout).status,1);assert.doesNotMatch(bad.stdout,/SYNTHETIC_MALFORMED_SECRET/);
  // 多硬链接是与生产采集相同的拒绝路径，无需Windows符号链接特权。
  linkSync(join(f.root,"openclaw.json"),join(f.directory,"config-alias"));
  const unsafe=configModule('const r=spawnSync(process.execPath,["--input-type=module"],{input:configurationProgram('+request+'),encoding:"utf8",windowsHide:true});process.stdout.write(r.stderr);');
  assert.equal(unsafe.status,0);assert.match(unsafe.stdout,/SOURCE_PATH_UNSAFE/);
});
test("M14：配置采集CLI缺显式scope时在SSH和私有写入前拒绝",()=>{
  const r=spawnSync(process.execPath,["tools/import-openclaw/profile-capture.mjs","--host=invalid"],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:10000});
  assert.equal(r.status,1);assert.equal(r.stdout,"");assert.deepEqual(JSON.parse(r.stderr),{ok:false,code:"ARGUMENT_INVALID"});
});
