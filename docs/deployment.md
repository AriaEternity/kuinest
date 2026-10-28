# 部署自己的葵栖

这是单所有者自托管聊天服务的通用流程。示例针对Ubuntu24.04、Node24.20.0和systemd/nginx；不会连接项目作者的服务，也不携带任何生产资料。首次请先完成[本地合成体验](getting-started.md)。

## 1. 安装与目录

将源码放到`/opt/kuinest`，按README安装锁定依赖、检查原生模块，再执行`npm run build`与`npm run frontend:build`。确认systemd模板中的`/usr/bin/node`确实是Node24.20.0或满足工程要求的24.x；使用其他安装路径时修改模板中的绝对入口。

建立独立服务账号和受控目录。以下是首次安装示例，已有同名账号或资料时先核实，不能覆盖：

```sh
sudo useradd --system --home-dir /var/lib/kuinest --shell /usr/sbin/nologin kuinest
sudo install -d -m 0700 -o kuinest -g kuinest /var/lib/kuinest
sudo install -d -m 0700 -o root -g root /etc/kuinest
sudo install -d -m 0700 -o kuinest -g kuinest /etc/kuinest/credentials
```

运行资料与数据库放在`/var/lib/kuinest`，不能放在前端dist或公开目录。代码依赖可由root管理并供服务用户只读，服务仅能写自己的数据根。

## 2. 准备自己的资料

将`examples/character`和`examples/runtime-settings.json`复制到`/var/lib/kuinest`，由服务用户持有。在自己的私有目录编辑七份Markdown与模型配置，保留原有逻辑文件名。不要把自己的资料提交Git。

示例使用DeepSeek协议与确认制长期记忆，profile仍标记unverified。模型名、endpoint、origin、上下文预算、输出预算和思考参数需要与自己的服务资格一致。MiMo需要成套配置wireFormat=mimo及provider-default思考策略，不能只换URL。后端不自动发现模型或读取旧平台凭据。

首次创建全新数据根：

```sh
sudo -u kuinest /usr/bin/node /opt/kuinest/scripts/init-runtime.mjs \
  --output=/var/lib/kuinest/data \
  --documents=/var/lib/kuinest/character \
  --settings=/var/lib/kuinest/runtime-settings.json
```

成功返回`ok:true`、`bindingSha256`、`activated:false`、`accountReady:false`、`modelCalls:0`。保存自己的bindingSha256。初始化生成空聊天库、随机游标签名密钥和固定资料绑定；拒绝覆盖原目录，不会创建可用口令，也没有请求模型。失败后保留目标供核对，不反复执行或递归删除已有运行资料。

## 3. 配置与隐藏输入凭据

复制`deploy/runtime.env.example`到`/etc/kuinest/runtime.env`，root:0600。替换PUBLIC_ORIGIN与RUNTIME_BINDING_SHA256，核实各个绝对路径。先保持ALLOW_LIVE_MODEL=false、ENABLE_SCHEDULER=false、ENABLE_BACKUP_RETENTION=false。

在自己的交互终端隐藏输入API Key，不把Key放入命令行、聊天或Shell历史。下面进入服务账号的临时Shell后操作，拒绝覆盖已有文件：

```sh
sudo -u kuinest bash --noprofile --norc
umask 077
set -o noclobber
IFS= read -r -s -p 'API Key: ' kuinest_input_key; printf '\n'
IFS= read -r -s -p '再次输入: ' kuinest_repeat_key; printf '\n'
if [ -n "$kuinest_input_key" ] && [ "$kuinest_input_key" = "$kuinest_repeat_key" ]; then
  printf '%s\n' "$kuinest_input_key" > /etc/kuinest/credentials/provider.key
  chmod 0400 /etc/kuinest/credentials/provider.key
fi
unset kuinest_input_key kuinest_repeat_key
exit
```

仅核对文件存在、服务账号可读、0400及目录0700，不cat正文。不要以公开示例中的字符串作为实际Key。

## 4. 本人账号与显式激活

服务尚未启动时，使用systemd的受控环境与交互PTY运行现有维护入口：

```sh
sudo systemd-run --pty --wait --collect --uid=kuinest \
  -p WorkingDirectory=/opt/kuinest \
  -p EnvironmentFile=/etc/kuinest/runtime.env \
  /usr/bin/node /opt/kuinest/apps/backend/dist/runtime/cli.js owner-setup
```

按提示设置本人登录名和两次隐藏口令。再用同样命令将最后的`owner-setup`换成`activate`，核对自己的固定资料与版本后输入ACTIVATE。最后换成`check-runtime`核对`ok:true`。维护入口不读取模型密钥或发送请求。私人账号与合成账号互相独立。

## 5. HTTPS与服务

确认模型及费用后，编辑受控env将ALLOW_LIVE_MODEL=true。后端private入口要求显式启用，不会静默降级成mock。

按`deploy/kuinest.service.example`安装systemd单元，核对User、工作目录、Node与env路径，运行`systemd-analyze verify`，再daemon-reload和启用服务。回环`http://127.0.0.1:4317/health/ready`应为200。nginx示例只是已有HTTPS server块内的片段：需要自行配置域名、有效TLS证书、静态MIME与HTTP跳转；不能把模板文件当完整站点直接覆盖既有配置。

静态根必须是完整`apps/frontend-pixel/dist`；`/api/v1/`同源转发回环4317，SSE禁用缓冲与缓存，必要Cookie、Origin和CSRF保持。公开站点无需暴露health、SQLite、env、源码或维护端点。配置通过`nginx -t`后再reload。

正式站点不带`?mode=demo`。首次由本人登录并检查：发送文字→真实模型流式回复→完整结束→刷新历史保留；新会话隔离；候选记忆确认/拒绝及跨会话读取；用专用测试会话验证改名和删除。`ready200`不能代替这些体验检查。

## 6. 备份与更新

默认私人运行启用受控备份。数据库、绑定和备份目录应由服务用户独占，另行做好受保护的异地备份；模型密钥不放进普通归档。开启自动保留清理前，先按后端恢复工具完成真实独立恢复验证。

更新前停止聊天并核实无accepted/running任务，保留一致性数据、原程序和配置。迁移仅追加；检查新旧程序可识别的迁移历史。当前包含schema1—6，会话删除使用deleted_at。不能倒灌旧库、删除迁移记录或删除标记来实现回退，否则可能丢消息或使会话复现。

`backend:private:backup`与`backend:private:restore -- --backup=<UUID>`需要原private环境和停止服务；恢复只创建独立副本，不自动替换在用库、恢复登录或启用任务。检查覆盖和资料绑定后再决定是否切换。不要用删除runtime目录或重新初始化代替账号/运行问题排查。
