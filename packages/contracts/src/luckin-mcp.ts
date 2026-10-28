// 瑞幸只读 MCP 的固定公开合同；不接受上游动态工具列表或凭据。
export const luckinMcp = Object.freeze({
  path: "/api/luckin/mcp", scope: "luckin:catalog:read", clientId: "kuinest-chatgpt-luckin",
  endpoint: "https://gwmcp.lkcoffee.com/order/user/mcp",
});
const id = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const luckinTools = [
  { name: "queryShopList", title: "查询瑞幸门店", description: "按明确给定的坐标查询瑞幸门店，只读；不定位用户、不下单。",
    inputSchema: { type: "object" as const, properties: {
      longitude: { type: "number", minimum: -180, maximum: 180 }, latitude: { type: "number", minimum: -90, maximum: 90 },
      deptName: { type: "string", minLength: 1, maxLength: 100 },
    }, required: ["longitude","latitude"], additionalProperties: false }, annotations },
  { name: "searchProductForMcp", title: "搜索瑞幸商品", description: "在指定门店按文本搜索商品，只读，不加入购物车或创建订单。",
    inputSchema: { type: "object" as const, properties: { deptId: id, query: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["deptId","query"], additionalProperties: false }, annotations },
  { name: "queryProductDetailInfo", title: "查询瑞幸商品详情", description: "读取指定门店商品详情，只读，不切换商品或预览订单。",
    inputSchema: { type: "object" as const, properties: { deptId: id, productId: id },
      required: ["deptId","productId"], additionalProperties: false }, annotations },
];
export type LuckinToolName = "queryShopList" | "searchProductForMcp" | "queryProductDetailInfo";
export type LuckinArguments = {
  queryShopList: { longitude: number; latitude: number; deptName?: string };
  searchProductForMcp: { deptId: number; query: string };
  queryProductDetailInfo: { deptId: number; productId: number };
};
