# Netlify + Supabase 环境变量

线上变量在 Netlify 站点环境中配置，并确保 Node Functions 可读取。不要把真实值写入仓库、截图、日志或前端代码。

## 生产必填

| 变量 | 值/用途 | 安全要求 |
|---|---|---|
| `TTQ_AUTH_MODE` | 固定为 `supabase` | 生产不得使用 `local` |
| `TTQ_DATABASE_MODE` | 固定为 `postgres` | 不允许回退 SQLite |
| `TTQ_SUPABASE_URL` | 当前 Supabase 项目 HTTPS URL | 必须与数据库 project ref 一致 |
| `TTQ_SUPABASE_PUBLISHABLE_KEY` | publishable key；旧项目可兼容 anon key | 不得使用 secret/service-role key |
| `TTQ_INTERNAL_AUTH_SECRET` | 至少 32 字符的独立随机内部边界密钥 | 不与其他站点或数据库密码复用 |
| `TTQ_DATABASE_URL` | `ttq_app` 后端角色的 PostgreSQL 连接串 | 仅服务端；密码需 URL 编码 |
| `TTQ_ALLOWED_ORIGINS` | 当前公开 HTTPS origin；多个值以逗号分隔 | 精确 origin，不带路径或末尾斜杠 |

## 按需配置

| 变量 | 用途 | 说明 |
|---|---|---|
| `TTQ_DATABASE_CA` | 自定义 PostgreSQL 根 CA PEM | 仅在平台证书链需要时设置；不能关闭 TLS 校验 |
| `NODE_EXTRA_CA_CERTS` | Node 额外 CA 文件路径 | 只用于受控运行环境，不把私钥或凭据放入文件 |

Netlify 构建使用 `netlify.toml` 中的 `NODE_VERSION=24` 和 `NEXT_TELEMETRY_DISABLED=1`。它们不是业务身份或数据库配置。

## 仅本地/初始化工具

以下变量只可放在 gitignored 且权限受限的 `.ttq-local.env`，不得上传 Netlify：

| 变量 | 用途 |
|---|---|
| `TTQ_DATABASE_ADMIN_URL` | 空项目初始化或经审核 migration 的管理员连接 |
| `TTQ_TEST_PROJECT_REF` | 初始化/隔离验证前的 project ref 防误投确认 |
| `TTQ_APP_DATABASE_PASSWORD` | 首次创建 `ttq_app` 登录角色的随机密码 |
| `TTQ_CLOUD_TEST_ORIGIN`、`TTQ_TEST_SITE_NAME` | 隔离线上验证目标 |
| `TTQ_TEST_USER_A_EMAIL/PASSWORD`、`TTQ_TEST_USER_B_EMAIL/PASSWORD` | 专用测试账号 |

`npm run dev:local` 会在进程内强制 `local + sqlite`、生成临时内部密钥并使用固定测试车主，不读取云端账本。不要为了本地测试把这些模式配置到 Netlify。

## 生产示例（只示意键名）

```dotenv
TTQ_AUTH_MODE=supabase
TTQ_DATABASE_MODE=postgres
TTQ_SUPABASE_URL=https://PROJECT_REF.supabase.co
TTQ_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_ME
TTQ_INTERNAL_AUTH_SECRET=REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS
TTQ_DATABASE_URL=postgresql://ttq_app.PROJECT_REF:PASSWORD@POOLER_HOST:6543/postgres
TTQ_ALLOWED_ORIGINS=https://YOUR_SITE.example
```

变更任何生产变量前先记录当前部署版本与旧值的安全备份位置；更新后立即验证登录、bootstrap、账号隔离、保存和退出。不得在认证故障时切换成本地模式。
