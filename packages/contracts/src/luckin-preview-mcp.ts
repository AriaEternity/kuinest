import type {LuckinToolName} from "./luckin-mcp.js";
import { luckinTools } from "./luckin-mcp.js";

// 独立资源与权限；原 catalog 连接不会自动获得选规格/预览权限。
export const luckinPreviewMcp = Object.freeze({
  path: "/api/luckin/preview/mcp", scope: "luckin:checkout:preview", clientId: "kuinest-chatgpt-luckin-preview",
});
const id={type:"integer",minimum:1,maximum:Number.MAX_SAFE_INTEGER};
const amount={type:"integer",minimum:1,maximum:20};
const sku={type:"string",minLength:1,maxLength:256};
const product={type:"object",properties:{amount,productId:id,skuCode:sku},required:["amount","productId","skuCode"],additionalProperties:false};
const annotations={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true};
export const luckinPreviewTools = [
  ...luckinTools,
  {name:"switchProduct",title:"选择瑞幸商品规格",description:"按官方属性ID和操作码切换规格并获取新SKU。先读取商品详情；官方选中操作码为3；属性ID和SKU取自最新详情，禁止硬编码映射。不创建订单。",
    inputSchema:{type:"object" as const,properties:{deptId:id,productId:id,skuCode:sku,amount,
      attrOperationParam:{type:"object",properties:{attributeId:id,subAttr:{type:"object",properties:{attributeId:id,operation:{type:"integer",enum:[3]}},required:["attributeId","operation"],additionalProperties:false}},required:["attributeId","subAttr"],additionalProperties:false}},
      required:["deptId","productId","skuCode","attrOperationParam","amount"],additionalProperties:false},annotations},
  {name:"previewOrder",title:"预览瑞幸订单价格",description:"在已选门店试算商品、优惠和应付金额，不创建订单。使用官方返回的SKU；金额单位未核实不得换算或当作已确认报价。本连接无下单或支付能力。",
    inputSchema:{type:"object" as const,properties:{deptId:id,productList:{type:"array",items:product,minItems:1,maxItems:20}},required:["deptId","productList"],additionalProperties:false},annotations},
];
export type LuckinPreviewToolName = LuckinToolName|"switchProduct"|"previewOrder";
