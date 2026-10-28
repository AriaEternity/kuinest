import { openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedFile } from "../../../apps/backend/dist/storage/paths.js";
import { allowed } from "./manifest.js";
import { check, hash, json, object, id, uuid, hex, limits, read, write } from "./safe.js";
import type { FileKind } from "./types.js";
export type ReceiptFile={path:string;kind:FileKind;sha256:string;bytes:number;representation:"original-bytes"|"selected-index-projection"};
export type SourceReceipt={
  format:"kuinest-openclaw-source-v1";sourceId:string;batchId:string;mode:"private"|"synthetic";agentId:"main";
  sessionKey:"agent:main:xiaokui-web";scope:"main-workspace-and-current-web-session";sourceVersion:string|null;
  capturedAt:number;consistency:"double-read-matched";sessionId:string;sourceIndexSha256:string;sourceIndexPreserved:false;historyCoverage:"current-session-only";
  missingDocuments:string[];unsupportedMemoryEntries:number;unmappedArchiveCount:number;
  tree:{format:number|null;records:number;counts:Record<string,number>;invalid:number;missingParents:number;cycles:number;leaves:number;sideControls:number;leafCandidate:string|null;selectionVerified:false};
  files:ReceiptFile[];
};
const core=["IDENTITY.md","SOUL.md","USER.md","AGENTS.md","TOOLS.md","HEARTBEAT.md","MEMORY.md"];
const types=["message","compaction","branch_summary","custom_message","custom","model_change","thinking_level_change","session_info","label","other"];
const natural=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
export function receipt(value:unknown):SourceReceipt{
  check(object(value)&&Object.keys(value).every(k=>["format","sourceId","batchId","mode","agentId","sessionKey","scope","sourceVersion","capturedAt","consistency","sessionId","sourceIndexSha256","sourceIndexPreserved","historyCoverage","missingDocuments","unsupportedMemoryEntries","unmappedArchiveCount","tree","files"].includes(k)),"SOURCE_RECEIPT_INVALID");
  check(value.format==="kuinest-openclaw-source-v1"&&uuid(value.sourceId)&&uuid(value.batchId)&&["private","synthetic"].includes(String(value.mode))
    &&value.agentId==="main"&&value.sessionKey==="agent:main:xiaokui-web"&&value.scope==="main-workspace-and-current-web-session"
    &&(value.sourceVersion===null||typeof value.sourceVersion==="string"&&/^[0-9]{4}\.[0-9]+\.[0-9]+(?:-[0-9]+)?$/.test(value.sourceVersion)),"SOURCE_RECEIPT_INVALID");
  check(natural(value.capturedAt)&&value.consistency==="double-read-matched"&&id(value.sessionId)&&hex(value.sourceIndexSha256)&&value.sourceIndexPreserved===false&&value.historyCoverage==="current-session-only","SOURCE_RECEIPT_INVALID");
  check(Array.isArray(value.missingDocuments)&&value.missingDocuments.every(d=>typeof d==="string"&&core.includes(d))
    &&new Set(value.missingDocuments).size===value.missingDocuments.length&&natural(value.unsupportedMemoryEntries)&&natural(value.unmappedArchiveCount),"SOURCE_RECEIPT_INVALID");
  const tree=value.tree;check(object(tree)&&Object.keys(tree).every(k=>["format","records","counts","invalid","missingParents","cycles","leaves","sideControls","leafCandidate","selectionVerified"].includes(k))
    &&(tree.format===null||natural(tree.format))&&["records","invalid","missingParents","cycles","leaves","sideControls"].every(k=>natural(tree[k]))
    &&(tree.leafCandidate===null||id(tree.leafCandidate))&&tree.selectionVerified===false,"SOURCE_RECEIPT_INVALID");
  const counts=tree.counts;check(object(counts)&&Object.keys(counts).length===types.length&&types.every(k=>natural(counts[k])),"SOURCE_RECEIPT_INVALID");
  check(Array.isArray(value.files)&&value.files.length>0&&value.files.length<=limits.files,"SOURCE_RECEIPT_INVALID");
  const names=new Set<string>();let total=0;
  for(const f of value.files){
    check(object(f)&&Object.keys(f).every(k=>["path","kind","sha256","bytes","representation"].includes(k))&&typeof f.path==="string"&&f.kind!=="addition"&&allowed(f.path,f.kind as FileKind)
      &&["document","memory","session","index"].includes(String(f.kind))&&!names.has(f.path.toLowerCase())&&hex(f.sha256)&&natural(f.bytes)&&Number(f.bytes)<=limits.file,"SOURCE_RECEIPT_INVALID");
    names.add(f.path.toLowerCase());total+=Number(f.bytes);
    check(f.representation===(f.kind==="index"?"selected-index-projection":"original-bytes"),"SOURCE_RECEIPT_INVALID");
  }
  check(total<=limits.total&&value.files.filter(f=>f.kind==="session").length===1&&value.files.some(f=>f.path==="sessions/"+value.sessionId+".jsonl")
    &&value.files.filter(f=>f.kind==="index").length===1,"SOURCE_RECEIPT_INVALID");
  for(const name of core)check(names.has(("workspace/"+name).toLowerCase())!==value.missingDocuments.includes(name),"SOURCE_RECEIPT_INVALID");
  return structuredClone(value) as SourceReceipt;
}
export function sourceSummary(r:SourceReceipt){
  return {ok:true,sourceVersion:r.sourceVersion,files:r.files.length,bytes:r.files.reduce((n,f)=>n+f.bytes,0),documents:r.files.filter(f=>f.kind==="document").length,
    memoryFiles:r.files.filter(f=>f.kind==="memory").length,sessionFormat:r.tree.format,records:r.tree.records,recordTypes:r.tree.counts,
    invalidRecords:r.tree.invalid,missingParents:r.tree.missingParents,cycles:r.tree.cycles,leafCandidates:r.tree.leaves,sideControls:r.tree.sideControls,
    missingDocuments:r.missingDocuments,unsupportedMemoryEntries:r.unsupportedMemoryEntries,unmappedArchiveCount:r.unmappedArchiveCount,
    consistency:r.consistency,historyCoverage:r.historyCoverage,selectionVerified:false,sourceIndexPreserved:false};
}
function exact(fd:number,length:number,offset:number):Buffer{
  const b=Buffer.alloc(length);let used=0;
  while(used<length){const n=readSync(fd,b,used,length-used,offset+used);check(n>0,"SOURCE_TRANSFER_TRUNCATED");used+=n;}
  return b;
}
export function receiveSource(wire:string,output:string,expected:{sourceId:string;batchId:string;mode:string}){
  const fd=openSync(checkedFile(wire),"r");
  try{
    const size=statSync(wire).size;check(size>=4&&size<=limits.total+2*1024*1024+4,"SOURCE_TRANSFER_LIMIT");
    const length=exact(fd,4,0).readUInt32BE();check(length>0&&length<=2*1024*1024&&length+4<=size,"SOURCE_TRANSFER_INVALID");
    const header=exact(fd,length,4),r=receipt(json(header));
    check(r.sourceId===expected.sourceId&&r.batchId===expected.batchId&&r.mode===expected.mode,"SOURCE_BINDING_MISMATCH");
    check(size===4+length+r.files.reduce((n,f)=>n+f.bytes,0),"SOURCE_TRANSFER_TRUNCATED");
    let position=4+length;
    // 完整验证后才发布receipt；失败目录只有隔离材料，没有可应用清单。
    for(const f of r.files){const b=exact(fd,f.bytes,position);check(hash(b)===f.sha256,"SOURCE_HASH_MISMATCH");position+=f.bytes;}
    position=4+length;
    for(const f of r.files){const b=exact(fd,f.bytes,position);check(hash(b)===f.sha256,"SOURCE_HASH_MISMATCH");write(output,f.path,b);position+=f.bytes;}
    write(output,"source-receipt.json",header);
    return sourceSummary(r);
  }finally{closeSync(fd);}
}
export function loadSource(directory:string){
  const receiptBytes=read(directory,"source-receipt.json",2*1024*1024),r=receipt(json(receiptBytes)),files=new Map<string,Buffer>();
  for(const f of r.files){const b=read(directory,f.path);check(b.length===f.bytes&&hash(b)===f.sha256,"SOURCE_HASH_MISMATCH");files.set(f.path,b);}
  return {receipt:r,receiptHash:hash(receiptBytes),files};
}
export function verifySource(directory:string){return sourceSummary(loadSource(directory).receipt);}

export function safeProbe(value:unknown){
  check(object(value)&&Object.keys(value).every(k=>["ok","sourceVersion","files","bytes","documents","memoryFiles","sessionFormat","records","recordTypes","invalidRecords","missingParents","cycles","leafCandidates","sideControls","missingDocuments","unsupportedMemoryEntries","unmappedArchiveCount","consistency","historyCoverage","selectionVerified","sourceIndexPreserved"].includes(k)),"SOURCE_SUMMARY_INVALID");
  check(value.ok===true&&(value.sourceVersion===null||typeof value.sourceVersion==="string"&&/^[0-9]{4}\.[0-9]+\.[0-9]+(?:-[0-9]+)?$/.test(value.sourceVersion))
    &&(value.sessionFormat===null||natural(value.sessionFormat))&&["files","bytes","documents","memoryFiles","records","invalidRecords","missingParents","cycles","leafCandidates","sideControls","unsupportedMemoryEntries","unmappedArchiveCount"].every(k=>natural(value[k])),"SOURCE_SUMMARY_INVALID");
  check(value.consistency==="double-read-matched"&&value.historyCoverage==="current-session-only"&&value.selectionVerified===false&&value.sourceIndexPreserved===false,"SOURCE_SUMMARY_INVALID");
  const counts=value.recordTypes;check(object(counts)&&Object.keys(counts).length===types.length&&types.every(k=>natural(counts[k])),"SOURCE_SUMMARY_INVALID");
  check(Array.isArray(value.missingDocuments)&&value.missingDocuments.every(v=>typeof v==="string"&&core.includes(v)),"SOURCE_SUMMARY_INVALID");
  return structuredClone(value);
}
