// 独立预备命令：真实执行前须取得openclaw.json单文件只读投影授权。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sourceProgram, runProgram, privatePath, secureNewOutput } from "./dist/source-transport.js";
import { check, json, object, uuid, id, hex, hash, write, safeFailure } from "./dist/safe.js";
export function configurationProgram(request){
  const base=sourceProgram(request,"metadata").split("\nawait sourceMain(")[0];
  const projector=readFileSync(new URL("./config-projection.mjs",import.meta.url),"utf8");
  return base+'\nconst projector=await import('+JSON.stringify("data:text/javascript;base64,"+Buffer.from(projector).toString("base64"))+');\n'+
    'try{const request='+JSON.stringify(request)+';const root=requestRoot(request),indexPath=path.join(root,"agents","main","sessions","sessions.json"),configPath=path.join(root,"openclaw.json");'+
    'const indexBytes=read(indexPath,16*1024*1024),configBytes=read(configPath,4*1024*1024),index=parsed(indexBytes);'+
    'need(object(index)&&object(index[KEY])&&identifier(index[KEY].sessionId),"WEB_SESSION_INVALID");const selected=index[KEY];'+
    'const projection=projector.projectLegacyConfiguration(parsed(configBytes),selected);'+
    'need(digest(read(indexPath,16*1024*1024))===digest(indexBytes)&&digest(read(configPath,4*1024*1024))===digest(configBytes),"SOURCE_CHANGED");'+
    'process.stdout.write(JSON.stringify({format:"kuinest-config-review-v1",sourceId:request.sourceId,batchId:request.batchId,sessionId:selected.sessionId,sourceVersion:version(request.mode),capturedAt:Date.now(),sourceIndexSha256:digest(indexBytes),sourceConfigSha256:digest(configBytes),projection})+"\\n");'+
    '}catch(e){process.stderr.write(JSON.stringify({ok:false,code:e instanceof SourceError?e.code:"SOURCE_READ_FAILED"})+"\\n");process.exitCode=1;}';
}
const closed=(v,keys)=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
export function validateConfigurationReview(bytes,request){
  check(bytes.length<=16384,"CONFIG_REVIEW_LIMIT");const v=json(bytes);
  check(closed(v,["format","sourceId","batchId","sessionId","sourceVersion","capturedAt","sourceIndexSha256","sourceConfigSha256","projection"])&&
    v.format==="kuinest-config-review-v1"&&uuid(v.sourceId)&&uuid(v.batchId)&&v.sourceId===request.sourceId&&v.batchId===request.batchId&&id(v.sessionId)&&
    v.sourceVersion==="2026.7.1-2"&&Number.isSafeInteger(v.capturedAt)&&v.capturedAt>0&&hex(v.sourceIndexSha256)&&hex(v.sourceConfigSha256),"CONFIG_REVIEW_INVALID");
  const p=v.projection;
  check(closed(p,["format","declared","compat","parameterLayers","behavior","compaction","contextPruning","reset","heartbeat","memorySearchConfigured","agentSpecificBehaviorPresent","dynamicConfigurationPresent","issues","configurationResolved","effectiveRuntimeVerified","credentialsPreserved"])&&
    p.format==="kuinest-declared-config-projection-v1"&&p.configurationResolved===false&&p.effectiveRuntimeVerified===false&&p.credentialsPreserved===false,"CONFIG_REVIEW_INVALID");
  const fields={
    declared:["provider","model","api","reasoning","contextWindow","contextTokens","maxTokens","input","baseUrl"],
    compat:["supportsDeveloperRole","supportsReasoningEffort","requiresToolResultName","requiresAssistantAfterToolResult","requiresThinkingAsText","requiresReasoningContentOnAssistantMessages","supportsTools","requiresStringContent","strictMessageKeys","thinkingFormat","maxTokensField"],
    behavior:["bootstrapMaxChars","bootstrapTotalMaxChars","contextTokens","imageMaxDimensionPx","thinkingDefault","reasoningDefault","imageQuality","contextInjection","userTimezone"],
    compaction:["truncateAfterCompaction","notifyUser","mode","identifierPolicy","reserveTokens","keepRecentTokens","reserveTokensFloor","recentTurnsPreserve","maxHistoryShare","customInstructionsPresent","memoryFlush"],
    contextPruning:["mode"],reset:["mode","atHour","idleMinutes"],heartbeat:["lightContext","isolatedSession","skipWhenBusy","customPromptPresent","every"]
  };
  for(const [key,names] of Object.entries(fields))check(closed(p[key],names),"CONFIG_REVIEW_INVALID");
  const paramNames=["temperature","topP","top_p","maxTokens","max_tokens","max_completion_tokens","reasoning_effort","reasoningEffort","thinking"];
  check(closed(p.parameterLayers,["provider","model","agentDefaults","defaultsModel","mainAgent"])&&Object.keys(p.parameterLayers).length===5,"CONFIG_REVIEW_INVALID");
  for(const val of Object.values(p.parameterLayers)){check(closed(val,paramNames),"CONFIG_REVIEW_INVALID");if(val.thinking!==undefined)check(closed(val.thinking,["type","clear_thinking"]),"CONFIG_REVIEW_INVALID");}
  check(closed(p.compaction.memoryFlush,["enabled","softThresholdTokens","customPromptPresent"]),"CONFIG_REVIEW_INVALID");
  const issueCodes=["MODEL_DECLARATION_MISSING_OR_AMBIGUOUS","MAIN_AGENT_AMBIGUOUS","DECLARED_FIELD_UNSUPPORTED","PARAMETERS_REQUIRE_REVIEW","INPUT_CAPABILITY_UNVERIFIED","ENDPOINT_REQUIRES_REVIEW","COMPATIBILITY_FIELDS_REQUIRE_REVIEW","INCLUDED_CONFIGURATION_NOT_RESOLVED"];
  check(Array.isArray(p.issues)&&p.issues.every(c=>issueCodes.includes(c))&&new Set(p.issues).size===p.issues.length,"CONFIG_REVIEW_INVALID");
  const enums={
    api:["openai-completions","openai-responses","anthropic-messages"],
    thinkingFormat:["openai","openrouter","deepseek","together","qwen","qwen-chat-template","zai"],
    maxTokensField:["max_tokens","max_completion_tokens"],thinkingDefault:["off","minimal","low","medium","high","xhigh","adaptive","max","ultra"],
    reasoningDefault:["off","on","stream"],imageQuality:["auto","efficient","balanced","high"],contextInjection:["always","continuation-skip","never"],
    type:["enabled","disabled"],mode:["off","cache-ttl","daily","idle","default","safeguard"],identifierPolicy:["strict","off","custom"],
    reasoning_effort:["none","minimal","low","medium","high","xhigh","max","ultra"],reasoningEffort:["none","minimal","low","medium","high","xhigh","max","ultra"]
  };
  const booleans=["reasoning","supportsDeveloperRole","supportsReasoningEffort","requiresToolResultName","requiresAssistantAfterToolResult","requiresThinkingAsText","requiresReasoningContentOnAssistantMessages","supportsTools","requiresStringContent","strictMessageKeys","clear_thinking","truncateAfterCompaction","notifyUser","customInstructionsPresent","enabled","customPromptPresent","lightContext","isolatedSession","skipWhenBusy","memorySearchConfigured","agentSpecificBehaviorPresent","dynamicConfigurationPresent","configurationResolved","effectiveRuntimeVerified","credentialsPreserved"];
  const numbers=["contextWindow","contextTokens","maxTokens","max_tokens","max_completion_tokens","temperature","topP","top_p","bootstrapMaxChars","bootstrapTotalMaxChars","imageMaxDimensionPx","reserveTokens","keepRecentTokens","reserveTokensFloor","recentTurnsPreserve","maxHistoryShare","softThresholdTokens","atHour","idleMinutes"];
  check(typeof p.declared.provider==="string" && typeof p.declared.model==="string","CONFIG_REVIEW_INVALID");
  const containers=["projection","declared","compat","parameterLayers","provider","model","agentDefaults","defaultsModel","mainAgent","thinking","behavior","compaction","memoryFlush","contextPruning","reset","heartbeat"];
  const leaf=(key,x)=>{
    if(object(x)){check(containers.includes(key),"CONFIG_REVIEW_INVALID");Object.entries(x).forEach(([k,v])=>leaf(k,v));return;}
    if(key==="input"){check(Array.isArray(x)&&x.length<=4&&x.every(v=>["text","image","video","audio"].includes(v)),"CONFIG_REVIEW_INVALID");return;}
    if(key==="issues")return;
    if(booleans.includes(key)){check(typeof x==="boolean","CONFIG_REVIEW_INVALID");return;}
    if(numbers.includes(key)){check(typeof x==="number"&&Number.isFinite(x)&&x>=0&&x<=10000000,"CONFIG_REVIEW_INVALID");return;}
    if(key==="provider"||key==="model"){check(typeof x==="string"&&/^[A-Za-z0-9._:/-]{1,256}$/.test(x),"CONFIG_REVIEW_INVALID");return;}
    if(key==="baseUrl"){
      let ok=false;try{const u=new URL(x);ok=typeof x==="string"&&x.length<=2048&&u.protocol==="https:"&&!u.username&&!u.password&&!u.search&&!u.hash&&["/","/v1","/v1/","/v1/chat/completions","/chat/completions","/openai/v1","/openai/v1/"].includes(u.pathname);}catch{}
      check(ok,"CONFIG_REVIEW_INVALID");return;
    }
    if(key==="every"){check(typeof x==="string"&&x.length<=20&&/^\d+(?:\.\d+)?[smhd]$/.test(x),"CONFIG_REVIEW_INVALID");return;}
    if(key==="userTimezone"){let ok=false;try{if(typeof x==="string"&&x.length<=80){new Intl.DateTimeFormat("en",{timeZone:x}).format(0);ok=true;}}catch{}check(ok,"CONFIG_REVIEW_INVALID");return;}
    if(key==="format"){check(x==="kuinest-declared-config-projection-v1","CONFIG_REVIEW_INVALID");return;}
    check(enums[key]?.includes(x),"CONFIG_REVIEW_INVALID");
  };
  leaf("projection",p);return v;
}
export async function captureConfiguration(options,output,sourceId){
  check(uuid(sourceId),"SOURCE_IDENTITY");const target=privatePath(output),request={mode:"private",sourceId,batchId:randomUUID()};
  secureNewOutput(target);
  const bytes=await runProgram(options,configurationProgram(request)),v=validateConfigurationReview(bytes,request);
  write(target,"source-profile.json",bytes);write(target,"profile-receipt.json",Buffer.from(JSON.stringify({format:"kuinest-config-review-receipt-v1",sourceId,batchId:request.batchId,sha256:hash(bytes)})));
  return {ok:true,format:"kuinest-config-review-summary-v1",privateAcl:"verified",issues:v.projection.issues,configurationResolved:false,effectiveRuntimeVerified:false,credentialsPreserved:false,applied:false};
}
// 只接受明确的配置投影操作；导入此模块用于合成测试时不执行。
if(process.argv[1] && resolve(fileURLToPath(import.meta.url))===resolve(process.argv[1])){
  try{
    const values=new Map(process.argv.slice(2).map(a=>{const at=a.indexOf("=");check(at>2&&a.startsWith("--"),"ARGUMENT_INVALID");return [a.slice(2,at),a.slice(at+1)];}));
    const keys=["host","identity","output","source-id","config-scope"];check(values.size===5&&process.argv.length===7&&keys.every(k=>values.get(k))&&values.get("config-scope")==="selected-model-config","ARGUMENT_INVALID");
    process.stdout.write(JSON.stringify(await captureConfiguration({host:values.get("host"),identity:values.get("identity")},values.get("output"),values.get("source-id")))+"\n");
  }catch(e){process.stderr.write(JSON.stringify(safeFailure(e))+"\n");process.exitCode=1;}
}
