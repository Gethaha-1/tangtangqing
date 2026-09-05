# v1.7.0 恢复能力：迁移与上线检查

本说明不代表部署授权。当前实现先交付本地验收，不自动操作生产数据库、Netlify 或 Sites。

## 增量迁移

文件：`supabase/migrations/20260905164507_ledger_recovery.sql`，由 Supabase CLI 创建。

前置为已存在的 `deploy/supabase/001_ledger.sql` schema；不能在已有账本上重跑初始化脚本。

变化：新增私有 `ttq.restore_jobs`/`ttq.restore_chunks`、RLS 与 backend-only 最小权限、整车队 revision triggers；`ttq.schema_versions` 新增 2。没有移除或重写业务数据，JSON 备份 schema 仍是 3。

迁移管理员和运行时 `ttq_app` 连接分离；不得把管理员连接带入 Functions。新表不暴露 Data API，anon/authenticated/service_role 无直接访问权限；新 trigger 函数是 SECURITY INVOKER，固定 search_path。

## 正确顺序

1. 本地执行 `npm test`、lint、tsc、build、`npm run test:browser`、`npm run test:http` 和 `npm run build:netlify`。
2. 获得用户当前任务的生产迁移/发布授权后，核对 Netlify site、分支/commit、Supabase project ref、备份和回退应用版本。
3. 先在明确隔离的测试资源应用增量 SQL，检查 marker 2、约束、RLS 和金额/记录数。再按授权迁移生产；不得让应用以初始化脚本自行补生产表。
4. 迁移后再发布完整 Next.js 产物。新应用要求 marker 1+2 和 ttq_app 角色，避免漏迁移后仍让用户进入恢复流程。
5. 专用测试账号验证：旧备份恢复、501/514/10000 费用记录、>2 MiB 分块、断网刷新续传、重复核对、并发新增记录、退出再登录。禁止用已转正式使用的账号 A 回归。
6. 在国内手机网络验证完整等待时间；若实际平台时限无法覆盖验收目标，停止发布扩大容量声明，另行设计后台执行，不自动购买套餐。

## 回退

- 首选回退 Netlify 应用版本，保留新增表、回执与 revision triggers；它们对旧版业务列是增量兼容的。
- 不删除 sync_commits，不重置正式账本，不盲目执行 migration down。未确认的恢复任务需先核对服务器状态，回退应用不等于任务未提交。
- 如确需移除新增结构，先停写、核对所有待确认任务、备份临时记录并制定单独审核方案。没有自动破坏性的 down SQL。

## 运维限制

一车队最多一个活动任务，单任务 20 MiB，7 天有效；完成/取消即清理临时块。当前过期清理是访问驱动，不是 Cron；无人访问的过期行需经审核的运维清理。新增数据会占用现有 Supabase 存储/流量额度，不能声称绝对零费用。

完成任务仅保留 manifest/身份和幂等回执，分块已删除；到期清理不得删除完成任务或 `sync_commits`。取消支持尚未到达服务器的 start 请求，通过取消标记阻止迟到请求继续上传。

本轮未新增 Functions 环境变量，不需要后台任务 secret，不更改 Supabase Auth 策略，不增加开放注册。本地用真实 PostgreSQL 负向角色查询与 pg_catalog 核对 RLS；尚未运行线上项目 advisors，发布前在授权的测试/生产目标另行核对。
