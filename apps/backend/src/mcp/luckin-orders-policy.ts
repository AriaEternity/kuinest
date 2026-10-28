import {McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {parseLuckinPreviewCall} from './luckin-preview-policy.js';
export const intentPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseLuckinOrdersCall(name:unknown,args:unknown):{name:string;args:Record<string,unknown>}{
 if(name!=='createOrder'&&name!=='queryOrderDetailInfo')return parseLuckinPreviewCall(name,args);
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==1||!('intentId' in args)||typeof args.intentId!=='string'||!intentPattern.test(args.intentId))throw new McpError(ErrorCode.InvalidParams,'订单操作只接受本连接的intentId，不接受确认布尔值或订单参数。');
 return {name,args:{intentId:args.intentId}};
}
// 仅服务端订单编排使用；此参数合同不注册到MCP，订单参数不能由模型覆盖。
export function parseLuckinOrderUpstream(name:unknown,args:unknown):{name:string;args:Record<string,unknown>}{
 if(name!=='createOrder'&&name!=='queryOrderDetailInfo')return parseLuckinPreviewCall(name,args);
 const invalid=():never=>{throw new McpError(ErrorCode.InvalidParams,'订单上游参数无效。');};
 if(!args||typeof args!=='object'||Array.isArray(args))return invalid();const v=args as Record<string,unknown>;
 if(name==='queryOrderDetailInfo')return Object.keys(v).length===1&&typeof v.orderId==='string'&&/^\d{1,32}$/.test(v.orderId)?{name,args:{orderId:v.orderId}}:invalid();
 if(Object.keys(v).some(k=>!['deptId','productList','longitude','latitude','couponCodeList'].includes(k)))return invalid();
 const draft=parseLuckinPreviewCall('previewOrder',{deptId:v.deptId,productList:v.productList});
 if(typeof v.longitude!=='number'||!Number.isFinite(v.longitude)||Math.abs(v.longitude)>180||typeof v.latitude!=='number'||!Number.isFinite(v.latitude)||Math.abs(v.latitude)>90)return invalid();
 if(!Array.isArray(v.couponCodeList)||v.couponCodeList.length>50||v.couponCodeList.some(s=>typeof s!=='string'||!s.trim()||s.length>256||s.includes('\0')))return invalid();
 return {name,args:{...draft.args,longitude:v.longitude,latitude:v.latitude,couponCodeList:[...v.couponCodeList]}};
}
