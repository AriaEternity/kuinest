# ChatClient

浏览器可复用的同源聊天客户端，默认`/api/v1`、携带Cookie、不缓存或跟随重定向。包含受控请求、严格DTO校验、SSE解析、RunState与ConversationState。

会话管理提供conversation、renameConversation和deleteConversation；204删除不解析JSON。提交保持clientMessageId，丢回执通过submission回查，不自动重发。watch把事件续接与完整快照对账结合，history与changes保留分页和revision语义。

公开路由见[API](../../docs/api-contract.md)。前端示例在apps/frontend-pixel；测试仅使用合成服务和注入请求。
