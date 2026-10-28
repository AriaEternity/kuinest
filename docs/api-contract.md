# 网页公开接口 0.3

以`packages/contracts/src`中的类型、JSON Schema以及`apps/backend/src/http/routes/api.ts`为当前可执行依据。时间为ISO8601，ID是不透明字符串。默认同源`/api/v1`，JSON输入；除登录外要求本人Cookie，已登录写入还要求准确Origin与X-CSRF-Token。

| 方法与路径 | 用途 |
|---|---|
| POST /auth/login | 本人登录，检查Origin与JSON格式 |
| GET /auth/session | 当前会话与CSRF |
| POST /auth/logout | 撤销登录 |
| GET /meta | API版本、实际能力与图片限额 |
| GET /conversations | 会话分页 |
| POST /conversations | 新建会话 |
| GET /conversations/:id | 会话元数据 |
| PATCH /conversations/:id | `{title}`改名，去除首尾空白，1—100个Unicode字符 |
| DELETE /conversations/:id | 确认删除后返回204；生成中409；不撤回独立记忆 |
| GET /conversations/:id/messages | 公开消息历史与分页 |
| GET /conversations/:id/changes | 按revision读取消息变化 |
| POST /conversations/:id/messages | 按固定clientMessageId提交，返回202受理回执 |
| GET /conversations/:id/submissions/:client | 回查原提交结果 |
| GET /runs/:runId | 完整运行快照 |
| GET /runs/:runId/events | SSE与序号续接 |
| POST /runs/:runId/cancel | 请求取消，仍需观察终态 |

记忆候选路由见`apps/backend/src/http/routes/memory-review.ts`，图片见同目录`images.ts`；两者均沿用归属与鉴权。错误采用固定code及安全message，不返回内部SQL、Key、角色或后台协议。不存在或其他归属统一404。

改名不改变created_at分页键、消息seq或消息change_revision。删除使用持久标记，同归属重复删除可返回204；原历史、changes、run/events、附件和新提交均被屏蔽，定时任务停用。有accepted/running运行时拒绝，前端受理结果不明时也先对账。

ChatClient方法包含conversations、createConversation、conversation、renameConversation、deleteConversation、history、changes、submit、submission、run、watch及记忆/图片调用。删除204没有JSON正文；客户端严格校验其他返回值。

合成前端fixtures明确标注模拟；HTTP失败不回落成模拟成功。功能是否开放以meta和真实路由为准，不能仅凭类型存在推定可用。
