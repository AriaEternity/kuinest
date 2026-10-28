# 像素桌面

从完整仓库根运行`npm run frontend:dev`，打开`http://127.0.0.1:5488/?mode=demo`。桌面双击图标，手机点按。默认生产页面使用HTTP；演示必须显式指定并显示合成数据标记。

前端使用原生JavaScript、CSS、canvas和共享chat-client，没有另一套依赖安装。`npm run frontend:check`检查模块语法，`npm run frontend:build`生成包含assets/css/js/shared的完整dist；`npm run test:frontend`执行状态和游戏模型测试。

共享模块默认从当前仓库解析，可通过KUINEST_ROOT显式指定其他完整工程根。开发代理默认转发回环4317，只接受本机Host/Origin；生产使用同源HTTPS，SSE与Cookie配置见[部署](../../docs/deployment.md)。

聊天支持会话管理、历史、流式/取消/恢复、记忆复核和安全Markdown。相册与日记仍是明确占位；文件交付、终端开发任务和单条历史编辑等未实现。界面不能读取模型密钥、角色文件或后端数据库。
