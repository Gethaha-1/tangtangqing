# 趟趟清 v1.5.1 · Netlify + Supabase 验证分支

## 隔离边界

- 分支：`codex/netlify-supabase-validation`，基于已提交的 `develop@21b57e2`。
- 独立目录：`/Users/chenrui/Documents/tangtangqing-netlify-supabase`。
- 不包含原 develop 未提交的 workbench 账号改动；不合并 develop/main，不推送或发布原站。
- 仅本分支删除 `.openai/hosting.json` 的旧 Sites 关联，防止误部署。
- 本实验必须新建 Supabase 测试项目和 Netlify 测试站，不能复用唯一正式账本。

## 架构与范围

Netlify 托管完整 Next.js 应用（页面 + Node Functions + 身份中间件），Supabase 托管 Auth 和 PostgreSQL。不是把 `public/ledger` 当作独立静态网站上传。

保留账本 UI、同源 `/api/bootstrap`、`/api/sync`、`/auth/logout` 以及严格在线状态机。业务层的 D1-shaped 接口由 PostgreSQL 适配器实现：参数转换、整数精度、SERIALIZABLE 原子批次、约束和冲突处理。旧 SQLite schema 与迁移仅用于原行为回归；新 PostgreSQL schema 由 `deploy/supabase/001_ledger.sql` 明确定义。

本阶段只提供已开通邮箱账号的密码登录和退出。Supabase 控制台创建测试账号，用户 metadata 可设置 `display_name`。没有新增开放注册、短信、自助找回密码界面；正式给更多用户使用前需设计这些流程并配置自有 SMTP。不要关闭邮箱校验或开启 CloudBase 模拟登录。

### 身份与数据安全

- 浏览器只向本网站发送同源 JSON POST；token 存在 HttpOnly cookie，不放 localStorage。
- API 自己通过 Supabase `getUser` 核验身份，不依赖能被伪造的客户端身份头。API 自行回写刷新 cookie，避免中间件与 API 重复跨境鉴权。
- `ttq` 是不对 Data API 暴露的私有 schema；所有业务表启用 RLS，只有 `ttq_app` 后端角色获准读写。浏览器的 anon/authenticated、service_role 均没有该 schema 权限。
- 这里的 RLS 是后端专用访问控制，车队/司机行权限仍由现有服务端授权执行，不宣称浏览器直连可按租户隔离。
- 本分支在生产模式及 Netlify 上只允许 `supabase` 认证和 `postgres` 数据模式；不允许无配置时回退 SQLite/本地测试用户。
- 数据库 TLS 校验证书，不能设置 `rejectUnauthorized:false`。可通过 `TTQ_DATABASE_CA` 提供根证书。
- 保留 expectedVersion、operationId、整批回滚；串行化冲突返回 409，不静默重试或显示成功。
- `/api/deployment-info` 只公开实验标识与非敏感 project ref，供测试脚本防止误投。数据库连接必须与 Auth 属于同一 Supabase 项目。
- Netlify 与 Supabase 账户均开启 MFA；只授予实验仓库/分支所需权限。Supabase Auth 设置登录频率限制，正式发布前审查密码策略、日志和找回流程。

## 本地验证

使用 Node.js 24（`.nvmrc`）。每条命令须退出码为 0：

```sh
npm ci
npm test
npm run lint
npx tsc --noEmit
npm run test:http
npm run build:netlify
git diff --check
```

- `npm test` 保留原自动化，并新增真实 PostgreSQL 17.7 引擎的迁移、约束、并发、回滚、司机授权、角色权限测试。
- 测试数据库由 `embedded-postgres` 创建在随机临时目录，只监听 loopback，结束即清理。安装器版本带 beta 标签但测试使用实际 PostgreSQL 引擎；不是生产数据库组件。
- `test:http` 运行真正的 Next.js 生产构建 + PostgreSQL。Auth 使用本机 HTTPS 协议夹具和官方 Supabase SDK，并明确不是 Supabase 云端验证。需要本机 `openssl`。
- `build:netlify` 是官方 Netlify CLI 离线构建和 Functions/Edge 打包，不创建或部署站点。

本仓库若通过 `git worktree` 检出，工作树根目录的 `.git` 是文件而非目录。Netlify CLI 27.4.0 在这种情况下可能继续向上查找其他 `.git` 目录，把发布根目录解析到错误位置。部署前必须检查 CLI 显示的 `Deploy path` 和 `Functions path`；本地工作树验证使用显式目录：

```sh
npm run build:netlify
npm run prepare:netlify:deploy
npx netlify deploy --no-build --dir .netlify/static --functions .netlify/functions-internal
```

`.netlify/static` 是插件完成构建后恢复的最终公开目录，包含 `public/` 与 `_next/static`；`.next` 只用于 Next.js 服务器构建，不能作为独立手动部署的公开目录。也可直接运行 `npm run deploy:netlify:draft`，草稿确认后运行 `npm run deploy:netlify:prod`。

正常 Git 克隆和 Netlify Git 持续部署不需要这个工作树兼容参数。不要在路径未核对时直接发布。

## 新 Supabase 测试项目

1. 创建一个全新项目。region 选择 Singapore；记录 project ref。免费方案仅用于验证，不作为可用性保证。
2. 复制 `.env.example` 为 `.ttq-local.env`，保持 gitignored。项目脚本通过 Node 的 `loadEnvFile` 读取它，避免 Netlify Next.js Runtime 把标准 `.env.local` 自动打入服务器函数。设置新的 Supabase URL、publishable key 和随机内部密钥。
3. 从 Supabase Connect 对话框取得管理连接（Session pooler 5432 或 direct），只放本机 `TTQ_DATABASE_ADMIN_URL`。设置 `TTQ_TEST_PROJECT_REF` 和至少32字符随机 `TTQ_APP_DATABASE_PASSWORD`。
4. 明确确认仅针对这个新项目后运行：

```sh
npm run db:setup:supabase -- --confirm-new-project=你的测试项目ref
```

安装器核对 project ref，并拒绝已存在 `ttq` schema/角色的项目，不删除或覆盖现有数据。迁移凭据不应出现在 Netlify。

5. 从 Connect 信息配置 `TTQ_DATABASE_URL`，将用户改成专用角色 `ttq_app`。若使用 Supavisor pooler，用户名通常是 `ttq_app.PROJECT_REF`，密码是上一步生成的专用密码；以控制台及实际连接测试为准。密码要 URL 编码。使用 transaction pooler 6543 时不使用 named prepared statements。
6. 保持 `ttq` 不在 Supabase exposed schemas 中。迁移创建 NOLOGIN 最小权限角色后，安装器为它设置登录密码。
7. 在 Auth 设置中关闭允许新用户注册（Allow new users to sign up），保持匿名登录关闭。然后在 Authentication → Users 创建两个仅用于测试的邮箱账号，确认邮箱已验证。不要导入原用户或原账本。

## 新 Netlify 测试站

1. 新建站点，只部署 `codex/netlify-supabase-validation`；不要关联到原站。
2. build command `npm run build`，publish directory `.next`。使用仓库的 `netlify.toml` 和已锁定的 Next.js adapter。
3. 环境变量设置为 Functions 可访问（需构建的变量也给 Builds scope）：

| 变量 | 用途 |
|---|---|
| `TTQ_AUTH_MODE=supabase` | 只启用新认证 |
| `TTQ_DATABASE_MODE=postgres` | 只启用远端数据库 |
| `TTQ_SUPABASE_URL` | 新测试项目 URL |
| `TTQ_SUPABASE_PUBLISHABLE_KEY` | publishable 或 legacy anon key，不允许 secret/service_role key |
| `TTQ_INTERNAL_AUTH_SECRET` | 新生成的至少32字符随机密钥 |
| `TTQ_DATABASE_URL` | 专用 ttq_app 数据库连接，仅后端 |
| `TTQ_ALLOWED_ORIGINS` | 精确的 HTTPS 测试站 origin，不带末尾斜杠 |
| `TTQ_DATABASE_CA` | 可选的数据库根 CA |

`netlify.toml` 的 build.environment 不能代替 Functions 运行时变量。不要把迁移管理员连接、管理员密码或测试用户密码上传到站点环境。

4. 在 Supabase Auth 的 URL 设置中填入测试站 Site URL，只添加实际需要的回跳 URL，不使用宽泛通配域名。
5. 检查 Netlify Functions region。新站默认可能在美国；选择与 Supabase 同地域能减少数据库往返延迟。可自选 region 的套餐限制以 Netlify 当前控制台为准，文档列出该能力需要 Pro/Enterprise。若仍是跨洲链路，必须测真实保存时间，不能用本地性能代替。
6. 检查当前 Functions 执行时限、连接池额度；大批次导入最多500操作，迁移保留原边界，跨洲大量 SQL 往返可能超时。未完成真实负载验证前不要批量迁移正式账本。
7. 关闭任何公开缓存认证页面/API 的规则。保留响应 no-store；不要设置把所有路径重写成 index.html 的 SPA 通配规则。

## 真实云端验证（目前须由真实测试资源完成）

在本机 `.ttq-local.env` 中额外设置，勿提交或上传：

```dotenv
TTQ_TEST_PROJECT_REF=你的新项目ref
TTQ_TEST_SITE_NAME=你的新Netlify站点名
TTQ_CLOUD_TEST_ORIGIN=https://你的新Netlify站点名.netlify.app
TTQ_TEST_USER_A_EMAIL=测试邮箱A
TTQ_TEST_USER_A_PASSWORD=测试密码A
TTQ_TEST_USER_B_EMAIL=测试邮箱B
TTQ_TEST_USER_B_PASSWORD=测试密码B
```

```sh
npm run verify:cloud -- --confirm-new-project=你的测试项目ref
```

脚本先通过 `/api/deployment-info` 核对服务器实际使用的新项目，再检查两个空账本，登录后在账号A写一条测试车辆，验证幂等回放、回读、账号B隔离及退出；不导入真实数据。A会保留这条测试记录供检查，重新验证请使用新的空测试账号。

之后必须在国内手机4G/5G、Wi-Fi和晚高峰验证：登录、保存、刷新、断网只读、恢复网络、重复点击、备份导出。没有完成这部分，不能宣称国内访问稳定或生产可用。

## 上线前仍需做的工作

- 隔离 Netlify + Supabase 云端端到端已经通过；仍需国内移动网络和常用 Wi-Fi 验证。
- 备份计划及恢复演练（Supabase免费方案会因低活跃暂停；默认SMTP不适合正式用户）。
- 新旧身份的迁移安排：新 Supabase UID 不等于旧 Sites/CloudBase subject。真实账本只能在核对账号后显式导入 JSON，不按邮箱自动合并身份。
- 自助找回/注册/邀请和邮件投递若需要，另行完成；当前只支持管理员开通账号。
- 隐私说明、用户授权、数据存储地域及适用合规评估。

## 官方参考

- https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/
- https://docs.netlify.com/build/functions/optional-configuration/
- https://supabase.com/docs/guides/auth/server-side/creating-a-client
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/auth/auth-smtp
- https://supabase.com/pricing
