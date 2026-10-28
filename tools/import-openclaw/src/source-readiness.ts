import { loadSource } from "./source-receive.js";
import { loadMetadata, compareMetadataSnapshot } from "./source-metadata.js";
import { parse, chain } from "./parse.js";
import { check, object } from "./safe.js";
import { excludeInterrupted } from "./interrupted.js";
import { defaults } from "../../../apps/backend/dist/context/profile.js";
import type { RawEntry } from "./types.js";

// 诊断只计算闭集类别；不会输出正文、原ID、模型/工具名、图片或任意源字段。
export function protocolReadiness(entries: RawEntry[], target: Record<string, unknown>) {
  const reasoning = { replayAssistants:0, missing:0, missingWithTools:0, sameRecordedPair:0, differentRecordedPair:0, unknownRecordedPair:0,
    missingSameRecordedPair:0, missingDifferentRecordedPair:0, missingUnknownRecordedPair:0, apiUnverified:true };
  const images = { messages:0, blocks:0, user:0, tool:0, assistant:0, otherRole:0, png:0, jpeg:0, gif:0, webp:0, otherMime:0,
    invalidBase64:0, signatureMismatch:0, unsupportedFields:0, decodedBytes:0, largestBytes:0, mixedWithText:0, multipleInMessage:0, structurallySupported:0, decoderVerified:false };
  for(const e of entries){
    if(e.type!=="message" || !object(e.message))continue;
    const m=e.message, blocks=Array.isArray(m.content)?m.content.filter(object):[];
    if(m.role==="assistant" && !excludeInterrupted(m)){
      reasoning.replayAssistants++;
      const pair=typeof m.model==="string" && typeof m.provider==="string" && typeof target.model==="string" && typeof target.modelProvider==="string"
        ? m.model===target.model && m.provider===target.modelProvider ? "same" : "different" : "unknown";
      const hasReasoning=typeof m.reasoning_content==="string" && m.reasoning_content.length>0 || blocks.some(b=>b.type==="thinking" && typeof b.thinking==="string" && b.thinking.length>0);
      const tools=Array.isArray(m.tool_calls) && m.tool_calls.length>0 || blocks.some(b=>b.type==="toolCall");
      if(pair==="same")reasoning.sameRecordedPair++;else if(pair==="different")reasoning.differentRecordedPair++;else reasoning.unknownRecordedPair++;
      if(!hasReasoning){reasoning.missing++;if(tools)reasoning.missingWithTools++;
        if(pair==="same")reasoning.missingSameRecordedPair++;else if(pair==="different")reasoning.missingDifferentRecordedPair++;else reasoning.missingUnknownRecordedPair++;}
    }
    const picture=blocks.filter(b=>b.type==="image");if(!picture.length)continue;
    images.messages++;if(picture.length>1)images.multipleInMessage++;if(blocks.some(b=>b.type==="text"))images.mixedWithText++;
    for(const b of picture){
      images.blocks++;
      if(m.role==="user")images.user++;else if(m.role==="toolResult" || m.role==="tool")images.tool++;else if(m.role==="assistant")images.assistant++;else images.otherRole++;
      const mime=b.mimeType,allowed=["image/png","image/jpeg","image/gif","image/webp"].includes(String(mime));
      if(mime==="image/png")images.png++;else if(mime==="image/jpeg")images.jpeg++;else if(mime==="image/gif")images.gif++;else if(mime==="image/webp")images.webp++;else images.otherMime++;
      const fields=Object.keys(b).every(k=>["type","mimeType","data"].includes(k));if(!fields)images.unsupportedFields++;
      const data=b.data;
      if(typeof data!=="string" || !data.length || data.length>16*1024*1024 || data.length%4!==0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)){
        images.invalidBase64++;continue;
      }
      const bytes=Buffer.from(data,"base64");
      if(bytes.toString("base64")!==data){images.invalidBase64++;continue;}
      images.decodedBytes+=bytes.length;images.largestBytes=Math.max(images.largestBytes,bytes.length);
      const signature=mime==="image/png"?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
        mime==="image/jpeg"?bytes.length>=3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255:
        mime==="image/gif"?["GIF87a","GIF89a"].includes(bytes.subarray(0,6).toString("ascii")):
        mime==="image/webp"?bytes.subarray(0,4).toString("ascii")==="RIFF" && bytes.subarray(8,12).toString("ascii")==="WEBP":false;
      if(allowed && !signature)images.signatureMismatch++;
      if(allowed && signature && fields && (m.role==="user" || m.role==="toolResult" || m.role==="tool"))images.structurallySupported++;
    }
  }
  return {reasoning,images};
}
export function reviewReadiness(metadataDirectory:string,sourceDirectory:string){
  const {metadata:m}=loadMetadata(metadataDirectory),source=loadSource(sourceDirectory),binding=compareMetadataSnapshot(m,source);
  // 两个已验批次必须同源、同会话、同版本；索引不同只作为时点差异，不假造冻结。
  check(binding.sameSession && binding.sourceVersionMatches,"READINESS_BINDING_MISMATCH");
  check(m.sourceId===source.receipt.sourceId && m.sessionId===source.receipt.sessionId && m.sourceVersion===source.receipt.sourceVersion,"READINESS_BINDING_MISMATCH");
  const s=parse(source.files.get(source.receipt.files.find(f=>f.kind==="session")!.path)!);
  check(s.id===source.receipt.sessionId,"SOURCE_BINDING_MISMATCH");
  const parents=new Set(s.entries.map(e=>e.parentId)),leaves=s.entries.filter(e=>!parents.has(e.id));
  const selected=leaves.length===1?chain(s,leaves[0]!.id):null;
  const last=selected?.findLast(e=>e.type==="compaction"),keep=last?selected!.findIndex(e=>e.id===last.firstKeptEntryId):0;
  const r=object(m.values.report)?m.values.report:{};
  return {ok:true,format:"kuinest-source-readiness-v1",binding,
    archive:protocolReadiness(s.entries,m.values),candidate:selected && keep>=0?protocolReadiness(selected.slice(keep),m.values):null,
    bootstrap:{fileBudgetMatchesCurrentDefault:typeof r.bootstrapMaxChars==="number"?r.bootstrapMaxChars===defaults.fileChars:null,
      totalBudgetMatchesCurrentDefault:typeof r.bootstrapTotalMaxChars==="number"?r.bootstrapTotalMaxChars===defaults.totalChars:null,
      windowMatchesCurrentDefault:typeof m.values.contextTokens==="number"?m.values.contextTokens===defaults.windowTokens:null,
      reportedTruncation:typeof r.truncatedFileCount==="number"?r.truncatedFileCount>0:null,
      reportedMissingFiles:typeof r.missingFileCount==="number"?r.missingFileCount>0:null,compilerEquivalent:false},
    reviewCodes:["EFFECTIVE_PROFILE_REQUIRED","IMAGE_RUNTIME_AND_PUBLIC_CONTRACT_REQUIRED","CROSS_MODEL_REPLAY_POLICY_REQUIRED","BEHAVIOR_ACCEPTANCE_REQUIRED"],
    readyForApply:false,applied:false,userAcceptance:"pending"};
}
