import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationState } from '@kuinest/chat-client';

const storage = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };
globalThis.location = { search: '', href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' };
globalThis.document = { hidden: false, addEventListener() {} };
globalThis.window = { addEventListener() {} };
globalThis.localStorage = storage(); globalThis.sessionStorage = storage();
const { ChatStore } = await import('../js/chat/store.js');
const { Api, ApiFault } = await import('../js/chat/api.js');
const item = { id: 'synthetic-conversation', title: '原合成标题', updatedAt: '2026-10-28T00:00:00.000Z', revision: 0 };

function fixture(t, transport) {
 const store = new ChatStore(); store.api = new Api(transport);
 store.session = { ownerId: 'synthetic-owner', csrfToken: 'x'.repeat(43) };
 store.conversations = [{...item}]; store.current = item.id;
 store.states.set(item.id, new ConversationState(item.id));
 t.after(() => store.clearRuntime()); return store;
}

test('改名响应丢失后用只读回查确认，列表与当前会话引用同步', async t => {
 const calls=[];
 const store=fixture(t,async(url,options)=>{
  calls.push(options.method);
  if(options.method==='PATCH')throw new TypeError('合成响应丢失');
  return Response.json({...item,title:'改名后的标题'});
 });
 assert.equal(await store.renameConversation(item.id,'改名后的标题'),true);
 assert.equal(store.conversations[0].title,'改名后的标题');assert.deepEqual(calls,['PATCH','GET']);
 assert.equal(store.current,item.id);
});

test('删除未得到回执前不移除内容；成功后清除选中、草稿与旧状态',async t=>{
 let acknowledge;
 const store=fixture(t,async(_url,options)=>options.method==='DELETE'?await new Promise(resolve=>{acknowledge=resolve;}):Response.json({items:[],nextCursor:null}));
 store.drafts.set(item.id,'合成草稿');
 const deletion=store.deleteConversation(item.id);
 assert.equal(store.conversations.length,1);assert.equal(store.current,item.id);assert.equal(store.conversationBusy,true);
 acknowledge(new Response(null,{status:204}));
 assert.equal(await deletion,true);assert.equal(store.current,null);assert.equal(store.conversations.length,0);
 assert.equal(store.drafts.has(item.id),false);assert.equal(store.states.has(item.id),false);
});

test('删除响应丢失且回查404可确认，回查仍存在时保留会话并显示错误',async t=>{
 for(const gone of [true,false]){
  const store=fixture(t,async(url,options)=>{
   if(options.method==='DELETE')throw new TypeError('合成响应丢失');
   if(String(url).endsWith('/'+item.id))return gone?Response.json({error:{code:'NOT_FOUND'}},{status:404}):Response.json(item);
   return Response.json({items:[],nextCursor:null});
  });
  assert.equal(await store.deleteConversation(item.id),gone);
  assert.equal(store.conversations.length,gone?0:1);
  if(!gone)assert.match(store.error,/未能确认/);
 }
});

test('生成中或消息受理结果未知时不发送删除请求',async t=>{
 let requests=0;const store=fixture(t,async()=>{requests++;throw Error('不得调用');});
 store.runs.set('synthetic-run',{runId:'synthetic-run',conversationId:item.id,status:'running'});
 assert.equal(await store.deleteConversation(item.id),false);assert.equal(requests,0);
 store.runs.clear();store.pending[item.id]={phase:'unknown',input:{text:'合成未确认提交'}};
 assert.equal(await store.deleteConversation(item.id),false);assert.equal(requests,0);
});

test('其他页面删除当前会话后，轮询清除旧选择并刷新列表',async t=>{
 const store=fixture(t,async(url)=>String(url).endsWith('/'+item.id)?Response.json({error:{code:'NOT_FOUND'}},{status:404}):Response.json({items:[],nextCursor:null}));
 store.activeViews=1;store.api.chat.sync=async()=>{throw new ApiFault(404,'NOT_FOUND');};
 await store.poll();assert.equal(store.current,null);assert.equal(store.conversations.length,0);assert.match(store.notice,/其他页面删除/);
});

test('超长或空白名称不发请求，也不截断为另一个标题',async t=>{
 let requests=0;const store=fixture(t,async()=>{requests++;throw Error('不得调用');});
 for(const title of ['   ','x'.repeat(101),'名字\n下一行'])assert.equal(await store.renameConversation(item.id,title),false);
 assert.equal(requests,0);assert.equal(store.conversations[0].title,item.title);
});
