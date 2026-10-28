import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { LuckinPreviewToolName } from "@kuinest/contracts";
import { parseLuckinCall } from "./luckin-policy.js";
export function parseLuckinPreviewCall(name:unknown,value:unknown):{name:LuckinPreviewToolName;args:Record<string,unknown>} {
  if(name!=="switchProduct"&&name!=="previewOrder")return parseLuckinCall(name,value);
  const invalid=():never=>{throw new McpError(ErrorCode.InvalidParams,"仅允许查询、规格选择和订单预览，参数须匹配官方Schema。");};
  const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
  const keys=(v:Record<string,unknown>,allowed:string[])=>allowed.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>allowed.includes(k));
  const id=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
  const amount=(v:unknown)=>id(v)&&Number(v)<=20;
  const sku=(v:unknown)=>typeof v==="string"&&!!v.trim()&&v.length<=256&&!v.includes("\0");
  if(!object(value)||!id(value.deptId))return invalid();
  if(name==="switchProduct") {
    if(!keys(value,["deptId","productId","skuCode","attrOperationParam","amount"])||!id(value.productId)||!sku(value.skuCode)||!amount(value.amount))return invalid();
    const attr=value.attrOperationParam;
    if(!object(attr)||!keys(attr,["attributeId","subAttr"])||!id(attr.attributeId)||!object(attr.subAttr)||!keys(attr.subAttr,["attributeId","operation"])||!id(attr.subAttr.attributeId)
      ||attr.subAttr.operation!==3)return invalid();
    return {name,args:{deptId:value.deptId,productId:value.productId,skuCode:value.skuCode,amount:value.amount,attrOperationParam:{attributeId:attr.attributeId,subAttr:{attributeId:attr.subAttr.attributeId,operation:attr.subAttr.operation}}}};
  }
  if(!keys(value,["deptId","productList"])||!Array.isArray(value.productList)||value.productList.length<1||value.productList.length>20)return invalid();
  let total=0;const products:Record<string,unknown>[]=[];
  for(const item of value.productList) {
    if(!object(item)||!keys(item,["amount","productId","skuCode"])||!id(item.productId)||!sku(item.skuCode)||!amount(item.amount))return invalid();
    total+=Number(item.amount);products.push({amount:item.amount,productId:item.productId,skuCode:item.skuCode});
  }
  if(total>20)return invalid();
  return {name,args:{deptId:value.deptId,productList:products}};
}
