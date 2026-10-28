import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import rateLimit from "@fastify/rate-limit";
import { luckinMcp, luckinPreviewMcp, luckinOrdersMcp } from "@kuinest/contracts";
import type { AppConfig } from "../../config.js";
import type { McpAuthorization } from "../../mcp/authorization.js";
import type { LuckinReader } from "../../mcp/luckin-policy.js";

export type LuckinMcpOptions={authorization:McpAuthorization;reader?:LuckinReader;responseMode?:"json"|"sse";readerForRequest?:(header:string|undefined)=>Promise<LuckinReader>};
const rpcError=(code:number,message:string,id:unknown=null)=>({jsonrpc:"2.0",id:typeof id==="number"||typeof id==="string"?id:null,error:{code,message}});
export function registerLuckinMcp(app:FastifyInstance,config:AppConfig,options?:LuckinMcpOptions):void {
  registerLuckinRoute(app,config,options,false);
}
export function registerLuckinPreviewMcp(app:FastifyInstance,config:AppConfig,options?:LuckinMcpOptions):void {
  registerLuckinRoute(app,config,options,true);
}
export function registerLuckinOrdersMcp(app:FastifyInstance,config:AppConfig,options?:LuckinMcpOptions):void{registerLuckinRoute(app,config,options,false,true);}
function registerLuckinRoute(app:FastifyInstance,config:AppConfig,options:LuckinMcpOptions|undefined,preview:boolean,orders=false):void {
  if(!options) return;
  const profile=orders?luckinOrdersMcp:preview?luckinPreviewMcp:luckinMcp;
  app.register(async scope=>{
    const parseLuckinCall=orders?(await import("../../mcp/luckin-orders-policy.js")).parseLuckinOrdersCall:preview?(await import("../../mcp/luckin-preview-policy.js")).parseLuckinPreviewCall:(await import("../../mcp/luckin-policy.js")).parseLuckinCall;
    scope.addHook("onRequest",async(request,reply)=>{
      if(orders)request.raw.socket?.setTimeout?.(28000);
      if(request.headers.origin!==undefined&&request.headers.origin!==config.publicOrigin) return reply.code(403).send(rpcError(-32000,"Origin 不被允许。"));
      try {await options.authorization.authorize(request.headers.authorization);}
      catch {return reply.header("WWW-Authenticate",options.authorization.challenge).code(401).send(rpcError(-32000,orders?"瑞幸点单OAuth授权无效或已过期。":preview?"瑞幸预览OAuth授权无效或已过期。":"瑞幸只读OAuth授权无效或已过期。"));}
      if(Object.keys(request.query as object).length) return reply.code(400).send(rpcError(-32600,"MCP 入口不接受查询参数。"));
      if(request.method!=="POST") return reply.header("Allow","POST").code(405).send(rpcError(-32000,"本入口仅接受 POST。"));
    });
    await scope.register(rateLimit,{max:60,timeWindow:60000,keyGenerator:()=>orders?"luckin-orders-single-owner":preview?"luckin-preview-single-owner":"luckin-mcp-single-owner",
      errorResponseBuilder:()=>Object.assign(new Error("LUCKIN_RATE_LIMITED"),{statusCode:429})});
    scope.setErrorHandler((error,_request,reply)=>{
      const status=typeof error==="object"&&error!==null&&"statusCode" in error?error.statusCode:500;
      if(status===413) return reply.code(413).send(rpcError(-32000,"MCP 请求过大。"));
      if(status===415) return reply.code(415).send(rpcError(-32000,"需要 application/json。"));
      if(status===400) return reply.code(400).send(rpcError(-32700,"JSON 解析失败。"));
      if(status===429) return reply.code(429).send(rpcError(-32000,"请求过于频繁。"));
      return reply.code(500).send(rpcError(-32603,"瑞幸 MCP 暂不可用。"));
    });
    const createLuckinMcpServer=orders?(await import("../../mcp/luckin-orders.js")).createLuckinOrdersMcpServer:preview?(await import("../../mcp/luckin-preview.js")).createLuckinPreviewMcpServer:(await import("../../mcp/luckin.js")).createLuckinMcpServer;
    const {WebStandardStreamableHTTPServerTransport}=await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
    scope.route({method:["POST","GET","DELETE","PUT","PATCH","OPTIONS","HEAD"],url:profile.path,bodyLimit:8192,
      async handler(request,reply) {
        if(!options.reader&&!options.readerForRequest) return reply.code(503).send(rpcError(-32000,"瑞幸查询能力未就绪。"));
        if(Array.isArray(request.body)) return reply.code(400).send(rpcError(-32600,"不支持批量 JSON-RPC。"));
        const body=request.body as {method?:unknown;params?:unknown;id?:unknown}|null;
        if(body&&typeof body==="object"&&body.method==="tools/call") {
          try {
            const params=body.params as {name?:unknown;arguments?:unknown}|null;
            parseLuckinCall(params?.name,params?.arguments);
          }catch {return reply.code(200).send(rpcError(-32602,orders?"仅允许点单工具及其有效参数，创建操作只接受已确认intentId。":preview?"仅允许查询、规格选择和订单预览及其有效参数。":"仅允许三个瑞幸查询工具及其有效参数。",body.id));}
        }
        const abort=new AbortController();
        const reader=options.readerForRequest?await options.readerForRequest(request.headers.authorization):options.reader!;
        const server=createLuckinMcpServer({call:(name,args,signal)=>reader.call(name,args,signal?AbortSignal.any([abort.signal,signal]):abort.signal)},options.authorization.securitySchemes);
        const transport=new WebStandardStreamableHTTPServerTransport({enableJsonResponse:options.responseMode!=="sse"});
        let streamed=false,closed=false;
        const close=async()=>{
          if(closed)return;closed=true;abort.abort();request.raw.off("aborted",onAbort);reply.raw.off("close",onAbort);
          await server.close().catch(()=>{});
        };
        const onAbort=()=>{abort.abort();void close();};
        request.raw.once("aborted",onAbort);reply.raw.once("close",onAbort);
        try {
          await server.connect(transport);
          const headers=new Headers();
          for(const name of ["accept","content-type","mcp-protocol-version"]){
            const value=request.headers[name];if(typeof value==="string") headers.set(name,value);
          }
          const response=await transport.handleRequest(new Request(config.publicOrigin+profile.path,{method:"POST",headers,signal:abort.signal}),{parsedBody:request.body});
          reply.code(response.status);
          const type=response.headers.get("content-type");if(type)reply.header("Content-Type",type);
          if(type?.startsWith("text/event-stream")&&response.body) {
            streamed=true;
            reply.raw.once("finish",()=>{void close();});
            // 流完成或断开后再释放 SDK；Readable 桥接保留背压和取消行为。
            return reply.send(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>));
          }
          return reply.send(await response.text());
        }finally {if(!streamed)await close();}
      },
    });
  });
}
