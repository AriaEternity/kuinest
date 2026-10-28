import test from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeekProvider, requestBody, validateProfile} from '../dist/providers/deepseek.js';
import {profile as checkProfile} from '../dist/context/profile.js';
const mimo={mode:'private',endpoint:'https://api.xiaomimimo.com/v1/chat/completions',allowedOrigin:'https://api.xiaomimimo.com',model:'mimo-v2.6-flash',maxTokens:32768,thinking:'provider-default',wireFormat:'mimo',allowLive:true};
const request={system:'Synthetic system',messages:[{role:'user',content:'Synthetic input'}],tools:[],options:{mode:'private',provider:'deepseek',model:mimo.model,maxTokens:128,thinking:'provider-default'}};
test('MiMo uses documented output cap and omits DeepSeek-specific parameters',()=>{
 const b=requestBody(request,mimo);assert.equal(b.max_completion_tokens,128);assert.equal(b.model,mimo.model);assert.equal(b.stream,true);
 for(const key of ['max_tokens','reasoning_effort','thinking','stream_options'])assert.equal(Object.hasOwn(b,key),false,key);
 assert.equal(requestBody({...request,options:{...request.options,purpose:'compaction',maxTokens:32768}},mimo).max_completion_tokens,8192);
});
test('MiMo retains full prior reasoning and tool history without injecting missing reasoning',()=>{
 const messages=[{role:'user',content:'Synthetic input'},{role:'assistant',content:'Synthetic answer',reasoning_content:'Synthetic reason'},{role:'user',content:'Synthetic next'}];
 const b=requestBody({...request,messages},mimo);assert.equal(b.messages[2].reasoning_content,'Synthetic reason');
 assert.equal(messages[1].reasoning_content,'Synthetic reason');
});
test('MiMo consumes null deltas, separate usage and final DONE through existing stream parser',async()=>{
 let calls=0;
 const transport=async(url,init)=>{calls++;assert.equal(url,mimo.endpoint);assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-only');
  const b=JSON.parse(init.body);assert.equal(b.max_completion_tokens,128);
  const frames=[{choices:[{index:0,delta:{role:'assistant',content:'',reasoning_content:null,tool_calls:null},finish_reason:null}]},{choices:[{index:0,delta:{reasoning_content:'Synthetic reasoning'},finish_reason:null}]},{choices:[{index:0,delta:{content:'Synthetic answer'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}];
  return new Response(frames.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
 const events=[];for await(const event of new DeepSeekProvider(mimo,()=> 'synthetic-only',transport).stream(request,new AbortController().signal))events.push(event);
 assert.deepEqual(events.map(e=>e.type),['text_delta','reasoning_delta','text_delta','usage','finish']);assert.equal(events.at(-1).reason,'stop');assert.equal(calls,1);
});
test('DeepSeek wire defaults remain unchanged',()=>{
 const p={...mimo,wireFormat:undefined,thinking:'enabled',reasoning_effort:'high'};
 const b=requestBody({...request,options:{mode:'private'}},p);assert.equal(b.max_tokens,32768);assert.equal(b.max_completion_tokens,undefined);assert.deepEqual(b.thinking,{type:'enabled'});assert.equal(b.reasoning_effort,'high');assert.deepEqual(b.stream_options,{include_usage:true});
});
test('MiMo profile rejects ambiguous format, unsupported effort and origin mismatch',()=>{
 const stored={id:'synthetic-mimo',provider:'deepseek',model:mimo.model,endpoint:mimo.endpoint,status:'unverified',options:{allowedOrigin:mimo.allowedOrigin,wireFormat:'mimo',thinking:'provider-default',maxTokens:32768}};
 assert.equal(checkProfile(stored).options.wireFormat,'mimo');
 for(const options of [{wireFormat:'unknown'},{thinking:'enabled'},{reasoning_effort:'high'}])assert.throws(()=>checkProfile({...stored,options:{...stored.options,...options}}));
 assert.throws(()=>validateProfile({...mimo,allowedOrigin:'https://invalid.example'}));
});

// MiMo官方流式样例：首帧assistant，后续delta.role=null（不是非法角色）。
test('MiMo official null-role continuation reaches visible text, usage and complete finish',async()=>{
 const frames=[{choices:[{index:0,delta:{role:'assistant',content:'',reasoning_content:null,tool_calls:null},finish_reason:null}]},{choices:[{index:0,delta:{role:null,content:null,reasoning_content:'Synthetic reasoning',tool_calls:null},finish_reason:null}]},{choices:[{index:0,delta:{role:null,content:'Synthetic answer',reasoning_content:null,tool_calls:null},finish_reason:null}]},{choices:[{index:0,delta:{role:null,content:null,reasoning_content:null,tool_calls:null},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:10,completion_tokens:6,total_tokens:16}}];
 const transport=async()=>new Response(frames.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 const {ProtocolAccumulator}=await import('../dist/providers/protocol.js');const acc=new ProtocolAccumulator();
 for await(const e of new DeepSeekProvider(mimo,()=> 'synthetic-only',transport).stream(request,new AbortController().signal))acc.add(e);
 const result=acc.close();assert.equal(result.assistant.content,'Synthetic answer');assert.equal(result.finish_reason,'stop');assert.equal(result.usage.outputTokens,6);
});
test('MiMo still rejects concrete unexpected roles and truncated streams',async()=>{
 for(const [role,done] of [['user',true],[null,false]]){
  const transport=async()=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role,content:'Synthetic'},finish_reason:null}]})+'\n\n'+(done?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}});
  await assert.rejects(async()=>{for await(const e of new DeepSeekProvider(mimo,()=> 'synthetic-only',transport).stream(request,new AbortController().signal)){}},e=>e.code==='UPSTREAM_INCOMPLETE');
 }
});
