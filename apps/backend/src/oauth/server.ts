import express from "express";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { InvalidScopeError, InvalidTargetError, InvalidRequestError, TooManyRequestsError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpAuthorization } from "../mcp/authorization.js";
import { luckinMcp, luckinPreviewMcp, luckinOrdersMcp, mcdMcp, kuisenseMcp } from "@kuinest/contracts";
import { OAuthStore } from "./store.js";
import { consentPage } from "./page.js";

export const oauthScope = "kuisense:context:read";
export const oauthClientId = "kuinest-chatgpt";
const base = "/api/kuisense/oauth";
export interface OwnerSession { ownerId: string; csrfToken: string }
export type SessionInspector = (cookie: string) => Promise<OwnerSession | undefined>;
type Pending = { client: string; name: string; params: AuthorizationParams; expires: number };
const random = () => randomBytes(32).toString("base64url");

// 唯一信任的是既有聊天认证端点；不转发口令，不读取聊天库/凭据。
export function ownerSessionInspector(): SessionInspector {
  return async cookie => {
    if (!cookie || Buffer.byteLength(cookie) > 4096) return undefined;
    const response = await fetch("http://127.0.0.1:4317/api/v1/auth/session", {
      headers: { cookie, connection: "close" }, redirect: "error", signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) { await response.arrayBuffer(); return undefined; }
    const session = await response.json() as Partial<OwnerSession>;
    if (typeof session.ownerId !== "string" || typeof session.csrfToken !== "string") return undefined;
    return { ownerId: session.ownerId, csrfToken: session.csrfToken };
  };
}

export function createKuiSenseOAuth(options: { root: string; publicOrigin: string; inspectSession: SessionInspector; now?: () => number; luckinOwnerId?: string; luckinPreviewOwnerId?:string; luckinOrdersOwnerId?:string; mcdOwnerId?:string }) {
  const now = options.now ?? Date.now;
  const origin = new URL(options.publicOrigin).origin;
  if (origin !== options.publicOrigin || !origin.startsWith("https://")) throw new Error("OAUTH_ORIGIN_INVALID");
  const resource = origin + kuisenseMcp.path, issuer = origin;
  const metadataPath = "/.well-known/oauth-protected-resource" + kuisenseMcp.path;
  const luckinResource = origin + luckinMcp.path;
  if (options.luckinOwnerId !== undefined && (!options.luckinOwnerId.trim() || options.luckinOwnerId.length > 128)) throw new Error("OAUTH_POLICY_INVALID");
  const luckinEnabled = options.luckinOwnerId !== undefined;
  const previewEnabled=options.luckinPreviewOwnerId!==undefined;
  if(previewEnabled&&(!luckinEnabled||options.luckinPreviewOwnerId!==options.luckinOwnerId))throw new Error("OAUTH_POLICY_INVALID");
  const previewResource=origin+luckinPreviewMcp.path;
  const ordersEnabled=options.luckinOrdersOwnerId!==undefined;
  if(ordersEnabled&&(!luckinEnabled||options.luckinOrdersOwnerId!==options.luckinOwnerId))throw new Error("OAUTH_POLICY_INVALID");
  const ordersResource=origin+luckinOrdersMcp.path;
  const mcdEnabled=options.mcdOwnerId!==undefined, mcdResource=origin+mcdMcp.path;
  if(mcdEnabled&&(!options.mcdOwnerId?.trim()||options.mcdOwnerId.length>128))throw new Error("OAUTH_POLICY_INVALID");
  const extraPolicies=[...(mcdEnabled?[{resource:mcdResource,scope:mcdMcp.scope,client:mcdMcp.clientId,owner:options.mcdOwnerId!}]:[]),...(luckinEnabled?[{resource:luckinResource,scope:luckinMcp.scope,client:luckinMcp.clientId,owner:options.luckinOwnerId!}]:[]),...(previewEnabled?[{resource:previewResource,scope:luckinPreviewMcp.scope,client:luckinPreviewMcp.clientId,owner:options.luckinPreviewOwnerId!}]:[]),...(ordersEnabled?[{resource:ordersResource,scope:luckinOrdersMcp.scope,client:luckinOrdersMcp.clientId,owner:options.luckinOrdersOwnerId!}]:[])];
  const store = new OAuthStore(options.root, resource, oauthScope, now,extraPolicies);
  const clients = new Map<string, OAuthClientInformationFull>([
    [oauthClientId, { client_id: oauthClientId, client_name: "ChatGPT · 葵栖私人插件", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: oauthScope }],
    ["kuinest-deployment-check", { client_id: "kuinest-deployment-check", client_name: "葵栖部署连通检查", redirect_uris: [origin+base+"/verify/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: oauthScope }],
  ]);
  if (luckinEnabled) clients.set(luckinMcp.clientId,{client_id:luckinMcp.clientId,client_name:"ChatGPT · 瑞幸只读查询",redirect_uris:["https://chatgpt.com/connector_platform_oauth_redirect"],token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"],scope:luckinMcp.scope});
  if(previewEnabled)clients.set(luckinPreviewMcp.clientId,{client_id:luckinPreviewMcp.clientId,client_name:"ChatGPT · 瑞幸选品与预览",redirect_uris:["https://chatgpt.com/connector_platform_oauth_redirect"],token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"],scope:luckinPreviewMcp.scope});
  if(ordersEnabled)clients.set(luckinOrdersMcp.clientId,{client_id:luckinOrdersMcp.clientId,client_name:"ChatGPT · 瑞幸点单（逐笔确认）",redirect_uris:["https://chatgpt.com/connector_platform_oauth_redirect"],token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"],scope:luckinOrdersMcp.scope});
  const isOrders=(client:string)=>ordersEnabled&&client===luckinOrdersMcp.clientId;
  const isLuckin = (client: string) => luckinEnabled && client === luckinMcp.clientId;
  if(mcdEnabled)clients.set(mcdMcp.clientId,{client_id:mcdMcp.clientId,client_name:"ChatGPT · 麦当劳点单（逐笔确认）",redirect_uris:["https://chatgpt.com/connector_platform_oauth_redirect"],token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"],scope:mcdMcp.scope});
  const isMcd=(client:string)=>mcdEnabled&&client===mcdMcp.clientId;
  const isPreview=(client:string)=>previewEnabled&&client===luckinPreviewMcp.clientId;
  const pending = new Map<string, Pending>();
  const checks = new Map<string, { verifier: string; expires: number }>();
  const redirectUrl = (entry: Pending, response: { code: string } | { error: string }) => {
    const url = new URL(entry.params.redirectUri);
    Object.entries(response).forEach(([key,value]) => url.searchParams.set(key,value));
    if (entry.params.state !== undefined) url.searchParams.set("state",entry.params.state);
    url.searchParams.set("iss",issuer); return url.href;
  };
  const provider: OAuthServerProvider = {
    clientsStore: { getClient: id => clients.get(id) },
    async authorize(client, params, response) {
      const target = isMcd(client.client_id)?mcdResource:isOrders(client.client_id)?ordersResource:isPreview(client.client_id)?previewResource:isLuckin(client.client_id) ? luckinResource : resource;
      const requiredScope = isMcd(client.client_id)?mcdMcp.scope:isOrders(client.client_id)?luckinOrdersMcp.scope:isPreview(client.client_id)?luckinPreviewMcp.scope:isLuckin(client.client_id) ? luckinMcp.scope : oauthScope;
      if (params.resource?.href !== target) throw new InvalidTargetError(isMcd(client.client_id)?"只允许独立麦当劳点单资源。":isOrders(client.client_id)?"只允许独立瑞幸点单资源。":isPreview(client.client_id)?"只允许瑞幸选品与预览资源。":isLuckin(client.client_id) ? "只允许瑞幸只读MCP资源。" : "只允许葵栖只读MCP资源。");
      if (params.scopes?.length && (params.scopes.length !== 1 || params.scopes[0] !== requiredScope)) throw new InvalidScopeError(isMcd(client.client_id)?"只允许麦当劳点单权限，逐笔提交仍需本人批准。":isOrders(client.client_id)?"只允许独立点单权限，逐笔创建仍需本人确认。":isPreview(client.client_id)?"只允许选品、规格选择和订单预览，不能下单。":isLuckin(client.client_id) ? "只允许查询瑞幸门店和商品。" : "只允许读取最新上下文。");
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 1024) throw new InvalidRequestError("授权参数无效。");
      for (const [key,value] of pending) if (value.expires <= now()) pending.delete(key);
      if (pending.size >= 100) throw new TooManyRequestsError("待确认连接过多，请稍后再试。");
      const key = random();
      pending.set(key, { client: client.client_id, name: client.client_name ?? "葵栖连接", params, expires: now()+600000 });
      response.redirect(303,origin+base+"/consent?request="+key);
    },
    async challengeForAuthorizationCode(client, code) { return store.code(client.client_id,code).challenge; },
    async exchangeAuthorizationCode(client, code, _verifier, redirect, target) { return store.exchange(client.client_id,code,redirect,target); },
    async exchangeRefreshToken(client, token, scopes, target) { return store.refresh(client.client_id,token,scopes,target); },
    async verifyAccessToken(token) { return store.verifyAny(token); },
    async revokeToken(client, request) { store.revoke(client.client_id,request.token); },
  };
  const authorization: McpAuthorization = {
    challenge: `Bearer resource_metadata="${origin+metadataPath}", scope="${oauthScope}"`,
    securitySchemes: [{ type: "oauth2", scopes: [oauthScope] }],
    async authorize(header) { store.verify(header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1] ?? ""); },
  };
  const luckinAuthorization: McpAuthorization | undefined = luckinEnabled ? {
    challenge: 'Bearer resource_metadata="' + origin + "/.well-known/oauth-protected-resource" + luckinMcp.path + '", scope="' + luckinMcp.scope + '"',
    securitySchemes: [{type:"oauth2",scopes:[luckinMcp.scope]}],
    async authorize(header) { store.verify(header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1] ?? "",luckinResource); },
  } : undefined;
  const luckinPreviewAuthorization:McpAuthorization|undefined=previewEnabled?{
    challenge:`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${luckinPreviewMcp.path}", scope="${luckinPreviewMcp.scope}"`,
    securitySchemes:[{type:"oauth2",scopes:[luckinPreviewMcp.scope]}],
    async authorize(header){store.verify(header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1]??"",previewResource);},
  }:undefined;
  const luckinOrdersAuthorization=ordersEnabled?{
    challenge:`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${luckinOrdersMcp.path}", scope="${luckinOrdersMcp.scope}"`,
    securitySchemes:[{type:"oauth2" as const,scopes:[luckinOrdersMcp.scope]}],
    async authorize(header:string|undefined){store.verify(header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1]??"",ordersResource);},
    async identify(header:string|undefined){return store.binding(header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1]??"",ordersResource);},
    active:(binding:{ownerId:string;clientId:string;grantId:string;resource:string})=>store.grantActive(binding),
  }:undefined;
  const mcdAuthorization=mcdEnabled?{
    challenge: `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${mcdMcp.path}", scope="${mcdMcp.scope}"`,
    securitySchemes:[{type:"oauth2" as const,scopes:[mcdMcp.scope]}],
    async authorize(header:string|undefined){store.verify(header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1]??"",mcdResource);},
    async identify(header:string|undefined){return store.binding(header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1]??"",mcdResource);},
    active:(binding:{ownerId:string;clientId:string;grantId:string;resource:string})=>store.grantActive(binding),
  }:undefined;
  const oauth = express(); oauth.disable("x-powered-by"); oauth.set("trust proxy","loopback");
  oauth.use((_req,res,next) => {
    res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","no-referrer");res.setHeader("X-Content-Type-Options","nosniff");
    // SDK的授权错误重定向同样携带iss，满足已声明的RFC9207回调识别。
    const original = res.redirect.bind(res);
    res.redirect = ((status: number | string, location?: string) => {
      const value = typeof status === "string" ? status : location!;
      const url = new URL(value,origin);
      if ([...clients.values()].some(client => client.redirect_uris.some(uri => { const known = new URL(uri); return known.origin===url.origin && known.pathname===url.pathname; }))) url.searchParams.set("iss",issuer);
      return original(typeof status === "number" ? status : 302,url.href);
    }) as typeof res.redirect;
    next();
  });
  oauth.use(express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 16 }));
  oauth.use(base+"/token",(req,res,next) => {
    if (req.method === "POST" && req.body?.grant_type === "authorization_code" && !/^[A-Za-z0-9._~-]{43,128}$/.test(req.body?.code_verifier ?? "")) { res.status(400).json({ error: "invalid_grant" }); return; }
    next();
  });
  oauth.use(base+"/authorize",authorizationHandler({ provider }));
  oauth.use(base+"/token",tokenHandler({ provider }));
  oauth.use(base+"/revoke",revocationHandler({ provider }));
  oauth.use((_req,res) => { res.status(404).json({ error: "invalid_request" }); });
  oauth.use(((error: { status?: number },_req: unknown,res: express.Response,_next: unknown) => { res.status(error.status===413?413:400).json({ error: "invalid_request" }); }) as express.ErrorRequestHandler);

  function register(app: FastifyInstance) {
    app.register(async scope => {
      await scope.register(rateLimit,{max:60,timeWindow:60000});
      scope.addHook("onSend",async (_req,reply) => { reply.header("Referrer-Policy","no-referrer"); });
      scope.get("/.well-known/oauth-authorization-server",async () => ({
        issuer, authorization_endpoint: origin+base+"/authorize", token_endpoint: origin+base+"/token", revocation_endpoint: origin+base+"/revoke",
        response_types_supported: ["code"], grant_types_supported: ["authorization_code","refresh_token"],
        token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"], scopes_supported: [oauthScope,...(luckinEnabled?[luckinMcp.scope]:[]),...(previewEnabled?[luckinPreviewMcp.scope]:[]),...(ordersEnabled?[luckinOrdersMcp.scope]:[]),...(mcdEnabled?[mcdMcp.scope]:[])], authorization_response_iss_parameter_supported: true,
      }));
      const metadata = { resource, authorization_servers: [issuer], scopes_supported: [oauthScope], bearer_methods_supported: ["header"], resource_name: "葵栖 · KuiSense 只读上下文" };
      scope.get(metadataPath,async () => metadata);
      if (luckinEnabled) scope.get("/.well-known/oauth-protected-resource"+luckinMcp.path,async () => ({...metadata,resource:luckinResource,scopes_supported:[luckinMcp.scope],resource_name:"葵栖 · 瑞幸只读查询"}));
      if(previewEnabled)scope.get("/.well-known/oauth-protected-resource"+luckinPreviewMcp.path,async()=>({...metadata,resource:previewResource,scopes_supported:[luckinPreviewMcp.scope],resource_name:"葵栖 · 瑞幸选品与订单预览（不下单）"}));
      if(ordersEnabled)scope.get("/.well-known/oauth-protected-resource"+luckinOrdersMcp.path,async()=>({...metadata,resource:ordersResource,scopes_supported:[luckinOrdersMcp.scope],resource_name:"葵栖 · 瑞幸点单（本人逐笔确认）"}));
      if(mcdEnabled)scope.get("/.well-known/oauth-protected-resource"+mcdMcp.path,async()=>({...metadata,resource:mcdResource,scopes_supported:[mcdMcp.scope],resource_name:"葵栖 · 麦当劳点单（本人逐笔确认）"}));
      scope.get("/.well-known/oauth-protected-resource",async () => metadata);
      for (const path of ["/authorize","/token","/revoke"]) scope.route({
        method: ["GET","POST","OPTIONS","HEAD"], url: base+path,
        async onRequest(request,reply) {
          reply.hijack();
          await new Promise<void>(resolve => {
            reply.raw.once("finish",resolve);reply.raw.once("close",resolve);
            oauth(request.raw,reply.raw);
          });
        },
        async handler() {},
      });
      scope.get<{ Querystring: { request?: string } }>(base+"/consent",async (request,reply) => {
        const entry = pending.get(request.query.request ?? "");
        if (!entry || entry.expires <= now()) return reply.code(400).send({ error: "authorization_expired" });
        const nonce = random();
        reply.header("Content-Security-Policy",`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
        return reply.type("text/html; charset=utf-8").send(consentPage(request.query.request!,entry.name,nonce,isLuckin(entry.client),isPreview(entry.client),isOrders(entry.client),isMcd(entry.client)));
      });
      const authenticateOwner = async (request: { headers: Record<string, unknown> }): Promise<OwnerSession | undefined> => {
        if (request.headers.origin !== origin) return undefined;
        const cookie = typeof request.headers.cookie === "string" ? request.headers.cookie : "";
        const session = await options.inspectSession(cookie);
        const supplied = request.headers["x-csrf-token"];
        if (!session || typeof supplied !== "string" || supplied.length>256) return undefined;
        const actual = Buffer.from(supplied),expected = Buffer.from(session.csrfToken);
        return actual.length===expected.length && timingSafeEqual(actual,expected) ? session : undefined;
      };
      scope.post<{ Body: { request?: string; decision?: string } }>(base+"/consent",{ bodyLimit:8192 },async (request,reply) => {
        const owner = await authenticateOwner(request);
        if (!owner) return reply.code(403).send({ error: "access_denied" });
        const key = request.body?.request ?? "",entry = pending.get(key);
        if (!entry || entry.expires <= now() || !["allow","deny"].includes(request.body?.decision ?? "")) return reply.code(400).send({ error:"invalid_request" });
        if ((isLuckin(entry.client)||isPreview(entry.client)||isOrders(entry.client)) && owner.ownerId !== options.luckinOwnerId) return reply.code(403).send({error:"access_denied"});
        if(isMcd(entry.client)&&owner.ownerId!==options.mcdOwnerId)return reply.code(403).send({error:"access_denied"});
        pending.delete(key);
        const response = request.body.decision==="deny" ? { error:"access_denied" } : { code:store.issueCode({ client:entry.client,challenge:entry.params.codeChallenge,redirect:entry.params.redirectUri,resource:entry.params.resource!.href,owner:owner.ownerId }) };
        return { redirectUrl:redirectUrl(entry,response) };
      });
      scope.post(base+"/revoke-all",{ bodyLimit:8192 },async (request,reply) => {
        const owner = await authenticateOwner(request);
        if (!owner) return reply.code(403).send({ error:"access_denied" });
        store.revokeAll(owner.ownerId);return { status:"revoked" };
      });
      if (luckinEnabled) scope.post(base+"/revoke-luckin",{bodyLimit:8192},async(request,reply)=>{
        const owner=await authenticateOwner(request);
        if(!owner || owner.ownerId!==options.luckinOwnerId) return reply.code(403).send({error:"access_denied"});
        store.revokeResource(owner.ownerId,luckinResource);return {status:"revoked"};
      });
      if(previewEnabled)scope.post(base+"/revoke-luckin-preview",{bodyLimit:8192},async(request,reply)=>{
        const owner=await authenticateOwner(request);if(!owner||owner.ownerId!==options.luckinPreviewOwnerId)return reply.code(403).send({error:"access_denied"});
        store.revokeResource(owner.ownerId,previewResource);return {status:"revoked"};
      });
      if(ordersEnabled)scope.post(base+"/revoke-luckin-orders",{bodyLimit:8192},async(request,reply)=>{
        const owner=await authenticateOwner(request);if(!owner||owner.ownerId!==options.luckinOrdersOwnerId)return reply.code(403).send({error:"access_denied"});
        store.revokeResource(owner.ownerId,ordersResource);return {status:"revoked"};
      });
      if(mcdEnabled)scope.post(base+"/revoke-mcd-orders",{bodyLimit:8192},async(request,reply)=>{
        const owner=await authenticateOwner(request);if(!owner||owner.ownerId!==options.mcdOwnerId)return reply.code(403).send({error:"access_denied"});
        store.revokeResource(owner.ownerId,mcdResource);return {status:"revoked"};
      });
      // 部署验收也走同一网页登录与明确同意，不读取浏览器Cookie或制造后台授权。
      scope.get(base+"/verify",async (_request,reply) => {
        for (const [key,value] of checks) if (value.expires<=now()) checks.delete(key);
        if (checks.size>=10) return reply.code(429).send({ error:"too_many_requests" });
        const state=random(),verifier=random();checks.set(state,{verifier,expires:now()+600000});
        const url=new URL(origin+base+"/authorize");
        Object.entries({client_id:"kuinest-deployment-check",redirect_uri:origin+base+"/verify/callback",response_type:"code",scope:oauthScope,resource,state,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"}).forEach(([key,value])=>url.searchParams.set(key,value));
        return reply.redirect(url.href,303);
      });
      scope.get<{ Querystring:{state?:string;code?:string;error?:string;iss?:string} }>(base+"/verify/callback",async (request,reply) => {
        const check=checks.get(request.query.state ?? "");checks.delete(request.query.state ?? "");
        if (!check || check.expires<=now() || !request.query.code || request.query.iss!==issuer) return reply.code(400).send({ status:"verification_not_completed" });
        let access="",refresh="";
        try {
          const address=app.server.address();
          if (!address || typeof address==="string") throw new Error("OAUTH_CHECK_FAILED");
          const exchanged=await fetch(`http://127.0.0.1:${address.port}${base}/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",connection:"close"},body:new URLSearchParams({grant_type:"authorization_code",client_id:"kuinest-deployment-check",code:request.query.code,code_verifier:check.verifier,redirect_uri:origin+base+"/verify/callback",resource}).toString(),signal:AbortSignal.timeout(5000)});
          if (!exchanged.ok) {await exchanged.arrayBuffer();throw new Error("OAUTH_CHECK_FAILED");}
          const tokens=await exchanged.json() as {access_token:string;refresh_token:string};access=tokens.access_token;refresh=tokens.refresh_token;
          const rpc=async(method:string,params?:object)=>(await app.inject({method:"POST",url:kuisenseMcp.path,headers:{authorization:"Bearer "+access,accept:"application/json, text/event-stream","content-type":"application/json","mcp-protocol-version":"2025-11-25"},payload:{jsonrpc:"2.0",id:1,method,...(params?{params}:{})}})).json();
          const initialized=await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"kuinest-deployment-check",version:"1"}});
          const listed=await rpc("tools/list");
          if (!initialized.result || listed.result?.tools?.length!==1 || listed.result.tools[0].name!=="get_latest_context") throw new Error("MCP_CHECK_FAILED");
          const called=await rpc("tools/call",{name:"get_latest_context",arguments:{}});
          const present=called.result?.isError===false && called.result?.structuredContent?.schema_version===1;
          const missing=called.result?.isError===true && JSON.parse(called.result.content[0].text).code==="KUISENSE_CONTEXT_NOT_FOUND";
          if (!present && !missing) throw new Error("CONTEXT_CHECK_FAILED");
          // 使用无效schema探测鉴权；即使出现鉴权回归，也不能覆盖真实latest。
          const upload=await app.inject({method:"POST",url:"/api/kuisense/context",headers:{authorization:"Bearer "+access},payload:{schema_version:0}});
          if (upload.statusCode!==401) throw new Error("WRITE_BOUNDARY_FAILED");
          const result={status:"verified",checkedAt:new Date(now()).toISOString(),oauthAuthorization:true,pkceExchange:true,toolCount:1,readOnlyCall:true,contextAvailable:present,deviceWriteDenied:true,diagnosticGrantRevoked:true};
          store.revoke("kuinest-deployment-check",refresh);
          writeFileSync(join(options.root,"verification.json"),JSON.stringify(result),{mode:0o600});
          return reply.type("text/html; charset=utf-8").send("<!doctype html><meta charset=utf-8><title>葵栖 · 验证完成</title><h1>只读连接验证完成</h1><p>授权、PKCE交换、唯一工具发现及只读调用均通过。诊断授权已撤销。</p><p>私人手机正文和令牌未在此显示。可以回到开发窗口告知验证完成。</p>");
        } catch { return reply.code(503).send({status:"verification_failed"}); }
        finally { if (refresh) store.revoke("kuinest-deployment-check",refresh);access="";refresh=""; }
      });
    });
    app.addHook("onClose",async()=>store.close());
  }
  return { authorization, luckinAuthorization, luckinPreviewAuthorization, luckinOrdersAuthorization, mcdAuthorization, register, store };
}
