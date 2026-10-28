# 离线旧格式迁移

这是与日常server独立的迁移工具，不包含OpenClaw运行时、真实角色或旧对话。构建随根目录`npm run build`完成；入口为dist/cli.js，各个受控命令的参数定义见src/cli.ts。默认先inspect/validate/dry-run，不能根据目录存在推定可以apply。

只接受明确清单、稳定sourceId与batchId、资料哈希、显式会话归属及活动叶。受控格式固定main角色与`agent:main:xiaokui-web`示例会话键，旧格式版本边界见src/types.ts；它不是所有OpenClaw版本的通用升级器。对协议缺口、工具配对或分支不明确的输入必须报告并阻止，不按mtime猜测。

fresh-start模式保留允许的私有原档但不把旧聊天恢复进新活动上下文。角色资料、原始协议与公开投影分开，不能用前端文本弥补缺失的reasoning或工具记录。

源端采集只在明确授权时执行。设置`KUINEST_IMPORT_SSH_HOST=user@your-host.example`并传入完全相同的--host及自己的--identity；没有默认服务器，保留BatchMode和StrictHostKeyChecking。源码中的source-reader只读固定白名单，不读凭据、认证库或完整配置；profile/catalog的限定采集是独立命令，须分别核对范围。

输入/输出均须私有目录，拒绝越界、符号链接和不安全资料名称。公开仓库不提供任何来源封存包。已有实际运行资料的迁移应先做一致性备份与独立恢复核验，不在服务运行时修改数据库。
