# 从界面演示开始

## 准备

使用Node24.20.0 / 24.x和npm11.19.0，在仓库根目录核对`node --version`与`npm --version`。依赖声明启用engine-strict，版本不符时直接修正工具链，不使用force绕过。

```sh
git clone https://github.com/AriaEternity/kuinest.git
cd kuinest
npm ci
npm run build
npm run frontend:dev
```

默认安装不执行生命周期脚本。锁定的better-sqlite3包含平台预编译产物，sharp使用对应平台的锁定可选包。先运行`npm run check:sqlite`确认本机支持；不要为了安装默认执行npm rebuild，也不要下载来源不明的.node文件。未覆盖的平台需要自行核对原生编译工具与包的构建说明。

## 界面演示

打开`http://127.0.0.1:5488/?mode=demo`。桌面图标双击打开，手机点按。演示使用浏览器本机的合成数据，不需要登录、后端或API Key；它不会在真实HTTP连接失败时自动接管。

- 聊天室：试写文字、读取合成历史、改名和打开删除确认。
- 记忆面板：看候选、确认和拒绝的界面状态。
- 游戏室：打开快跑，键盘空格/上方向键跳跃、P暂停，手机提供触摸控制。
- 设置：调整窗口、字体及动效。界面布局保存在当前浏览器。

5488被其他进程使用时，设置`PORT`换一个空闲端口；不停止其他程序。前端共享模块默认从当前仓库根解析，移动目录后仍可使用；仅特殊布局需要设置KUINEST_ROOT。

## 本地合成后端

这一层检查真实HTTP、账号和SQLite持久化，模型回复仍是明确的合成回复。

先停止后端，在根目录的交互终端运行：

```sh
npm run backend:owner:init
```

输入独立的合成账号和测试口令。口令由终端隐藏输入，不接受命令参数或管道，没有默认密码。再开一个终端：

```sh
npm run backend:dev
```

后端默认回环4317，合成数据只允许放在仓库`runtime/dev-synthetic`内部。另一个终端运行`npm run frontend:dev`，访问`http://127.0.0.1:5488/?mode=http`并使用刚才的测试账号。前端开发代理保留Cookie、CSRF和流式转发，只允许本机来源。

可检查：新建会话、发消息、等待完整结束、刷新看历史、改名、删除合成会话、新建会话。`/health/ready`返回200只说明服务就绪，模型仍为合成。退出后应要求重新登录。

## 真实模型

进入[部署说明](deployment.md)。不要把合成账号、合成运行根或浏览器demo的数据当作正式运行资料。真实模式要求自己的资料、独立私有目录、固定版本绑定、本人账号、服务端模型密钥与HTTPS。

## 常见问题

| 现象 | 检查 |
|---|---|
| 安装报引擎不符 | Node/npm版本；不要force |
| 找不到better_sqlite3.node | 用相同Node重建已锁定原生依赖，检查编译环境 |
| 共享模块404 | 在完整仓库根安装，保留packages目录并先build |
| HTTP模式502 | 后端是否在回环4317，是否先完成合成账号初始化 |
| 正式模式Cookie不保存 | HTTPS、同源代理、PUBLIC_ORIGIN与Secure属性；不要关闭保护 |
| 删除409 | 对应会话仍有accepted/running任务；先结束或取消 |
| 提交结果不明 | 使用原clientMessageId回查，不重复发送创建新请求 |
| private启动失败 | 运行check-runtime，核对绑定、账号激活、权限、凭据文件和ALLOW_LIVE_MODEL；不打印私人资料 |

CI结果和示例成功不代表真实模型及自己的服务器已验收。部署者应自己完成一次登录、模型完整终态、刷新保存、新会话隔离与记忆确认，再开始日常使用。
