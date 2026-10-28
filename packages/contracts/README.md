# 公开合同

本包只定义公开DTO、JSON Schema、客户端可用的错误和能力形状，不包含角色或后台完整协议。入口为src/index.ts与src/schemas/index.ts，说明见[API](../../docs/api-contract.md)。

修改接口时同步服务端、chat-client、前端及合成用例。TypeScript类型不能代替HTTP边界校验。可选MCP类型的存在不代表普通server默认注册这些服务。
