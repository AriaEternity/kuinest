import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { LuckinToolName } from "@kuinest/contracts";

export type LuckinResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError: boolean };
export interface LuckinReader { call(name: unknown, args: unknown, signal?: AbortSignal): Promise<LuckinResult> }
export function luckinFailure(code: string): LuckinResult {
  return { isError:true, content:[{type:"text",text:JSON.stringify({code,message:"瑞幸查询暂不可用，请稍后重试或联系服务维护者。"})}] };
}
// 固定名单和字段验证同时用于 MCP 入口与上游适配器，校验失败前不产生网络请求。
export function parseLuckinCall(name: unknown, value: unknown): {name: LuckinToolName; args: Record<string, unknown>} {
  const invalid = (): never => { throw new McpError(ErrorCode.InvalidParams,"仅允许三个瑞幸查询工具及其有效参数。"); };
  if (name !== "queryShopList" && name !== "searchProductForMcp" && name !== "queryProductDetailInfo") return invalid();
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const args=value as Record<string,unknown>;
  const required=name==="queryShopList"?["longitude","latitude"]:name==="searchProductForMcp"?["deptId","query"]:["deptId","productId"];
  const allowed=name==="queryShopList"?[...required,"deptName"]:required;
  if(required.some(k=>!Object.hasOwn(args,k)) || Object.keys(args).some(k=>!allowed.includes(k))) return invalid();
  const text=(v:unknown,max:number)=>typeof v==="string" && !!v.trim() && [...v].length<=max && !v.includes("\0");
  if(name==="queryShopList") {
    if(typeof args.longitude!=="number" || !Number.isFinite(args.longitude) || Math.abs(args.longitude)>180
      || typeof args.latitude!=="number" || !Number.isFinite(args.latitude) || Math.abs(args.latitude)>90
      || (Object.hasOwn(args,"deptName") && !text(args.deptName,100))) return invalid();
  } else {
    if(!Number.isSafeInteger(args.deptId) || Number(args.deptId)<=0) return invalid();
    if(name==="searchProductForMcp" ? !text(args.query,500) : !Number.isSafeInteger(args.productId)||Number(args.productId)<=0) return invalid();
  }
  return {name,args:Object.fromEntries(Object.keys(args).map(k=>[k,args[k]]))};
}
