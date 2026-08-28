# Netlify + Supabase 隔离验证

- 分支：`codex/netlify-supabase-validation`
- 基线：本地 `develop` 已提交的 v1.5.1，`21b57e2`。
- 未包含原目录正在开发的 workbench 账号文件；不修改、合并或发布原项目。
- 原有 Sites hosting 关联在此实验分支中移除，避免误发原站。

## 方案

保留 Next.js、现有账本 UI、同源 POST API 和纯业务逻辑。Netlify Functions 承载服务端；Supabase Auth 提供邮箱密码登录；Supabase PostgreSQL 保存业务数据。

1. PostgreSQL 使用独立 `ttq` schema 和最小权限后端角色。浏览器不直连数据库，也没有数据库密码或 service-role key。
2. 保留 D1-shaped repository 接口，只适配参数绑定、事务和约束。SQLite 测试继续保留，PostgreSQL 单独跑真实引擎测试。
3. 事务使用 SERIALIZABLE；串行化失败变为可恢复冲突，不显示保存成功。保留 operationId、expectedVersion、整批回滚和跨账号隔离。
4. 使用 Supabase 官方 SSR client、HttpOnly cookies、服务端 getUser 核验、同源写入检查。首阶段只向已创建的测试账号提供登录，不新增开放注册/短信。
5. 不读取或导入真实账本；本地 PostgreSQL 数据目录随机隔离。云端验证只能指向用户授权的新测试项目。

## 验证

- 基线自动测试：120/120 通过（2026-08-27 任务开始时）。
- PostgreSQL schema、约束、并发、幂等、隔离与回滚。
- Supabase SDK 会话接入/错误处理的受控 HTTP 协议测试；没有真实项目时不得称已验证 Supabase 云端。
- lint、类型检查、生产构建、Netlify 构建产物、本机 HTTP 冒烟。
- 最终复查原分支提交与未提交文件 SHA-256。
- 云端凭据缺失时，交付可执行配置和单独的云端验证入口，明确未完成项。
