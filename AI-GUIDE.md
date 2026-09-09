# AI 接手手册

当前线上架构为 Netlify + Supabase。开始任务前先读根目录 `AGENTS.md`；未经项目所有者当前任务明确授权，不得合并或直接修改 `main`。

## 先读什么

| 任务 | 必读 | 主要位置 |
|---|---|---|
| 去返程、货主分组、运费、趟号、账期与统计 | `BUSINESS-RULES.md` | `src/domain.js`、`legacy/ledger.html` |
| 在线写入、冲突、原子性 | `ARCHITECTURE.md` §5–6 | `src/cloud-sync.js`、`app/api/sync`、`lib/server/sync-*` |
| 迁移与 JSON | `DATA-MIGRATION.md` | `legacy/ledger.html`、`src/cloud-sync.js` |
| 登录与退出 | `ARCHITECTURE.md` §3 | `app/current-user.ts`、`lib/server/supabase-*`、`lib/auth/logout.ts` |
| PostgreSQL schema | `ARCHITECTURE.md` §4 | `deploy/supabase/001_ledger.sql`、`db/postgres.ts` |
| 本地兼容 schema | `DATA-MIGRATION.md` | `db/sqlite.ts`、`db/runtime-schema.ts`、`drizzle/` |
| 验证与部署 | `TESTING.md`、`deploy/NETLIFY-SUPABASE.md` | `tests/`、`netlify.toml` |

## 当前平台边界

- 线上只支持 `TTQ_AUTH_MODE=supabase` 和 `TTQ_DATABASE_MODE=postgres`。
- Netlify 托管完整 Next.js 应用；不能只上传 `public/ledger`。
- Supabase Auth 与 PostgreSQL 必须属于同一项目；浏览器不直连 `ttq` 私有 schema。
- 本地 UI 使用 `npm run dev:local`、固定测试 Principal 和 SQLite；禁止用真实账号或真实账本做回归。
- Sites/Cloudflare D1 已退出 `develop` 的代码路径，但 `stable/sites-1.6.1` 仍作为独立归档站保留；它不是同步开发分支。CloudBase 和容器/CFS 已退出现行方案。先读 `PLATFORM-MAINTENANCE.md`，不得跨平台复制认证、数据库或部署配置。

## 红线

1. Supabase PostgreSQL 是线上唯一正式业务状态；不得把 localStorage、SQLite 或内存快照变成线上权威账本。
2. 离线或服务器不可达时只读。`navigator.onLine` 不能作为保存成功或恢复可写的证据。
3. 所有业务写入使用 proposal → atomic API → acknowledgement → UI commit，不得先修改正式 `S`。
4. 一个用户动作的正式业务变更只在一个原子事务内生效；收车+收入、删除趟次+子账、批量快记、JSON 替换必须全成或全不成。恢复分块只允许写隔离临时区。
5. 每批携带完整 `expectedVersion` 和稳定 `operationId`；响应丢失时只可重放同 ID、同 payload。
6. 401 锁定会话；409 保持只读并重新加载；400/422 保留表单且不得显示成功。
7. 身份、车队、角色和车辆分配只由服务端 Auth 核验与数据库决定；客户端 ownership 字段一律拒绝。
8. 不使用邮箱、显示名或可编辑 user metadata 作为业务授权键。
9. Supabase secret/service-role key、数据库连接串、迁移管理员连接和测试密码不得进入浏览器、仓库或日志。
10. 远程 PostgreSQL 必须校验 TLS，不得设置 `rejectUnauthorized:false`。
11. 线上 schema 变更先审查 `deploy/supabase/001_ledger.sql` 的后续迁移方案、约束、角色、RLS、测试和回滚；不能只改本地 Drizzle/SQLite 文件。
12. 快记清单、未加入输入和待核对请求可按 bootstrap scope 存入 IndexedDB；不是正式账本或自动离线队列。先完成本机事务再发请求，未知回执期间不得改 payload；恢复先查原回执，确认前不得删除关联草稿。多标签使用 revision CAS，不能覆盖较新草稿。
13. 恶意备份字段分别经过 `esc()`、`attrEsc()`、`safeIconText()`。
14. `public/ledger/`、`.next/`、`.netlify/`、`dist/`、`node_modules/` 和本地数据库是生成物，不提交。
15. 任何发布、环境变量更新或真实数据操作都需要用户明确授权，并先核对目标站点和 Supabase project ref。
16. schema v5 的 `business_json` 必须由客户端预览、服务端用定点整数重算。日常运输收入只从去程/返程清单写入，普通同步拒绝 `trip_income put`；历史行只读且不得与结构化营收重复计入。实收 `null` 和数字 `0` 不得合并。
17. 高德 Web 服务 Key 只存在 Netlify Functions 环境；浏览器只能调用已登录的同源定位 API。服务商失败时不得把坐标自动转发另一家，日志不得包含 Key 或精确坐标。

## 常见改动

### 新增写入口

1. 先调用 `canStartBusinessWrite()`。
2. `submitBusinessMutation(draft => ...)` 只修改 clone。
3. 保存期间不关闭表单。
4. 只有 `result.ok` 才关闭、提示成功并重绘。
5. 失败保留表单；未知回执走原请求核对。

若入口包含“先加入清单”，加入阶段只能修改独立 UI 草稿；最终确认才提交。条目 ID 必须跨编辑和重试保持稳定。去程与返程逐字段不得上传；只有页面最终保存将目录和趟次业务清单放进同一个 proposal，不得再创建兼容收入行。

### 修改同步记录或数据库

先补失败测试，再依次检查：

- `SYNC_TYPES`、输入清洗和 ownership 拒绝；
- client normalize、recordsToState、planSync；
- preflight 与事务内 membership/assignment/parent/version guard；
- PostgreSQL schema/约束/RLS/最小权限角色；
- `supabase/migrations/` 的增量迁移、整车队 revision triggers 与恢复任务的事务内状态守卫；
- SQLite 兼容约束是否仍与线上语义一致；
- `sync_commits` 幂等回执和 SERIALIZABLE 冲突；
- 部署迁移与回滚说明。

### 修改认证

生产入口只有 Supabase。继续使用服务端核验和安全 Cookie，不把 token 放进 localStorage，不从请求正文或公开身份头选择用户。本地身份必须继续限制在 development + loopback。

### 修改 JSON

保留导出与完整恢复，覆盖来源、账期、摘要、stable fingerprint、owner/driver 范围、版本冲突、重复导入和服务器回读守恒。

## 验证顺序

```text
npm test
→ npm run lint
→ npx tsc --noEmit
→ npm run build
→ npm run build:netlify
→ npm run test:browser（独立临时 SQLite、固定 loopback，不用真实账本）
→ npm run dev:local + /ledger#test
→ TESTING.md 的认证、在线/失败/离线/恢复/401/409/JSON 冒烟
→ git diff --check
→ migration、敏感信息、生成物和部署目标审计
```

部署操作按 `deploy/NETLIFY-SUPABASE.md` 执行。不得沿用历史 Sites 或 CloudBase 发布步骤，也不得因为测试通过就自行部署或合并分支。
