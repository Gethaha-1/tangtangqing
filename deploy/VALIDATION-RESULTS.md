# Netlify + Supabase 隔离验证结果

> 归档说明：本文记录 2026-08 至 2026-09 从旧平台迁移到 Netlify + Supabase 时的隔离验证、部署编号和耗时数据。当前架构与操作步骤以 `ARCHITECTURE.md`、`deploy/NETLIFY-SUPABASE.md` 和 `deploy/env-vars.md` 为准；不要把本文的测试站、旧分支或一次性凭据流程当作当前配置。

日期：2026-09-01（America/Los_Angeles）。

## 结论

已实现并通过本地及隔离云端验证：保留现有账本和 API，将登录接到 Supabase 官方 SSR SDK、数据接到 PostgreSQL，并以 Netlify Functions 与 Edge Function 运行。

**真实 Supabase 数据库/Auth 与 Netlify 隔离生产测试站的端到端流程已经通过；用户已确认当前国内网络可访问，但仍需复测优化后的登录/保存耗时，也未完成长期稳定性验收。** 本地生产 HTTP 使用受控 HTTPS 协议夹具，真实云端验证单独记录如下。

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
| 最终 `npm test` | 144/144 通过，无跳过 |
| `npm run lint` | 通过，排除构建生成目录 |
| `npx tsc --noEmit` | 通过 |
| `npm run build:netlify` | 通过，包含 Next.js 生产构建、Node Functions 和 Edge Functions 打包 |
| 生产 Next.js HTTP 冒烟 | 通过，实际 HTTP/HTTPS 与真实 PostgreSQL |
| Netlify + Supabase 云端端到端 | 通过，两个账号登录、开账、保存、幂等重放、回读、隔离、退出 |
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
- Netlify CLI 27.4.0 在这个 `git worktree` 中把上层用户目录误判为仓库根目录，先前因此发布了错误路径且没有上传 Node 函数。手动部署现在显式使用 `--dir .netlify/static --functions .netlify/functions-internal`：前者是插件恢复后的公开静态目录，后者是 Node 函数目录。
- 隔离草稿域名的动态首页和 `/api/deployment-info` 均返回 200；未触碰原 Netlify 站点或原分支。
- Web App Manifest、180/192/512 PNG 图标及受保护的 `/ledger` 桌面启动入口通过草稿验证。手机可添加到主屏幕；未注册 Service Worker，也不缓存认证页、API 或业务数据。

### Netlify + Supabase 隔离生产测试站（2026-09-01）

- 新建且只关联本工作树的 Netlify 站点：`https://tangtangqing-supabase-test.netlify.app`；没有关联 Git 仓库，也没有修改原站。
- 最新生产部署 `6a9739d0bbacf0c1c2a596eb` 已使用 `.netlify/static` 与同构建 Node 函数发布；Manifest 和 180/192/512 图标均返回 200。
- 生产部署日志确认上传 1 个 Node 服务器函数以及 Next.js Edge 中间件；首页返回 200，未登录访问 `/ledger` 返回 307，受保护 API 保持 POST-only。
- `/api/deployment-info` 返回预期部署标记及新 Supabase Project Ref，避免误连旧项目。
- `verify:cloud` 在真实 HTTPS 站点通过：两个测试账号登录和首次开账、账号 A 保存一条测试车辆、相同 operationId 幂等重放、刷新回读、账号 B 数据隔离、两个账号退出。没有导入真实账目。
- 手机安装版本发布后再次通过账号 A 登录、bootstrap、受保护账本 HTML/JS 加载和退出；临时写入验证记录已从测试库清理，不留业务数据。
- Netlify 仅保存运行需要的 8 个变量；Supabase 管理连接、应用账号原始密码和测试账号密码没有上传。

### 跨区启动延迟优化（2026-09-01）

- 免费 Netlify 站的函数当前在 `us-east-2`（Ohio），Supabase 在 `ap-southeast-1`（Singapore）。Netlify 自定义 Functions region 需要 Pro/Enterprise，本次没有升级套餐或产生付费。
- 原 bootstrap 的 8 条只读查询在一个串行化事务内逐条往返；连续实测为 4393、3221、3119、3152、3204 ms。
- PostgreSQL 适配器现在只对全 SELECT 批次使用单次 simple-query 网络消息，仍在同一个 `SERIALIZABLE READ ONLY` 快照中；写入批次保持原参数绑定、逐条执行、串行化事务和冲突处理。
- 隔离草稿真实账号连续 bootstrap 为 2705、1206、1198、1217、1263 ms；热请求约从 3.2 秒降到 1.2 秒。该结果来自当前开发机网络，不替代国内运营商实测。
- 正式站发布后复测为 2793、1274、1249、1261、1290 ms，登录、5 次 bootstrap、受保护账本及脚本加载、退出全部成功。

### 单笔保存延迟优化（2026-09-01）

- 收到国内网络可访问但登录/保存需数秒的实机反馈后，正式站单条维修记录写入实测为 3434、3455、3421 ms；测试记录均随即清理。
- PostgreSQL 适配器把受控写入批次也改为一次 simple-query 网络消息，仍保留 `SERIALIZABLE`、成员/车辆分配/父趟/版本守卫、约束失败全批回滚和幂等提交记录。
- 原子同步预检把成员状态、operationId 重放和各记录当前版本放入同一个串行化只读快照；事务内守卫继续防止预检后撤权或并发改动。
- 隔离草稿连续单笔保存为 1672、1748、1653 ms，清理为 1422、1496、1423 ms；相对原保存耗时约减半。所有临时记录均已验证清理。
- 正式站发布后保存为 1681、1696、3119 ms，清理为 1422、1617、1435 ms；通常约 1.7 秒，仍观察到一次 3.1 秒平台冷启动/调度波动。临时记录全部清理，受保护账本和退出复验通过。

### Auth 与 HTTP 实测内容

Supabase SDK：配置拒绝管理密钥和不安全地址；HttpOnly/Secure cookie；getUser 远端核验；拒绝伪造 cookie/身份头；刷新过期会话并返回 cookie；Auth 故障不会退回信任缓存身份；同源检查；退出清除 cookie。

生产 HTTP：登录页、错误密码、两个账号登录、受保护账本与脚本、首次加载、真实 PostgreSQL 保存/重放/回读、账号隔离、CSRF 拒绝、退出、伪造内部身份头拒绝。全部测试服务结束后关闭。

验证发现并修复：标准 Next.js 不会自动把 `/ledger` 映射到 `public/ledger/index.html`，现已在完成认证后显式映射。

## 尚需用户完成的测试条件

1. 用国内手机 4G/5G 和常用 Wi-Fi 实测登录、保存、刷新、退出。
2. 实测断网只读、恢复网络、重复点击、备份导出，并在晚高峰复测。
3. 记录失败率和最长等待时间；完成前不能承诺“国内正常访问”。

还需要真实环境审查：Supabase 自定义数据库角色/连接证书、Netlify 函数地域与时限、账号恢复/邮件投递、备份恢复和实际数据迁移。当前实验只实现管理员开通账号后的邮箱密码登录与退出，不包含开放注册或自助找回页面。

因此本报告支持“Netlify + Supabase 技术方案在隔离云端可运行”。当前上线的是测试站，不代表国内网络已经验收或业务正式生产已经完成。
