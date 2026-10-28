import test from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeekProvider,requestBody} from '../dist/providers/deepseek.js';
import {ProtocolAccumulator} from '../dist/providers/protocol.js';

const profile={mode:'private',endpoint:'https://api.deepseek.com/chat/completions',allowedOrigin:'https://api.deepseek.com',model:'deepseek-flash',wireFormat:'deepseek',maxTokens:8192,thinking:'enabled',reasoning_effort:'high',imageInput:false,allowLive:true};
const request={system:'纯合成系统说明',messages:[{role:'user',content:'纯合成输入'}],tools:[],options:{mode:'private'}};
const response=frames=>new Response(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});

test('DeepSeek Flash使用官方字段、原输出预算和明确的默认思考策略',()=>{
 const body=requestBody(request,profile);
 assert.equal(body.model,'deepseek-flash');assert.equal(body.max_tokens,8192);
 assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.reasoning_effort,'high');
 assert.deepEqual(body.stream_options,{include_usage:true});assert.equal(body.max_completion_tokens,undefined);
});

test('官方终帧role=null可完成正文、usage与DONE归档',async()=>{
 let calls=0;
 const transport=async(url,init)=>{
  calls++;assert.equal(url,profile.endpoint);assert.equal(init.redirect,'error');
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-not-a-real-key');
  return response([
   {id:'synthetic-stream',choices:[{index:0,delta:{role:'assistant',reasoning_content:'合成推理'},finish_reason:null}]},
   {id:'synthetic-stream',choices:[{index:0,delta:{content:'合成答案'},finish_reason:null}]},
   {id:'synthetic-stream',choices:[{index:0,delta:{role:null,content:''},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:8,total_tokens:18}},
  ]);
 };
 const accumulator=new ProtocolAccumulator();
 for await(const event of new DeepSeekProvider(profile,()=> 'synthetic-not-a-real-key',transport).stream(request,new AbortController().signal))accumulator.add(event);
 const archive=accumulator.close();assert.equal(archive.assistant.content,'合成答案');
 assert.equal(archive.assistant.reasoning_content,'合成推理');assert.equal(archive.finish_reason,'stop');assert.equal(archive.usage.outputTokens,8);assert.equal(calls,1);
});

test('非法角色、缺少finish或缺少DONE仍明确失败且不重试',async()=>{
 for(const scenario of ['wrong-role','missing-finish','missing-done']){
  let calls=0;
  const frames=[{choices:[{index:0,delta:{role:scenario==='wrong-role'?'user':null,content:'合成片段'},finish_reason:scenario==='missing-finish'?null:'stop'}]}];
  const transport=async()=>{calls++;return scenario==='missing-done'?new Response('data: '+JSON.stringify(frames[0])+'\n\n',{headers:{'content-type':'text/event-stream'}}):response(frames);};
  await assert.rejects(async()=>{for await(const event of new DeepSeekProvider(profile,()=> 'synthetic-only',transport).stream(request,new AbortController().signal)){}},error=>error.code==='UPSTREAM_INCOMPLETE');
  assert.equal(calls,1);
 }
});

test('思考工具链不补造缺失的历史reasoning',()=>{
 const withTools={...request,tools:[{type:'function',function:{name:'synthetic_tool',parameters:{type:'object'}}}],messages:[{role:'assistant',content:'历史合成答复'},{role:'user',content:'下一轮'}]};
 assert.throws(()=>requestBody(withTools,profile),error=>error.code==='PROTOCOL_HISTORY_INCOMPLETE');
 const complete={...withTools,messages:[{...withTools.messages[0],reasoning_content:'原样合成推理'},withTools.messages[1]]};
 assert.equal(requestBody(complete,profile).messages[1].reasoning_content,'原样合成推理');
});
