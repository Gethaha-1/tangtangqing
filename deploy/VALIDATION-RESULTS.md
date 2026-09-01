# Netlify + Supabase 隔离验证结果

日期：2026-08-27（America/Los_Angeles）。

## 结论

已实现并通过本地可行性验证：保留现有账本和 API，将登录接到 Supabase 官方 SSR SDK、数据接到 PostgreSQL，并生成 Netlify Functions 与 Edge 部署产物。

**已验证真实 Supabase 云端数据库与 Auth；尚未验证 Netlify 云端运行，也没有证明国内移动网络稳定。** 本地生产 HTTP 仍使用受控 HTTPS 协议夹具；Supabase 云端验证单独记录如下。当前 Netlify CLI 未登录，尚未创建 Netlify 测试站。

## 原项目隔离

- 新分支：`codex/netlify-supabase-validation`。
- 新工作目录：`/Users/chenrui/Documents/tangtangqing-netlify-supabase`。
- 基于 `develop@21b57e214887caf77c0552826cff77915139b82e`，没有包含它未提交的 workbench 账号改动。
- `main` 仍为 `63c5ada752b954f64216482a13b548b985df50a8`；`develop` 仍为上述提交。
- 原 develop 中两处已修改文件、三个未跟踪账号/迁移文件的 SHA-256 与开始时一致：`db/runtime-schema.ts`、`db/schema.ts`、`drizzle/0003_workbench_accounts.sql`、`lib/server/workbench-accounts.ts`、`lib/server/workbench-auth.ts`。
- 未合并、未推送、未发布原站。没有读取或迁移真实账本，也没有开放公网端口。
- 仅实验分支删除原 `.openai/hosting.json` 关联，避免误发布 Sites 原项目。

## 已通过的验证

| 检查 | 结果 |
|---|---|
| 改造前基线测试 | 120/120 通过 |
| 最终 `npm test` | 140/140 通过，无跳过 |
| `npm run lint` | 通过，排除构建生成目录 |
| `npx tsc --noEmit` | 通过 |
| `npm run build:netlify` | 通过，包含 Next.js 生产构建、Node Functions 和 Edge Functions 打包 |
| 生产 Next.js HTTP 冒烟 | 通过，实际 HTTP/HTTPS 与真实 PostgreSQL |
| `git diff --check` | 通过 |

### PostgreSQL 实测内容

使用 PostgreSQL 17.7 真实进程，只监听本机 loopback，临时目录在结束后移除。

- 迁移可重复执行，后端角色无建表权限，匿名/普通 Supabase API 角色不能读取业务 schema。
- 并发首次登录只创建一组用户和车队。
- 首次开账、保存、刷新回读、不同账号隔离。
- 相同 operationId 重放不重复入账；同 ID 不同内容拒绝。
- 并发修改只允许一个版本获胜；约束失败整批回滚。
- 最大金额整数分精度、在途唯一性、最后活动车辆、油费成对字段约束。
- 司机只见分配车辆，未分配车辆写入拒绝；事务执行前撤销成员权限会整批拒绝。
- 同时停用两辆最后活动车辆，仍保留至少一辆。
- 原有500操作原子批次上限可运行；本地耗时不代表跨洲云端耗时。

### Supabase 云端验证（2026-08-30）

- 在原组织内创建全新的 Singapore 免费测试项目，没有打开或修改原有暂停项目。
- Data API 关闭；公开注册、匿名登录和手动身份链接关闭，邮箱确认开启。
- 使用官方 CA 完成 TLS 证书与主机校验，未关闭 `rejectUnauthorized`；控制台已启用 **Enforce SSL on incoming connections**，数据库重启后再次连接验证通过。
- 真实云端迁移成功：`ttq` 私有 schema、15 张表、RLS 和专用 `ttq_app` 后端角色。
- `ttq_app` 能连接和读写业务表，但不能建表；数据库与 Auth Project Ref 必须一致。
- Supabase Security Advisor：0 errors、0 warnings、0 suggestions。
- 创建两个自动确认的隔离测试账号；真实 Auth 登录、`getUser` 远端复核、退出和身份隔离全部通过。
- 管理连接、应用连接、CA、内部密钥和测试账号密码只在本机 `.ttq-local.env`（0600、Git 忽略）中；公开 publishable key 也未写入仓库。为防止 Netlify Next.js Runtime 自动把标准 `.env.local` 复制进函数包，脚本使用非标准本机文件名显式加载。

迁移过程中发现并修复：本地安装器曾错误复用生产环境的 `ttq_app` 角色检查，导致合法的项目管理员迁移连接在 SQL 执行前被拒绝。修复后仍先核对 Project Ref/host，且管理员连接不会上传 Netlify。

### Netlify 本地打包安全与草稿验证（2026-09-01）

- Netlify Next.js Runtime 会主动把标准 `.env.local` 复制到服务器函数；本机凭据已迁到 Git 忽略且权限为 0600 的 `.ttq-local.env`，由 Node `loadEnvFile` 仅在本地显式读取。重新构建后函数 ZIP 不含 `.env*`、本机凭据文件或证书文件。
- Netlify CLI 27.4.0 在这个 `git worktree` 中把上层用户目录误判为仓库根目录，先前因此发布了错误的 `.next` 路径且没有上传 Node 函数。使用显式 `--dir .next --functions .netlify/functions-internal` 后，日志确认上传 1 个函数。
- 隔离草稿域名的动态首页和 `/api/deployment-info` 均返回 200；未触碰原 Netlify 站点或原分支。

### Auth 与 HTTP 实测内容

Supabase SDK：配置拒绝管理密钥和不安全地址；HttpOnly/Secure cookie；getUser 远端核验；拒绝伪造 cookie/身份头；刷新过期会话并返回 cookie；Auth 故障不会退回信任缓存身份；同源检查；退出清除 cookie。

生产 HTTP：登录页、错误密码、两个账号登录、受保护账本与脚本、首次加载、真实 PostgreSQL 保存/重放/回读、账号隔离、CSRF 拒绝、退出、伪造内部身份头拒绝。全部测试服务结束后关闭。

验证发现并修复：标准 Next.js 不会自动把 `/ledger` 映射到 `public/ledger/index.html`，现已在完成认证后显式映射。

## 尚需用户提供的测试条件

1. 一个**全新 Netlify 测试站**的授权，不复用原站。
2. 将本机已验证的运行变量安全配置到测试站；迁移管理员连接和测试用户密码不得上传。
3. 执行 `verify:cloud` 后，用国内手机流量实测登录、保存、掉线/重试和晚高峰访问。

还需要真实环境审查：Supabase 自定义数据库角色/连接证书、Netlify 函数地域与时限、账号恢复/邮件投递、备份恢复和实际数据迁移。当前实验只实现管理员开通账号后的邮箱密码登录与退出，不包含开放注册或自助找回页面。

因此本报告支持“代码适配和本地运行可行”，不代表“生产环境已上线/国内网络已验收”。
