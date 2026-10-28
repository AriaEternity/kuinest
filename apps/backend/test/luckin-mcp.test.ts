import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {luckinMcp,luckinTools} from "@kuinest/contracts";
import {createApp} from "../dist/app.js";
import {foundationPorts,projectRoot} from "../dist/server.js";
import {loadConfig} from "../dist/config.js";
import {LuckinMcpClient} from "../dist/mcp/luckin-client.js";
import {parseLuckinCall,type LuckinReader} from "../dist/mcp/luckin-policy.js";
import {Writable} from "node:stream";

const credential="SYNTHETIC-UPSTREAM-CREDENTIAL-only-for-tests";
const access="synthetic-downstream-access";
const headers={authorization:"Bearer "+access,accept:"application/json, text/event-stream","content-type":"application/json","mcp-protocol-version":"2025-06-18"};
const forbidden=["createOrder","cancelOrder","previewOrder","switchProduct","queryOrderDetailInfo","unknown","__proto__","constructor"];
type MockOptions={sse?:boolean;status?:number;toolError?:boolean;businessError?:boolean;oversize?:boolean;leak?:boolean;protocol?:string;rpcError?:boolean;serverPing?:boolean;credential?:string;toolResult?:Record<string,unknown>};
function upstream(options:MockOptions={}) {
  const methods:string[]=[],versions:string[]=[],sessions:string[]=[];
  const transport:typeof fetch=async(url,init)=>{
    assert.equal(String(url),luckinMcp.endpoint);assert.equal(init?.redirect,"error");
    const h=new Headers(init?.headers);
    assert.equal(h.get("authorization"),"Bearer "+(options.credential??credential));
    if(init?.method==="GET") return new Response(null,{status:405});
    const body=JSON.parse(String(init?.body)) as {id?:number;method:string;params?:{name:string;arguments:unknown}};
    methods.push(body.method??"server-reply");
    if(body.method===undefined) return new Response(null,{status:202});
    if(body.method==="notifications/initialized") {
      versions.push(h.get("mcp-protocol-version")??"");sessions.push(h.get("mcp-session-id")??"");
      return new Response(null,{status:202});
    }
    if(options.status) return new Response("SYNTHETIC-PRIVATE-ERROR "+credential,{status:options.status});
    let result:unknown;
    if(body.method==="initialize") result={protocolVersion:options.protocol??"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"synthetic-official",version:"1"}};
    else {
      assert.equal(body.method,"tools/call");assert(luckinTools.some(tool=>tool.name===body.params?.name));
      versions.push(h.get("mcp-protocol-version")??"");sessions.push(h.get("mcp-session-id")??"");
      result=options.toolResult??{isError:options.toolError??false,content:[{type:"text",text:JSON.stringify({code:options.businessError?9:0,success:!options.businessError,data:{productId:7001,productName:"合成商品",...(options.leak?{token:credential,note:credential}:{})}})}],
        _meta:{token:credential},structuredContent:{productId:7001,...(options.leak?{secret:credential,note:credential}:{})}};
    }
    const text=JSON.stringify({jsonrpc:"2.0",id:body.id,...(options.rpcError?{error:{code:-32603,message:credential}}:{result}),...(options.oversize?{padding:"x".repeat(140*1024)}:{})});
    return new Response(options.sse?(options.serverPing?'data: {"jsonrpc":"2.0","id":"synthetic-server-ping","method":"ping"}\n\n':"")+"data: "+text+"\n\n":text,{headers:{"content-type":options.sse?"text/event-stream":"application/json","mcp-session-id":"synthetic-upstream-session"}});
  };
  return {transport,methods,versions,sessions};
}
function fixture(t:TestContext,enabled=true,ready=true,responseMode:"json"|"sse"="json",readerOverride?:LuckinReader) {
  let calls=0,logs="";
  const config=loadConfig({NODE_ENV:"test",APP_MODE:"private",DATA_ROOT:join(tmpdir(),"synthetic-luckin-no-storage"),PUBLIC_ORIGIN:"https://synthetic.example",CURSOR_HMAC_KEY:randomBytes(32).toString("base64")},projectRoot);
  const authorization={challenge:'Bearer resource_metadata="https://synthetic.example/.well-known/oauth-protected-resource/api/luckin/mcp"',securitySchemes:[{type:"oauth2" as const,scopes:[luckinMcp.scope]}],
    async authorize(header:string|undefined){if(header!=="Bearer "+access)throw new Error("invalid");}};
  const reader=readerOverride??{async call(){calls++;return {isError:false,content:[{type:"text" as const,text:'{"success":true,"data":{"synthetic":true}}'}]};}};
  const app=createApp(config,foundationPorts(),{logStream:new Writable({write(chunk,_enc,done){logs+=String(chunk);done();}}),
    ...(enabled?{luckinMcp:{authorization,responseMode,...(ready?{reader}:{})}}:{})});
  t.after(()=>app.close());
  const rpc=(method:string,params?:unknown,extra={})=>app.inject({method:"POST",url:luckinMcp.path,headers:{...headers,...extra},payload:{jsonrpc:"2.0",id:1,method,...(params===undefined?{}:{params})}});
  return {app,rpc,calls:()=>calls,logs:()=>logs};
}
test("瑞幸默认关闭，不注册入口",async t=>{
  const h=fixture(t,false);assert.equal((await h.rpc("tools/list")).statusCode,404);assert.equal(h.calls(),0);
});
test("初始化、通知、ping及固定三工具 JSON 发现",async t=>{
  const h=fixture(t);
  const initialized=await h.rpc("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"synthetic",version:"1"}});
  assert.equal(initialized.statusCode,200);assert.equal(initialized.json().result.protocolVersion,"2025-06-18");
  const notification=await h.app.inject({method:"POST",url:luckinMcp.path,headers,payload:{jsonrpc:"2.0",method:"notifications/initialized"}});
  assert.equal(notification.statusCode,202);assert.equal(notification.body,"");
  assert.equal((await h.rpc("ping")).statusCode,200);
  const result=(await h.rpc("tools/list")).json().result;
  assert.deepEqual(result.tools.map((x:{name:string})=>x.name),luckinTools.map(x=>x.name));
  assert(result.tools.every((x:{securitySchemes:unknown})=>JSON.stringify(x.securitySchemes).includes(luckinMcp.scope)));
  assert.equal(h.calls(),0);
});
test("所有非白名单工具在适配器调用前拒绝，包含原型名称",async t=>{
  const h=fixture(t);
  for(const name of forbidden) {
    const r=await h.rpc("tools/call",{name,arguments:{deptId:1}});
    assert.equal(r.json().error.code,-32602);
  }
  assert.equal(h.calls(),0);
});
test("参数范围、类型、未知字段及批量限制",async t=>{
  const h=fixture(t);
  const bad=[{longitude:181,latitude:0},{longitude:0,latitude:-91},{longitude:"1",latitude:0},{longitude:0,latitude:0,token:credential}];
  for(const args of bad)assert.equal((await h.rpc("tools/call",{name:"queryShopList",arguments:args})).json().error.code,-32602);
  for(const args of [{deptId:0,query:"a"},{deptId:1.1,query:"a"},{deptId:1,query:" "},{deptId:1,query:"a",endpoint:"https://evil.invalid"}])
    assert.equal((await h.rpc("tools/call",{name:"searchProductForMcp",arguments:args})).json().error.code,-32602);
  assert.throws(()=>parseLuckinCall("queryShopList",{longitude:Infinity,latitude:NaN}));
  assert.equal((await h.app.inject({method:"POST",url:luckinMcp.path,headers,payload:[{jsonrpc:"2.0",method:"tools/list",id:1}]})).statusCode,400);
  for(const method of ["resources/list","prompts/list"]) assert.equal((await h.rpc(method)).json().error.code,-32601);
  assert.equal(h.calls(),0);
});
test("三个有效查询均到达只读端口，返回禁止缓存",async t=>{
  const h=fixture(t);
  for(const [name,args] of [["queryShopList",{longitude:0,latitude:0}],["searchProductForMcp",{deptId:1,query:"合成"}],["queryProductDetailInfo",{deptId:1,productId:2}]] as const) {
    const r=await h.rpc("tools/call",{name,arguments:args});
    assert.equal(r.json().result.isError,false);assert.equal(r.headers["cache-control"],"no-store");
  }
  assert.equal(h.calls(),3);
});
test("鉴权、Origin、方法、协议版本、Accept、JSON及体积拒绝",async t=>{
  const h=fixture(t);
  const unauthorized=await h.rpc("tools/list",undefined,{authorization:"Bearer wrong"});
  assert.equal(unauthorized.statusCode,401);assert(String(unauthorized.headers["www-authenticate"]).includes("/api/luckin/mcp"));
  assert.equal((await h.rpc("tools/list",undefined,{origin:"https://evil.invalid"})).statusCode,403);
  for(const method of ["GET","DELETE","PUT"] as const)assert.equal((await h.app.inject({method,url:luckinMcp.path,headers})).statusCode,405);
  assert.equal((await h.rpc("ping",undefined,{"mcp-protocol-version":"unsupported"})).statusCode,400);
  assert.equal((await h.rpc("ping",undefined,{accept:"application/json"})).statusCode,406);
  assert.equal((await h.app.inject({method:"POST",url:luckinMcp.path,headers,payload:"{ invalid "+credential})).statusCode,400);
  assert.equal((await h.rpc("tools/list",{padding:"x".repeat(9000)})).statusCode,413);
  assert.equal(h.calls(),0);assert(!h.logs().includes(credential));assert(!h.logs().includes(access));
});
test("未装配瑞幸读取器只返回安全的 503",async t=>{
  const h=fixture(t,true,false);assert.equal((await h.rpc("tools/list")).statusCode,503);
});
test("下游 SSE 返回 MCP 帧并完成生命周期",async t=>{
  const h=fixture(t,true,true,"sse"),r=await h.rpc("tools/list");
  assert.equal(r.statusCode,200);assert(String(r.headers["content-type"]).startsWith("text/event-stream"));
  const line=r.body.split("\n").find(line=>line.startsWith("data:"));
  assert(line);assert.equal(JSON.parse(line.slice(5)).result.tools.length,3);
});
test("上游适配器再次拒绝全部危险工具，网络请求数为零",async()=>{
  const mock=upstream(),client=new LuckinMcpClient({token:credential,transport:mock.transport});
  for(const name of forbidden)await assert.rejects(client.call(name,{}));
  await assert.rejects(client.call("searchProductForMcp",{deptId:1,query:"a",Authorization:credential}));
  assert.equal(mock.methods.length,0);
});
for(const sse of [false,true])test("官方 SDK 上游初始化、202通知、会话和独立版本："+(sse?"SSE":"JSON"),async()=>{
  const mock=upstream({sse}),client=new LuckinMcpClient({token:credential,transport:mock.transport});
  const result=await client.call("searchProductForMcp",{deptId:700,query:"合成"});
  assert.equal(result.isError,false);assert.deepEqual(mock.methods,["initialize","notifications/initialized","tools/call"]);
  assert(mock.versions.every(x=>x==="2025-06-18"));assert(mock.sessions.every(x=>x==="synthetic-upstream-session"));
});
test("上游元数据及回显凭据不返回下游",async()=>{
  const mock=upstream({leak:true}),client=new LuckinMcpClient({token:credential,transport:mock.transport});
  const result=await client.call("queryProductDetailInfo",{deptId:700,productId:7001});
  assert.equal(result.isError,false);assert(!JSON.stringify(result).includes(credential));assert(!Object.hasOwn(result,"_meta"));
});
for(const status of [401,403,429,500,302])test("上游 HTTP "+status+" 只返回安全工具错误",async()=>{
  const mock=upstream({status}),client=new LuckinMcpClient({token:credential,transport:mock.transport});
  const result=await client.call("queryShopList",{longitude:0,latitude:0});
  assert.equal(result.isError,true);assert(!JSON.stringify(result).includes(credential));assert(!JSON.stringify(result).includes("SYNTHETIC-PRIVATE-ERROR"));
});
test("MCP 工具错误和业务错误都不报告查询成功",async()=>{
  for(const options of [{toolError:true},{businessError:true}]) {
    const mock=upstream(options),client=new LuckinMcpClient({token:credential,transport:mock.transport});
    assert.equal((await client.call("queryShopList",{longitude:0,latitude:0})).isError,true);
  }
});
test("超大响应被限制",async()=>{
  const mock=upstream({oversize:true}),client=new LuckinMcpClient({token:credential,transport:mock.transport});
  const result=await client.call("queryShopList",{longitude:0,latitude:0});
  assert.equal(result.isError,true);assert(JSON.stringify(result).includes("LUCKIN_RESPONSE_TOO_LARGE"));
});
test("总超时和调用方取消均结束请求",async()=>{
  const blocked:typeof fetch=async(_url,init)=>new Promise((_resolve,reject)=>{
    const abort=()=>reject(new Error("synthetic-abort"));
    if(init?.signal?.aborted)abort();else init?.signal?.addEventListener("abort",abort,{once:true});
  });
  const client=new LuckinMcpClient({token:credential,transport:blocked,timeoutMs:80});
  assert(JSON.stringify(await client.call("queryShopList",{longitude:0,latitude:0})).includes("LUCKIN_TIMEOUT"));
  const abort=new AbortController();abort.abort();
  assert.equal((await client.call("queryShopList",{longitude:0,latitude:0},abort.signal)).isError,true);
});

test("上游不支持的协议版本、JSON-RPC 错误及非法 JSON 均安全失败",async()=>{
  for(const options of [{protocol:"2099-01-01"},{rpcError:true}]) {
    const mock=upstream(options),client=new LuckinMcpClient({token:credential,transport:mock.transport});
    const result=await client.call("queryShopList",{longitude:0,latitude:0});
    assert.equal(result.isError,true);assert(!JSON.stringify(result).includes(credential));
  }
  const malformed:typeof fetch=async()=>new Response("{ invalid "+credential,{headers:{"content-type":"application/json"}});
  const client=new LuckinMcpClient({token:credential,transport:malformed});
  assert.equal((await client.call("queryShopList",{longitude:0,latitude:0})).isError,true);
});
test("上游并发限制不排队扩大资源占用",async()=>{
  const mock=upstream(),client=new LuckinMcpClient({token:credential,transport:mock.transport});
  const result=await Promise.all([1,2,3].map(()=>client.call("queryShopList",{longitude:0,latitude:0})));
  assert.equal(result.filter(r=>r.isError).length,1);
  assert(JSON.stringify(result[2]).includes("LUCKIN_BUSY"));
  assert.equal(mock.methods.filter(m=>m==="tools/call").length,2);
});

test("上游 SSE 中的协议 ping 可回应，仍不开放业务反向能力",async()=>{
  const mock=upstream({sse:true,serverPing:true}),client=new LuckinMcpClient({token:credential,transport:mock.transport});
  const result=await client.call("queryShopList",{longitude:0,latitude:0});
  assert.equal(result.isError,false);assert(mock.methods.includes("server-reply"));
  assert.equal(mock.methods.filter(m=>m==="tools/call").length,1);
});

// 独立检查响应中的键和值，并解开合法嵌套 JSON 文本；所有凭据均由测试构造。
function assertNoCredential(value:unknown,secret:string,depth=0):void {
  assert(depth<=30);
  if(typeof value==="string") {
    assert(!value.includes(secret));
    let decoded:unknown;
    try {decoded=JSON.parse(value);}catch{return;}
    if(typeof decoded==="string" || (decoded!==null && typeof decoded==="object")) assertNoCredential(decoded,secret,depth+1);
  } else if(Array.isArray(value)) value.forEach(item=>assertNoCredential(item,secret,depth+1));
  else if(value && typeof value==="object") for(const [key,item] of Object.entries(value)) {
    assert(!key.includes(secret));assertNoCredential(item,secret,depth+1);
  }
}
const nestedCatalog=(secret:string)=>({productId:7001,items:[{
  name:"合成商品 "+secret,["prefix-"+secret+"-suffix"]:"不可返回的键值",
  details:{[secret]:"不可返回的键值",note:secret,authorization:"Bearer "+secret,"[REDACTED]":"保留正常键"},
}],note:"Bearer "+secret});
const sanitizingCases:{name:string;secret?:string;result:(secret:string)=>Record<string,unknown>}[]=[
  {name:"structuredContent 的嵌套对象、数组和含凭据键",result:secret=>({isError:false,content:[],structuredContent:nestedCatalog(secret)})},
  {name:"文本 JSON 的嵌套对象、数组和含凭据键",result:secret=>({isError:false,content:[{type:"text",text:JSON.stringify(nestedCatalog(secret))}]})},
  {name:"文本 JSON 再包装的 JSON 字符串",result:secret=>({isError:false,content:[{type:"text",text:JSON.stringify({productId:7001,payload:JSON.stringify(nestedCatalog(secret))})}]})},
  {name:"structuredContent 中再包装的 JSON 字符串",result:secret=>({isError:false,content:[],structuredContent:{productId:7001,payload:JSON.stringify(nestedCatalog(secret))}})},
  {name:"JSON 字符串字面量与普通 Bearer 文本",result:secret=>({isError:false,content:[{type:"text",text:JSON.stringify("7001 "+secret)},{type:"text",text:"合成商品 Bearer "+secret}]})},
  {name:"含引号反斜线凭据的 JSON 转义",secret:'SYNTHETIC-"\\-CREDENTIAL',result:secret=>({isError:false,content:[{type:"text",text:JSON.stringify({productId:7001,payload:JSON.stringify(nestedCatalog(secret))})}],structuredContent:nestedCatalog(secret)})},
  {name:"合法文本 JSON 的 Unicode 转义凭据",result:secret=>({isError:false,content:[{type:"text",text:JSON.stringify(nestedCatalog(secret)).split(secret).join(Array.from(secret,c=>"\\u"+c.charCodeAt(0).toString(16).padStart(4,"0")).join(""))}]})},
];
for(const sse of [false,true])for(const sample of sanitizingCases)test("凭据清理："+sample.name+" / "+(sse?"SSE":"JSON"),async()=>{
  const secret=sample.secret??credential;
  const mock=upstream({sse,credential:secret,toolResult:{...sample.result(secret),_meta:{debug:secret}}});
  const client=new LuckinMcpClient({token:secret,transport:mock.transport});
  const result=await client.call("queryProductDetailInfo",{deptId:700,productId:7001});
  assert.equal(result.isError,false);assertNoCredential(result,secret);
  assert(JSON.stringify(result).includes("7001"));assert(!JSON.stringify(result).includes("不可返回的键值"));
  assert(!Object.hasOwn(result,"_meta"));
  assert.deepEqual(mock.methods,["initialize","notifications/initialized","tools/call"]);
});

for(const sse of [false,true]) {
  test("过多转义层无法安全判定则失败关闭 / "+(sse?"SSE":"JSON"),async()=>{
    let encoded=Array.from(credential,c=>"\\u"+c.charCodeAt(0).toString(16).padStart(4,"0")).join("");
    for(let i=0;i<40;i++)encoded=encoded.split("\\").join("\\u005c");
    const text="合成过度转义 "+encoded,mock=upstream({sse,toolResult:{isError:false,content:[{type:"text",text}]}});
    const result=await new LuckinMcpClient({token:credential,transport:mock.transport}).call("queryShopList",{longitude:0,latitude:0});
    assert.equal(result.isError,true);assertNoCredential(result,credential);
    assert.equal(JSON.parse(result.content[0]!.text).code,"LUCKIN_RESULT_INVALID");
    assert(!result.content.some(block=>block.text===text));
  });
  for(const kind of ["不完整 JSON 的转义凭据","普通文本的 Unicode 转义凭据"] as const)test(kind+"失败关闭 / "+(sse?"SSE":"JSON"),async()=>{
    const secret=kind.startsWith("不完整")?'SYNTHETIC-"\\-CREDENTIAL':credential;
    const text=kind.startsWith("不完整")?'{"note":'+JSON.stringify(secret)+',':"合成调试值 "+Array.from(secret,c=>"\\u"+c.charCodeAt(0).toString(16).padStart(4,"0")).join("");
    const mock=upstream({sse,credential:secret,toolResult:{isError:false,content:[{type:"text",text}]}});
    const result=await new LuckinMcpClient({token:secret,transport:mock.transport}).call("queryShopList",{longitude:0,latitude:0});
    assert.equal(result.isError,true);assertNoCredential(result,secret);
    assert.equal(JSON.parse(result.content[0]!.text).code,"LUCKIN_RESULT_INVALID");
    assert(!JSON.stringify(result).includes("合成调试值"));
    assert(!result.content.some(block=>block.text===text));
  });
  test("替换标记与凭据相同则失败关闭 / "+(sse?"SSE":"JSON"),async()=>{
    const secret="[REDACTED]",mock=upstream({sse,credential:secret,toolResult:{isError:false,content:[{type:"text",text:"不能保留的响应 "+secret}]}});
    const result=await new LuckinMcpClient({token:secret,transport:mock.transport}).call("queryShopList",{longitude:0,latitude:0});
    assert.equal(result.isError,true);assertNoCredential(result,secret);
    assert.equal(JSON.parse(result.content[0]!.text).code,"LUCKIN_RESULT_INVALID");
    assert(!JSON.stringify(result).includes("不能保留的响应"));
  });
  test("超深嵌套响应失败关闭 / "+(sse?"SSE":"JSON"),async()=>{
    let nested:unknown={note:credential};for(let i=0;i<24;i++)nested={child:[nested]};
    const mock=upstream({sse,toolResult:{isError:false,content:[],structuredContent:{productId:7001,nested}}});
    const result=await new LuckinMcpClient({token:credential,transport:mock.transport}).call("queryShopList",{longitude:0,latitude:0});
    assert.equal(result.isError,true);assertNoCredential(result,credential);
    assert(!JSON.stringify(result).includes("7001"));
  });
  test("脱敏展开后超出结果限额失败关闭 / "+(sse?"SSE":"JSON"),async()=>{
    const secret="ZX",mock=upstream({sse,credential:secret,toolResult:{isError:false,content:[{type:"text",text:secret.repeat(20000)}]}});
    const result=await new LuckinMcpClient({token:secret,transport:mock.transport}).call("queryShopList",{longitude:0,latitude:0});
    assert.equal(result.isError,true);assertNoCredential(result,secret);
    assert.equal(JSON.parse(result.content[0]!.text).code,"LUCKIN_RESPONSE_TOO_LARGE");
  });
  test("最终 HTTP 工具响应及日志不含上游凭据 / "+(sse?"SSE":"JSON"),async t=>{
    const mock=upstream({sse,toolResult:{isError:false,content:[{type:"text",text:JSON.stringify(nestedCatalog(credential))}],structuredContent:nestedCatalog(credential)}});
    const reader=new LuckinMcpClient({token:credential,transport:mock.transport});
    const h=fixture(t,true,true,sse?"sse":"json",reader);
    const response=await h.rpc("tools/call",{name:"searchProductForMcp",arguments:{deptId:700,query:"合成"}});
    assert.equal(response.statusCode,200);
    const packet=sse?JSON.parse(response.body.split("\n").find(line=>line.startsWith("data:"))!.slice(5)):response.json();
    assert.equal(packet.result.isError,false);assertNoCredential(packet,credential);
    assert(!h.logs().includes(credential));assert(!h.logs().includes(access));
    const calls=mock.methods.length;
    for(const name of forbidden)assert.equal((await h.rpc("tools/call",{name,arguments:{}})).json().error.code,-32602);
    assert.equal(mock.methods.length,calls);
  });
}
