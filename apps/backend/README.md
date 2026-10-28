# 后端

从仓库根执行`npm run build`、`npm run test:backend -- --stage=all`。合成启动为`npm run backend:dev`；正式部署见[部署说明](../../docs/deployment.md)。

- `src/config.ts`：模式、来源、凭据路径和限额校验。
- `src/server.ts`：存储、运行、上下文、模型与生命周期装配。
- `src/storage/`与`schema/`：SQLite、六份追加迁移、租约、会话与私有档案。
- `src/auth/`与`src/http/`：本人账号、Cookie/CSRF、公开DTO与SSE。
- `src/conversations/`、`src/context/`、`src/providers/`：受理、worker、版本快照、协议和流解析。
- `src/memory/`：记忆读取、词面检索与确认流程。
- `src/runtime/`：绑定、权限、维护命令与备份恢复。
- `src/mcp/`、`src/oauth/`、`src/luckin/`、`src/mcd/`：可选集成代码，需独立装配及凭据，普通聊天不自动启用。

账号初始化、改密、解锁与数据库维护须停止对应服务，使用同一个受控DATA_ROOT；口令只在交互终端隐藏输入。先完成[合成HTTP体验](../../docs/getting-started.md)，不要直接用真实资料做调试。
