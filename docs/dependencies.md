# 依赖与首次公开包

本仓库使用精确锁文件和npm官方registry，Node24.20.0 / npm11.19.0。2026-10-28准备公开包时，将相关补丁更新为Fastify5.12.7、sharp0.35.5，传递依赖fast-uri3.1.9、body-parser2.4.0；better-sqlite3保持13.0.3。

依据为依赖审计与上游公告：[Fastify请求头校验](https://github.com/advisories/GHSA-389g-gv7q-r4x8)、[sharp/librsvg](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)、[body-parser压缩请求](https://github.com/advisories/GHSA-27r3-jxmh-p828)、[fast-uri解析](https://github.com/advisories/GHSA-w74x-v6f9-j3xg)。补丁只描述本公开包，不替其他部署声明已升级。

该次`npm audit fix --ignore-scripts`完成后，npm audit报告0项已知漏洞。审计是时点结果，不能保证以后没有新公告；维护者与部署者仍需定期检查自己的锁文件与运行环境。

默认ignore-scripts=true。SQLite包自带平台预编译产物，sharp使用锁定的对应平台包；首次可运行`npm run check:sqlite`核对实际加载。无需为默认安装强制npm rebuild。本地曾尝试多余重建并因缺少Windows C++工具失败，随后确认包原有预编译产物可直接加载；没有用来源不明的二进制替换。

`npm test`使用当前公开锁文件，CI独立从npm ci安装并验证。提交不携带node_modules、原生二进制导出副本、构建缓存或私人数据。
