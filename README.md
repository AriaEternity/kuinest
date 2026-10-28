# 葵栖 · KuiNest

**简体中文** | [English](README.en.md)

**让对话有一个可以长期住下来的地方。**

葵栖是一个自托管的 AI 对话系统：前面是一间樱花色的像素小屋，后面是独立的会话、模型协议与确认制长期记忆。界面可以更换，资料和对话由自己的后端保存。

![葵栖像素桌面](docs/images/desktop.jpg)

[快速体验](#先看一眼) · [完整入门](docs/getting-started.md) · [部署说明](docs/deployment.md) · [架构](docs/architecture.md) · [安全边界](SECURITY.md)

## 可以做什么

| 能力 | 实现方式 |
|---|---|
| 持久会话 | 新建、切换、改名与确认删除；历史分页和消息变更对账 |
| 流式对话 | SSE、事件序号、运行快照、断线续接；完整终态与部分文本分开处理 |
| 明确的生成状态 | 受理、排队、运行、取消、失败与完成；提交回执不明时先查询原标识 |
| 长期记忆 | 模型提出候选，由用户确认或拒绝；新会话保持独立，已确认记忆可跨会话读取 |
| 角色与上下文 | 不可变角色版本、资料摘要绑定、上下文预算和完整后台协议档案 |
| 模型接入 | DeepSeek Chat Completions 与 MiMo 流式适配；模型和凭据由部署者配置 |
| 像素桌面 | 窗口、任务栏、显示设置、启动动画、Markdown 聊天与手机窄屏布局 |
| 小葵快跑 | 八帧跑步与跳跃动画、分段关卡、键盘和触摸操作 |
| 存储与恢复 | SQLite WAL、单实例租约、追加迁移、一致性备份与独立恢复副本 |
| 可选模块 | 图片附件、受控搜索注入、调度、KuiSense 上下文与 MCP/OAuth 源码 |

相册、日记仍是明确标注的占位。当前不提供聊天中的任意终端执行、服务器开发代理、助手文件交付、消息重新生成或单条历史编辑/删除。可选模块要看实际配置和 `/api/v1/meta`，目录存在不代表默认启用。

![聊天室与会话管理](docs/images/chat.jpg)

## 先看一眼

需要 **Node.js 24.20.0（24.x）与 npm 11.19.0**。从仓库根目录执行：

```sh
npm ci
npm run build
npm run frontend:dev
```

打开[本机合成演示](http://127.0.0.1:5488/?mode=demo)，双击桌面的聊天室或游戏室图标。演示明确标注合成数据，不需要 API Key，不发送模型请求。字体、图片和共享模块都由本机提供。

仓库默认禁用依赖安装脚本，锁定的 SQLite 与图像包提供平台预编译产物。遇到安装或平台兼容问题看[入门说明](docs/getting-started.md)。

## 从演示到自己的助手

演示模式、带真实 HTTP 的合成后端和真实模型部署是三个独立入口。

1. 只看界面：使用上面的 `?mode=demo`。
2. 检查持久化与接口：按[入门说明](docs/getting-started.md#本地合成后端)初始化独立合成账号，启动后端，再使用 `?mode=http`。
3. 部署真实模型：按[部署说明](docs/deployment.md)创建自己的空白角色运行根、固定绑定、隐藏输入账号和模型凭据，配置同源 HTTPS。

`examples/character` 是重新编写的虚构示例，不包含项目实际使用者的角色、记忆或对话。公开包不携带运行数据库、用户账号、模型 Key、OAuth 授权、手机包、订单资料或私人历史。首次初始化没有默认密码，也不会自动激活或调用模型。

## 会话删除与记忆

删除会话后，它会从列表中消失，对应历史、运行、事件和图片读取入口也会拒绝访问。正在生成的会话不能直接删除，需要先结束或取消。

这里使用持久删除标记：界面没有恢复入口，私有协议档案和备份不做安全擦除。**独立、已确认的长期记忆继续保留**，删除会话不会撤回此前确认。改名只改变会话名称，不改消息或分页创建键。

## 工程结构

```text
apps/backend/          Fastify + SQLite，认证、会话、模型、记忆与备份
apps/frontend-pixel/   原生 JavaScript 像素桌面与聊天室
packages/contracts/   公开 DTO、JSON Schema 与边界校验
packages/chat-client/ SSE 解析、运行快照与前端状态对账
tools/import-openclaw/离线迁移与限定源端采集工具
examples/              全新合成角色与通用模型配置
fixtures/              合成协议、聊天和集成样本
deploy/                通用配置模板，不含实际生产配置
```

运行时不依赖 OpenClaw 网关、安装目录或导入器。迁移工具单独执行，不能把整个旧运行目录直接当作输入。详细边界见[迁移说明](tools/import-openclaw/README.md)。

## 开发与验证

```sh
npm run check:public
npm run build
npm run frontend:check
npm run frontend:build
npm test
```

测试使用临时合成库、合成账号和注入的上游，不需要模型 Key，不调用真实模型或创建实际交易。CI 在 Ubuntu 上执行安装、构建、公开范围检查、后端和前端测试。公开副本新增的空白初始化入口有独立测试；它不代表已经在每位部署者的服务器完成真实模型、TLS或手机验收。

技术栈为 Node.js、TypeScript、Fastify、better-sqlite3 和原生 JavaScript。所有 npm 依赖精确锁定；首次阅读可从[架构](docs/architecture.md)、[接口](docs/api-contract.md)和[后端源码入口](apps/backend/README.md)开始。

## 相关项目

- [小葵 × 麦当劳 MCP](https://github.com/AriaEternity/xiaokui-mcd-mcp)：可独立部署的逐笔确认点单接入。
- [小葵 × 瑞幸 MCP](https://github.com/AriaEternity/xiaokui-luckin-mcp)：可独立部署的商品、报价与逐笔确认接入。
- [小葵启动动画](https://github.com/AriaEternity/xiaokui-codex-boot)：启动视觉的独立项目。

本仓库保留相关集成模块源码，但日常聊天服务不自动开启第三方点单，也不提供交易资格或官方凭据。独立 MCP 部署请优先阅读对应仓库。

## 许可证

项目自有代码、文档与自有图像按 [MIT](LICENSE) 提供。Fusion Pixel 字体遵循其随附 SIL OFL 1.1，npm 依赖沿各自许可证；详见[第三方与素材说明](THIRD-PARTY-NOTICES.md)。

改进建议与复现问题欢迎提交 [Issue](https://github.com/AriaEternity/kuinest/issues)。安全问题请先看 [SECURITY.md](SECURITY.md)，不要公开粘贴自己的凭据、聊天或数据库。
