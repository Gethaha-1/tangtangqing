# Netlify + Supabase 当前部署说明

## 1. 线上架构

Netlify 托管完整 Next.js 应用，包括页面、Node route handlers、Next.js 认证代理和 `/ledger` 静态资源。Supabase 提供邮箱密码 Auth 与 PostgreSQL。正式业务数据位于 Supabase 的私有 `ttq` schema。

这不是纯静态站：禁止只上传 `public/ledger`，也不能把 `.next` 当作普通静态目录。`netlify.toml` 和 `@netlify/plugin-nextjs` 负责生成 Netlify 所需的静态文件、Node Function 和认证代理产物。

生产强制：

- `TTQ_AUTH_MODE=supabase`
- `TTQ_DATABASE_MODE=postgres`
- Auth 与数据库属于同一 Supabase project ref
- 远程 PostgreSQL 开启并校验 TLS
- `ttq_app` 最小权限后端角色访问不对 Data API 暴露的 `ttq` schema

SQLite、固定测试车主和 `dev:local` 只用于本地 development + loopback，不进入线上运行。

## 2. 发布前验证

使用 `.nvmrc` 指定的 Node.js 版本。每条命令必须退出码为 0：

```sh
npm ci
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run test:http
npm run build:netlify
git diff --check
```

- `npm test` 包含临时真实 PostgreSQL 的迁移、并发、回滚、角色权限和账号隔离测试。
- `test:http` 使用本机 HTTPS Auth 协议夹具与临时 PostgreSQL 跑 Next.js 生产 HTTP，不连接线上项目。
- `build:netlify` 只在本地生成 Netlify 产物，不部署站点。
- 不得把真实账本、管理员连接、数据库密码或测试账号密码写入仓库或构建日志。

## 3. Supabase 配置

首次为空项目初始化时，先复制 `.env.example` 为 gitignored 的 `.ttq-local.env`，只在明确核对 project ref 后运行：

```sh
npm run db:setup:supabase -- --confirm-new-project=项目ref
```

初始化脚本只允许空项目；发现已有 `ttq` schema 或角色会停止。当前已上线数据库不得重新运行初始化 SQL。后续 schema 变化必须新增独立 PostgreSQL migration，先在隔离环境验证约束、RLS、角色权限、数据守恒和回滚，再由用户明确授权应用。

Supabase 侧保持：

- 关闭不需要的开放注册和匿名登录；当前账号由管理员开通。
- `ttq` 不加入 Data API exposed schemas。
- `anon`、`authenticated`、service role 均不直接读写业务 schema；应用后端只用 `ttq_app`。
- Netlify 只保存运行必需的 publishable key 和后端连接；不得上传 Supabase secret/service-role key 或迁移管理员连接。
- Auth Site URL 与允许回跳地址只填写实际 HTTPS 站点，不使用宽泛通配符。

## 4. Netlify 配置

仓库的 `netlify.toml` 是构建来源：

- build command：`npm run build`
- publish：`.next`（由 Next.js adapter 处理，不代表静态发布）
- Node.js：24
- plugin：`@netlify/plugin-nextjs`

运行环境变量必须配置在 Netlify Functions 可用范围；完整清单见 [env-vars.md](env-vars.md)。`netlify.toml` 的 build environment 不能代替 Functions 运行时变量。

不要添加把所有路径改写到 `index.html` 的 SPA 通配规则，也不要公开缓存认证页、API 或带 `Set-Cookie` 的响应。

## 5. 发布方式

优先使用已核对的 Git/分支持续部署。执行发布前必须确认目标 Netlify 站点、目标分支和本次 commit，测试通过不代表自动获得发布授权。

若用户明确要求手动发布，先运行：

```sh
npm run build:netlify
npm run prepare:netlify:deploy
npx netlify deploy --no-build --dir .netlify/static --functions .netlify/functions-internal
```

草稿验收后，只有再次确认要上线时才使用仓库的 `deploy:netlify:prod`。Netlify CLI 在 Git worktree 中可能误判仓库根目录，所以必须核对输出的 Deploy path 与 Functions path；`.netlify/static` 和 `.netlify/functions-internal` 必须来自同一次构建。

## 6. 上线后验证

使用专门测试账号，不用真实账本做破坏性验证：

1. 首页加载，错误密码明确拒绝。
2. 登录后 `/ledger`、脚本和 manifest 正常加载。
3. `/api/bootstrap` 返回正确 fleet/membership，另一个账号看不到该数据。
4. 写入一条可清理的测试记录，核对完整回执、刷新回读和相同 operationId 幂等回放。
5. 验证跨源/伪造身份头被拒绝，退出后受保护页面重新锁定。
6. 清理全部测试记录，并在国内手机网络复测登录、保存、刷新、断网只读和恢复网络。

隔离账号的自动化入口仍为 `npm run verify:cloud -- --confirm-new-project=项目ref`。该脚本会在测试账号 A 中保留一辆“部署验证用测试车辆”供人工检查，运行后需要手动清理；它只能指向明确授权的隔离测试资源，不能直接对真实账本账号运行。

## 7. 回滚与事故处理

- 应用回滚使用 Netlify 已知正常的部署版本，不重建或重置 Supabase 数据库。
- 数据库迁移必须有单独回滚/前滚方案；不得为追平 schema 删除线上数据或重新执行初始化脚本。
- Auth 或数据库异常时保持 fail closed 和只读，不切换本地身份、SQLite 或公开直连。
- 怀疑身份串号、缓存会话或越权时立即停止业务写入，保留日志与部署版本，先核对 Auth、Cookie、project ref 和数据库角色。

迁移期的环境、耗时与隔离站测试数据保存在 [VALIDATION-RESULTS.md](VALIDATION-RESULTS.md)，只作历史证据，不是当前部署配置来源。

## 8. 官方参考

- [Netlify Next.js](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/)
- [Netlify Functions 配置](https://docs.netlify.com/build/functions/optional-configuration/)
- [Supabase Next.js 服务端认证](https://supabase.com/docs/guides/auth/server-side/creating-a-client)
- [Supabase Postgres 连接](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase 数据安全](https://supabase.com/docs/guides/database/secure-data)
