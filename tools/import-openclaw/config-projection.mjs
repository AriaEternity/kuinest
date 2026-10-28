// 纯白名单投影，无文件/网络/环境读取；真实配置采集必须先获得对应文件的新增授权。
// 不解析SecretInput，不访问apiKey、headers、env、渠道、账户、凭据引用或任务正文。
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const empty=()=>Object.create(null);
const rec=v=>object(v)?v:empty();
const scalar=v=>typeof v==="string"&&/^[A-Za-z0-9._:/-]{1,256}$/.test(v);
export function projectLegacyConfiguration(config,selected){
  if(!object(config)||!object(selected)||!scalar(selected.modelProvider)||!scalar(selected.model))throw Error("CONFIG_PROJECTION_INVALID");
  const issues=new Set(),provider=rec(rec(rec(config.models).providers)[selected.modelProvider]);
  const definitions=Array.isArray(provider.models)?provider.models.filter(m=>object(m)&&m.id===selected.model):[];
  if(definitions.length!==1)issues.add("MODEL_DECLARATION_MISSING_OR_AMBIGUOUS");
  const model=definitions.length===1?definitions[0]:empty(),agents=rec(config.agents),defaults=rec(agents.defaults);
  const mains=Array.isArray(agents.list)?agents.list.filter(a=>object(a)&&a.id==="main"):[];
  if(mains.length>1)issues.add("MAIN_AGENT_AMBIGUOUS");
  const main=mains.length===1?mains[0]:empty(),ref=selected.modelProvider+"/"+selected.model;
  const enumField=(from,to,key,allowed)=>{if(Object.hasOwn(from,key)){if(allowed.includes(from[key]))to[key]=from[key];else issues.add("DECLARED_FIELD_UNSUPPORTED");}};
  const numberField=(from,to,key,min,max)=>{if(Object.hasOwn(from,key)){const n=from[key];if(typeof n==="number"&&Number.isFinite(n)&&n>=min&&n<=max)to[key]=n;else issues.add("DECLARED_FIELD_UNSUPPORTED");}};
  const boolField=(from,to,key)=>{if(Object.hasOwn(from,key)){if(typeof from[key]==="boolean")to[key]=from[key];else issues.add("DECLARED_FIELD_UNSUPPORTED");}};
  const bools=(from,keys)=>{const r={};for(const k of keys)boolField(from,r,k);return r;};
  const params=value=>{
    const v=rec(value),r={};
    for(const k of ["temperature","topP","top_p"])numberField(v,r,k,0,k==="temperature"?2:1);
    for(const k of ["maxTokens","max_tokens","max_completion_tokens"])numberField(v,r,k,1,1000000);
    enumField(v,r,"reasoning_effort",["none","minimal","low","medium","high","xhigh","max","ultra"]);
    enumField(v,r,"reasoningEffort",["none","minimal","low","medium","high","xhigh","max","ultra"]);
    if(Object.hasOwn(v,"thinking")){const t=rec(v.thinking),p={};enumField(t,p,"type",["enabled","disabled"]);boolField(t,p,"clear_thinking");r.thinking=p;
      if(!object(v.thinking)||Object.keys(t).some(k=>!["type","clear_thinking"].includes(k)))issues.add("PARAMETERS_REQUIRE_REVIEW");}
    if(Object.keys(v).some(k=>!["temperature","topP","top_p","maxTokens","max_tokens","max_completion_tokens","reasoning_effort","reasoningEffort","thinking"].includes(k)))issues.add("PARAMETERS_REQUIRE_REVIEW");
    return r;
  };
  const declared={provider:selected.modelProvider,model:selected.model};
  enumField(provider,declared,"api",["openai-completions","openai-responses","anthropic-messages"]);
  if(Object.hasOwn(model,"api"))enumField(model,declared,"api",["openai-completions","openai-responses","anthropic-messages"]);
  boolField(model,declared,"reasoning");
  for(const k of ["contextWindow","contextTokens","maxTokens"]){numberField(provider,declared,k,1,10000000);numberField(model,declared,k,1,10000000);}
  if(Array.isArray(model.input)&&model.input.length<=4&&model.input.every(v=>["text","image","video","audio"].includes(v)))declared.input=[...new Set(model.input)];
  else issues.add("INPUT_CAPABILITY_UNVERIFIED");
  const base=Object.hasOwn(model,"baseUrl")?model.baseUrl:provider.baseUrl;
  try{
    if(typeof base!=="string"||base.length>2048||base.includes("${"))throw Error();
    const u=new URL(base);
    if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash)throw Error();
    if(!["/","/v1","/v1/","/v1/chat/completions","/chat/completions","/openai/v1","/openai/v1/"].includes(u.pathname))throw Error();
    declared.baseUrl=u.href;
  }catch{issues.add("ENDPOINT_REQUIRES_REVIEW");}
  const compat=bools(rec(model.compat),["supportsDeveloperRole","supportsReasoningEffort","requiresToolResultName","requiresAssistantAfterToolResult",
    "requiresThinkingAsText","requiresReasoningContentOnAssistantMessages","supportsTools","requiresStringContent","strictMessageKeys"]);
  enumField(rec(model.compat),compat,"thinkingFormat",["openai","openrouter","deepseek","together","qwen","qwen-chat-template","zai"]);
  enumField(rec(model.compat),compat,"maxTokensField",["max_tokens","max_completion_tokens"]);
  if(object(model.compat)&&Object.keys(model.compat).some(k=>!["supportsDeveloperRole","supportsReasoningEffort","requiresToolResultName","requiresAssistantAfterToolResult","requiresThinkingAsText","requiresReasoningContentOnAssistantMessages","supportsTools","requiresStringContent","strictMessageKeys","thinkingFormat","maxTokensField"].includes(k)))issues.add("COMPATIBILITY_FIELDS_REQUIRE_REVIEW");
  const behavior={};
  for(const k of ["bootstrapMaxChars","bootstrapTotalMaxChars","contextTokens","imageMaxDimensionPx"])numberField(defaults,behavior,k,1,10000000);
  enumField(defaults,behavior,"thinkingDefault",["off","minimal","low","medium","high","xhigh","adaptive","max","ultra"]);
  enumField(defaults,behavior,"reasoningDefault",["off","on","stream"]);
  enumField(defaults,behavior,"imageQuality",["auto","efficient","balanced","high"]);
  enumField(defaults,behavior,"contextInjection",["always","continuation-skip","never"]);
  if(Object.hasOwn(defaults,"userTimezone")){
    try{if(typeof defaults.userTimezone!=="string"||defaults.userTimezone.length>80)throw Error();new Intl.DateTimeFormat("en",{timeZone:defaults.userTimezone}).format(0);behavior.userTimezone=defaults.userTimezone;}
    catch{issues.add("DECLARED_FIELD_UNSUPPORTED");}
  }
  const c=rec(defaults.compaction),compaction=bools(c,["truncateAfterCompaction","notifyUser"]);
  enumField(c,compaction,"mode",["default","safeguard"]);enumField(c,compaction,"identifierPolicy",["strict","off","custom"]);
  for(const k of ["reserveTokens","keepRecentTokens","reserveTokensFloor","recentTurnsPreserve"])numberField(c,compaction,k,0,10000000);
  numberField(c,compaction,"maxHistoryShare",0.1,0.9);
  compaction.customInstructionsPresent=Object.hasOwn(c,"customInstructions")||Object.hasOwn(c,"identifierInstructions");
  const flush=rec(c.memoryFlush);compaction.memoryFlush=bools(flush,["enabled"]);
  numberField(flush,compaction.memoryFlush,"softThresholdTokens",0,10000000);
  compaction.memoryFlush.customPromptPresent=Object.hasOwn(flush,"prompt")||Object.hasOwn(flush,"systemPrompt");
  const contextPruning={};enumField(rec(defaults.contextPruning),contextPruning,"mode",["off","cache-ttl"]);
  const reset={};enumField(rec(rec(config.session).reset),reset,"mode",["daily","idle"]);
  numberField(rec(rec(config.session).reset),reset,"atHour",0,23);numberField(rec(rec(config.session).reset),reset,"idleMinutes",1,10000000);
  const heartbeat=bools(rec(defaults.heartbeat),["lightContext","isolatedSession","skipWhenBusy"]);
  heartbeat.customPromptPresent=Object.hasOwn(rec(defaults.heartbeat),"prompt");
  const every=rec(defaults.heartbeat).every;if(every!==undefined){if(typeof every==="string"&&/^\d+(?:\.\d+)?[smhd]$/.test(every)&&every.length<=20)heartbeat.every=every;else issues.add("DECLARED_FIELD_UNSUPPORTED");}
  const dynamicConfigurationPresent=[config,config.models,provider,model,agents,defaults,main].some(v=>object(v)&&Object.hasOwn(v,"$include"));
  if(dynamicConfigurationPresent)issues.add("INCLUDED_CONFIGURATION_NOT_RESOLVED");
  return {format:"kuinest-declared-config-projection-v1",declared,compat,parameterLayers:{
    provider:params(provider.params),model:params(model.params),agentDefaults:params(defaults.params),
    defaultsModel:params(rec(rec(defaults.models)[ref]).params),mainAgent:params(main.params)},
    behavior,compaction,contextPruning,reset,heartbeat,memorySearchConfigured:object(defaults.memorySearch)||object(main.memorySearch),
    agentSpecificBehaviorPresent:["heartbeat","memorySearch","tools"].some(k=>Object.hasOwn(main,k)),
    dynamicConfigurationPresent,issues:[...issues].sort(),configurationResolved:false,effectiveRuntimeVerified:false,credentialsPreserved:false};
}
