import {luckinPreviewTools} from './luckin-preview-mcp.js';
export const luckinOrdersMcp=Object.freeze({path:'/api/luckin/orders/mcp',scope:'luckin:orders:create',clientId:'kuinest-chatgpt-luckin-orders'});
const intent={type:'object' as const,properties:{intentId:{type:'string',format:'uuid'}},required:['intentId'],additionalProperties:false};
export const luckinOrdersTools=[...luckinPreviewTools.map(t=>t.name==='previewOrder'?{...t,description:'预览实际规格/价格与自动优惠，并生成逐笔确认链接。向用户展示门店、商品、规格、数量和人民币应付金额，请用户本人打开链接确认；OAuth或聊天确认不等于逐笔批准。'}:t),
 {name:'createOrder',title:'提交本人已确认的瑞幸订单',description:'仅接受previewOrder返回的intentId。必须先让用户本人打开受保护确认页批准；服务器核验报价与一次性批准后最多提交一次。超时/未知结果禁止重试或另建相同订单。返回官方支付二维码，付款由用户自行确认。',inputSchema:intent,annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}},
 {name:'queryOrderDetailInfo',title:'查询本连接创建的瑞幸订单',description:'仅使用已知intentId查询服务器记录的订单状态。不能传任意orderId，不能按聊天内容标记已支付。未确认支付时不展示取餐信息。',inputSchema:intent,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
];
