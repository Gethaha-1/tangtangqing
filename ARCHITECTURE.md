# 技术架构

适用范围：当前 Netlify + Supabase 线上版本，以及严格隔离的本地测试模式。

## 1. 当前运行拓扑

```text
browser
  → Netlify CDN / Next.js Proxy
  → Next.js pages + Node route handlers
  → Supabase Auth（核验登录用户）
  → Supabase PostgreSQL（ttq 私有 schema）
```

- Netlify 托管完整 Next.js 应用，不把 `public/ledger` 单独当静态站发布。
- Supabase Auth 使用邮箱密码登录；服务端通过官方 SSR SDK 管理 Cookie，并在业务 API 中用 Auth 服务重新核验用户。
- 正式业务数据写入 Supabase PostgreSQL。`ttq_app` 后端角色通过 TLS 连接私有 `ttq` schema，浏览器不持有数据库连接串或特权密钥。
- 生产强制 `TTQ_AUTH_MODE=supabase`、`TTQ_DATABASE_MODE=postgres`。SQLite 和固定本地身份只允许 development + loopback。

## 2. 分层

| 层 | 位置 | 职责 |
|---|---|---|
| 登录页 | `app/page.tsx`、`app/current-user.ts`、`app/supabase-login-form.tsx` | 当前会话展示、Supabase 登录和本地测试入口 |
| 认证边界 | `proxy.ts`、`lib/server/supabase-auth.ts`、`lib/server/request-identity.ts`、`lib/server/auth*.ts` | Auth 用户核验、内部 `Principal`、模式隔离 |
| 客户端会话 | `src/auth-client.js` | 同源 POST、会话 scope、多标签和 BFCache 锁定 |
| 账本 UI | `legacy/ledger.html` | 一趟往返、货主清单、运费试算、批量快记、fuel、收车与 JSON 交互 |
| 业务规则 | `src/domain.js` | schema v4、去返程定点公式、金额/fuel、账期、趟号和报告摘要 |
| 同步规划 | `src/cloud-sync.js` | 状态↔记录、diff、守恒、回执与严格在线状态机 |
| 本机恢复 | `src/draft-store.js`、`src/recovery-client.js` | IndexedDB scope/CAS、原请求日志、恢复分块与 SHA-256 |
| API | `app/api/bootstrap`、`app/api/sync`、`app/auth/*` | POST 边界、身份核验、原子写入与退出 |
| 服务端业务 | `lib/server/bootstrap.ts`、`lib/server/sync-repository.ts` | fleet/role/assignment 授权、校验、幂等与并发控制 |
| 线上持久化 | `db/postgres.ts`、`deploy/supabase/001_ledger.sql` | PostgreSQL 参数适配、SERIALIZABLE 事务、正式 schema |
| 本地兼容 | `db/sqlite.ts`、`db/runtime-schema.ts`、`drizzle/` | 本地 SQLite 与旧 schema/migration 回归 |

成熟 UI 仍保留在单文件中；高风险规则放在第一方纯模块或服务端边界并由自动化测试覆盖。

## 3. 身份与车队边界

```text
Supabase session cookie
  → route 内 getUser() 远端核验
  → Principal(issuer=supabase, subject=user.id)
  → identities(issuer, subject)
  → users → fleet_members → fleet-scoped rows
```

- 业务归属使用 provider issuer + 稳定 subject，不用邮箱、显示名或客户端 metadata 当授权键。
- API 自己核验 Supabase 用户，不信任浏览器提交的 `x-ttq-auth-*`、旧 provider 头、user、fleet、role 或 assignment。
- 登录 Cookie、认证响应和用户数据响应禁止公共缓存。
- 本地 `dev:local` 使用固定测试 Principal，但必须同时满足显式 local 模式、`NODE_ENV=development` 和 loopback host；生产构建不能启用。
- 车队 owner/driver 和车辆 assignment 在服务端检查；司机只读写已分配车辆。

## 4. PostgreSQL 与访问控制

- 线上 schema 为不对 Data API 暴露的 `ttq`；浏览器不通过 REST/GraphQL 直接读写业务表。
- `ttq_app` 是最小权限后端登录角色，不能建表；管理连接只用于经审核的 schema 初始化或迁移，不能上传 Netlify。
- 业务表启用 RLS 作为后端专用防御层；具体车队/车辆权限仍由应用服务端授权，不依赖客户端 JWT 直接选行。
- 数据库连接必须与 Supabase Auth 属于同一 project ref，远程连接必须校验 TLS；禁止 `rejectUnauthorized:false`。
- PostgreSQL 适配器保留原 D1-shaped repository 接口，名称是兼容层，不表示线上仍使用 Cloudflare D1。

## 5. HTTP 与会话安全

- `/api/bootstrap`、`/api/sync`、登录和退出使用同源 JSON POST；bootstrap GET 返回 405。
- 状态写请求校验 Origin allowlist、Fetch Metadata、`application/json`、`X-TTQ-Request: ledger-v1` 和 2 MiB body 上限。
- 动态响应设置 `Cache-Control: no-store`、frame deny、nosniff、no-referrer 和受限 Permissions Policy；HTTPS 添加 HSTS。
- BFCache、其他标签页退出、401 或手动退出会先锁界面、清内存状态、终止请求并递增 generation；迟到回执不能解锁旧账。
- 恢复写入必须重新 POST bootstrap，不能只依赖 `navigator.onLine`。

## 6. 正式状态与原子写入

```text
confirmed S → clone proposal → plan operations(expectedVersion)
            → one operationId-bound SERIALIZABLE transaction
            → validate complete acknowledgement → replace S

network/server failure → keep old S + readonly + scoped IndexedDB request journal
409 conflict           → keep old S + reload/review
400/422 rejection      → keep old S + keep form for correction
401/session signal     → lock and hide business state
```

- 同 fleet + operationId + payload hash 可安全回放；同 ID 不同 payload 返回冲突。
- membership、assignment、父记录、版本与业务写在同一事务内守卫；任何一步失败整批回滚。
- 批量快记与当前未加入的输入暂存本机 IndexedDB；“保存全部”才生成一次原子请求。原请求和对应快记存于同一条本机记录，确认后整体清除，避免清请求/清草稿之间崩溃导致重复记账。
- 发车与返程页面也只把逐字段变更写入 scope 隔离的 IndexedDB 草稿；最终按钮将趟次 `business`、兼容收入行和必要的货主/地点设置作为一个原子提案。回执未知时保留原提案和表单，重连核对已确认的结构化清单后才清草稿。
- PostgreSQL/SQLite 在 `fleet_settings.business_json` 保存货主、市场、分组和常用地点，在 `trips.business_json` 保存去程与返程快照。数据库限定顶层必须为 JSON 对象，服务端限 1 MB 并重算分摊/应收；历史客户端在更新其他趟次字段时会保留已有业务 JSON。
- `/api/sync/status` 只返回当前 fleet 对应 ID/hash 是否已有回执，不暴露历史记录内容；司机分配变化后也不会因此泄露旧回执中的账目。
- JSON 恢复走 `/api/restore`：start/chunk/status/commit/cancel/list。临时 `restore_jobs`/`restore_chunks` 与正式业务表隔离，owner-only，一车队一个活动任务，7 天有效期，按访问清理过期临时区；无后台定时清理器。
- SHA-256 绑定不可变分块，序号唯一；单块 128 KiB/250 条，总 20 MiB/30000 条/256 块。普通 sync 仍为 500 条。恢复七类记录的预检采用按表集合读取，最终复用原业务校验、版本/权限守卫和一个 SERIALIZABLE 写事务。
- 数据库 trigger 使 `fleets.version` 同时充当全账本单调 revision。bootstrap 在读取记录的同一快照内读取 revision；最终恢复检查预览 revision，能识别别的设备新增记录。任务 complete、正式写入、幂等回执、清理已提交临时块在同一事务内。
- 本轮复用 Next.js Node 路由（maxDuration 60 秒），不新增 Netlify Background Function。上传随页面关闭而暂停；服务端请求也可能被平台终止。重新打开查原任务并续传/重试，不承诺关页后无限后台运行，不以 202 或分块回执显示恢复成功。

## 7. 客户端存储与备份

- 全设备键只保存主题；账号相关偏好必须在 bootstrap 返回 `fleet.id + membership.id` 后按 scope 保存。
- 未归属旧 localStorage 不自动读取或迁移，避免前一个账号的数据进入后一个账号。
- IndexedDB 草稿只在 bootstrap 核验后按 fleet+membership 读取；记录 ID 区分不同输入，revision CAS 防同一草稿多标签覆盖。401/BFCache/退出清内存并锁库句柄，但保留磁盘暂存；无跨设备恢复、无浏览器清理后的恢复保证。
- JSON 导出只由 owner 生成可完整恢复文件；driver 裁剪视图标记为不可完整恢复。
- schema v4 导入在清洗、提交和服务器回读阶段核对记录数、整数分、fuel 与业务 JSON 守恒；v1/v2/v3 仍按原规则迁移。

## 8. 报告与 UI 边界

`TTQDomain.buildReportSummary(state, scope)` 统一账期、月度交集、自然年、车辆、净利润和 fuel 口径，供统计卡片和文字报告共同使用。当前没有报告网络 endpoint、定时任务、视频生成或外部 AI API。

构建时 `scripts/prepare-ledger-assets.mjs` 把 `legacy/ledger.html` 与 `src/` 账本脚本复制到 gitignored 的 `public/ledger/`。线上必须发布完整 Next.js/Netlify 构建产物；本地 UI 使用 `npm run dev:local`，不得直接打开源 HTML。

## 9. 部署资料边界

- 当前部署说明：`deploy/NETLIFY-SUPABASE.md`
- 当前环境变量：`deploy/env-vars.md`
- PostgreSQL schema：`deploy/supabase/001_ledger.sql`
- 第二轮增量迁移：`supabase/migrations/20260908120000_trip_business.sql`（未经明确授权不得对生产执行）
- 迁移期实测数据：`deploy/VALIDATION-RESULTS.md`（历史记录，不是当前配置来源）
- 迁移方案草案：`deploy/NETLIFY-SUPABASE-PLAN.md`（历史记录）

Sites/Cloudflare D1 已退出本主线，独立 Sites 1.6.1 分支/站点保留归档；CloudBase 与容器/CFS 不属于现行部署。两平台边界以 `PLATFORM-MAINTENANCE.md` 为准。
