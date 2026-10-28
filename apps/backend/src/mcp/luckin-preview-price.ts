import {createHash} from "node:crypto";
import type {LuckinResult} from "./luckin-policy.js";
export type PreviewPriceUnit="yuan"|"fen";
// 输出字段来自官方 Skill；层级/单位尚无真实响应证明，默认只显示未核验状态。
export function assessLuckinPreview(result:LuckinResult,args:Record<string,unknown>,unit?:PreviewPriceUnit):Record<string,unknown> {
  const candidates=new Map<string,Record<string,unknown>>();
  const fields=["totalInitialPrice","privilegeMoney","discountPrice","couponCodeList"];
  const visit=(value:unknown,depth=0):void=>{
    if(depth>20)return;
    if(typeof value==="string"&&/^[\s]*[\[{]/.test(value)){try{visit(JSON.parse(value),depth+1);}catch{}return;}
    if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return;}
    if(value&&typeof value==="object"){
      const object=value as Record<string,unknown>;
      if(fields.every(key=>Object.hasOwn(object,key)))candidates.set(JSON.stringify(fields.map(key=>object[key])),object);
      for(const item of Object.values(object))visit(item,depth+1);
    }
  };visit(result);
  const base={status:"unverified",orderCreationEnabled:false,currency:"CNY",draftDigest:createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    notice:"预览不等于下单确认；本连接不能创建或支付订单。"};
  if(candidates.size!==1)return {...base,reason:candidates.size?"AMBIGUOUS_PREVIEW":"PREVIEW_FIELDS_UNVERIFIED"};
  const data=[...candidates.values()][0]!;
  if(!Array.isArray(data.couponCodeList)||data.couponCodeList.length>50||data.couponCodeList.some(v=>typeof v!=="string"||!v.trim()||v.length>256||v.includes("\0")))return {...base,reason:"COUPONS_UNVERIFIED"};
  const coupons=data.couponCodeList as string[];
  if(unit!=="yuan"&&unit!=="fen")return {...base,couponCount:coupons.length,reason:"MONEY_UNIT_UNVERIFIED"};
  const minor=(value:unknown):number|undefined=>{
    if(typeof value!=="string"&&typeof value!=="number")return undefined;
    const text=String(value),match=/^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(text);
    if(!match||(unit==="fen"&&match[2]!==undefined))return undefined;
    const number=BigInt(match[1]!)*(unit==="yuan"?100n:1n)+(unit==="yuan"?BigInt((match[2]??"").padEnd(2,"0")):0n);
    return number<=BigInt(Number.MAX_SAFE_INTEGER)?Number(number):undefined;
  };
  const total=minor(data.totalInitialPrice),discount=minor(data.privilegeMoney),payable=minor(data.discountPrice);
  if(total===undefined||discount===undefined||payable===undefined||discount>total||total-discount!==payable)return {...base,reason:"MONEY_VALUES_INCONSISTENT"};
  return {...base,status:"amounts_checked",unitSource:"trusted_server_configuration",couponCount:coupons.length,
    amounts:{unit:"fen",totalInitialPrice:total,privilegeMoney:discount,discountPrice:payable},
    // 指纹仅供一致性核对，不是授权凭据，不能用于创建订单。
    quotationDigest:createHash("sha256").update(JSON.stringify({args,unit,total,discount,payable,coupons})).digest("hex")};
}
