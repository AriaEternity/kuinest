import { randomUUID } from "node:crypto";
import { check, hash, hex, id, json, object, read, uuid, write } from "./safe.js";
import { privatePath, runSource, secureNewOutput } from "./source-transport.js";
import type { SshOptions } from "./source-transport.js";
import { loadSource } from "./source-receive.js";
import { parse } from "./parse.js";
const textFields = ["modelProvider","model","providerOverride","modelOverride","modelOverrideSource","thinkingLevel","reasoningLevel","agentHarnessId"];
const numberFields = ["updatedAt","contextTokens","compactionCount"];
const reportText = ["source","provider","model"];
const reportNumbers = ["generatedAt","bootstrapMaxChars","bootstrapTotalMaxChars","systemPromptChars","toolCount","skillCount","workspaceFileCount","truncatedFileCount","missingFileCount"];
const problems = [...textFields,...numberFields,"liveModelSwitchPending","systemPromptReport",...reportText.map(k=>"report."+k),...reportNumbers.map(k=>"report."+k)];
const natural = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const scalar = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._:/-]{1,256}$/.test(v);
type Metadata = { format: string; sourceId: string; batchId: string; sessionId: string; sourceVersion: string | null; capturedAt: number;
  sourceIndexSha256: string; provenance: string; values: Record<string, unknown>; problems: string[]; runtimeConfigurationVerified: false };
export function metadata(value: unknown): Metadata {
  check(object(value) && Object.keys(value).every(k=>["format","sourceId","batchId","sessionId","sourceVersion","capturedAt","sourceIndexSha256","provenance","values","problems","runtimeConfigurationVerified"].includes(k)), "METADATA_INVALID");
  check(value.format === "kuinest-session-metadata-v1" && uuid(value.sourceId) && uuid(value.batchId) && id(value.sessionId)
    && (value.sourceVersion === null || typeof value.sourceVersion === "string" && /^[0-9]{4}\.[0-9]+\.[0-9]+(?:-[0-9]+)?$/.test(value.sourceVersion))
    && natural(value.capturedAt) && hex(value.sourceIndexSha256) && value.provenance === "selected-session-index"
    && value.runtimeConfigurationVerified === false, "METADATA_INVALID");
  const v=value.values;
  check(object(v) && Object.keys(v).every(k=>[...textFields,...numberFields,"liveModelSwitchPending","report"].includes(k)), "METADATA_INVALID");
  for(const [k,x] of Object.entries(v)){
    if(textFields.includes(k))check(scalar(x),"METADATA_INVALID");
    else if(numberFields.includes(k))check(natural(x),"METADATA_INVALID");
    else if(k==="liveModelSwitchPending")check(typeof x==="boolean","METADATA_INVALID");
    else {check(object(x) && Object.keys(x).every(k=>[...reportText,...reportNumbers].includes(k)),"METADATA_INVALID");
      for(const [key,val] of Object.entries(x))check(reportText.includes(key)?scalar(val):natural(val),"METADATA_INVALID");}
  }
  check(Array.isArray(value.problems) && value.problems.every(k=>typeof k==="string" && problems.includes(k)) && new Set(value.problems).size===value.problems.length,"METADATA_INVALID");
  return structuredClone(value) as Metadata;
}
export function metadataSummary(m: Metadata) {
  const v=m.values,r=object(v.report)?v.report:{};
  return {ok:true,format:"kuinest-session-metadata-summary-v1",sourceVersion:m.sourceVersion,
    presentFields:Object.keys(v).filter(k=>k!=="report"),reportFields:Object.keys(r),fieldProblems:m.problems,
    modelPairPresent:typeof v.model==="string" && typeof v.modelProvider==="string",
    reportModelMatchesSession:typeof r.model==="string" && typeof v.model==="string" ? r.model===v.model && r.provider===v.modelProvider : null,
    bootstrapLimitsPresent:typeof r.bootstrapMaxChars==="number" && typeof r.bootstrapTotalMaxChars==="number",
    pendingModelSwitch:v.liveModelSwitchPending ?? null,provenance:"selected-session-index",runtimeConfigurationVerified:false,applied:false};
}
export function receiveMetadata(bytes: Buffer, target: string, expected: {sourceId:string;batchId:string}) {
  check(bytes.length<=16384,"METADATA_LIMIT");const m=metadata(json(bytes));
  check(m.sourceId===expected.sourceId && m.batchId===expected.batchId,"SOURCE_BINDING_MISMATCH");
  write(target,"source-metadata.json",bytes);
  write(target,"metadata-receipt.json",Buffer.from(JSON.stringify({format:"kuinest-metadata-receipt-v1",sourceId:m.sourceId,batchId:m.batchId,sha256:hash(bytes)})));
  return {...metadataSummary(m),metadataSha256:hash(bytes)};
}
export function loadMetadata(directory: string) {
  const bytes=read(directory,"source-metadata.json",16384),receipt=json(read(directory,"metadata-receipt.json",2048));
  check(object(receipt) && Object.keys(receipt).length===4 && receipt.format==="kuinest-metadata-receipt-v1" && hex(receipt.sha256) && hash(bytes)===receipt.sha256,"METADATA_HASH_MISMATCH");
  const m=metadata(json(bytes));check(receipt.sourceId===m.sourceId && receipt.batchId===m.batchId,"SOURCE_BINDING_MISMATCH");
  return {metadata:m,sha256:hash(bytes)};
}
export function verifyMetadata(directory: string) { const {metadata:m,sha256}=loadMetadata(directory);return {...metadataSummary(m),metadataSha256:sha256}; }
export async function exportMetadata(options: SshOptions, output: string, sourceId: string) {
  check(uuid(sourceId),"SOURCE_IDENTITY");const target=privatePath(output),batchId=randomUUID();secureNewOutput(target);
  const bytes=await runSource(options,{mode:"private",sourceId,batchId},"metadata");
  return {...receiveMetadata(bytes,target,{sourceId,batchId}),privateAcl:"verified"};
}
export function compareMetadata(metadataDirectory: string, sourceDirectory: string) {
  return compareMetadataSnapshot(loadMetadata(metadataDirectory).metadata,loadSource(sourceDirectory));
}
export function compareMetadataSnapshot(m: Metadata,s: ReturnType<typeof loadSource>) {
  check(m.sourceId===s.receipt.sourceId,"SOURCE_BINDING_MISMATCH");
  const session=parse(s.files.get(s.receipt.files.find(f=>f.kind==="session")!.path)!);
  check(session.id===s.receipt.sessionId,"SOURCE_BINDING_MISMATCH");
  const last=session.entries.findLast(e=>e.type==="message" && object(e.message) && e.message.role==="assistant")?.message;
  const sameSession=m.sessionId===session.id;
  const reviewCodes: string[] = [];
  if(!sameSession)reviewCodes.push("SESSION_ROTATED_MAPPING_REQUIRED");
  if(m.sourceVersion!==s.receipt.sourceVersion)reviewCodes.push("SOURCE_VERSION_CHANGED");
  if(m.sourceIndexSha256!==s.receipt.sourceIndexSha256)reviewCodes.push("INDEX_CHANGED_SINCE_SOURCE");
  if(m.capturedAt<s.receipt.capturedAt)reviewCodes.push("METADATA_PREDATES_SOURCE");
  if(m.values.liveModelSwitchPending===true)reviewCodes.push("MODEL_SWITCH_PENDING");
  return {...metadataSummary(m),sameSession,sourceVersionMatches:m.sourceVersion===s.receipt.sourceVersion,indexHashMatchesSource:m.sourceIndexSha256===s.receipt.sourceIndexSha256,
    capturedAfterSource:m.capturedAt>=s.receipt.capturedAt,
    modelPairMatchesLastArchivedAssistant:sameSession && object(last) && typeof m.values.model==="string" && typeof m.values.modelProvider==="string" ? m.values.model===last.model && m.values.modelProvider===last.provider : null,
    reviewCodes,profileVerified:false};
}
