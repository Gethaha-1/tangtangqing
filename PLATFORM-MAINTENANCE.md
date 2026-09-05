# 双平台维护边界 · Sites 归档侧

更新：2026-09-06。本分支保留 Sites v1.6.1，当前修改仅为维护文档。

| 项目 | Netlify 主线 | 本 Sites 归档 |
|---|---|---|
| 分支 | `develop` | `stable/sites-1.6.1` |
| 登录/数据库 | Supabase Auth / PostgreSQL | Sites 身份 / D1 |
| 后续功能 | 在主线开发、验收后另行授权发布 | 冻结，紧急安全修复另行确认 |
| 第一轮恢复 | v1.7.0 本地开发，草稿恢复与分块原子恢复 | 不包含，仍受 v1.6.1 原有限制 |

两站不是同一套账号、数据库或备份存储。GitHub 只备份源码，不能代替 JSON 账本导出或数据库备份。

- 复用现有本地目录，先增量 fetch 并核对分支，不为每轮迭代重新克隆。
- 不整体合并 Sites 与 develop；可共享的业务规则也需单独审核和各平台测试。
- 不复制 Supabase 连接、认证代理、PostgreSQL migration 到 Sites，也不复制 D1/Worker/Sites 身份到主线。
- 主线第一轮未改变 JSON schema v3；旧 v1/v2 仍兼容，但两个平台的文件容量和导入能力不同，不能承诺任意大型主线备份可回导 Sites。
- 禁止未经明确授权合并/提交到 main；GitHub 推送和 Sites 发布分别确认。
- 本次不改变 `.openai/hosting.json`、版本号、运行代码、D1 数据或线上站点。

完整主线维护规范见 develop 的 `PLATFORM-MAINTENANCE.md`、`ITERATION-1-RECOVERY.md`。本分支历史 CHANGELOG/计划仅记录当时状态，不再代表下一轮路线。
