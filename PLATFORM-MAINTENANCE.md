# 双平台维护说明

更新：2026-09-09。Netlify + Supabase 主线代码为 v2.0.0；Sites 归档站继续冻结在 1.6.1。

## 平台与分支

| 范围 | Netlify + Supabase | Sites 归档站 |
|---|---|---|
| 本地目录 | `tangtangqing` | `tangtangqing-sites`（既有 worktree） |
| 分支 | `develop`，唯一持续开发主线 | `stable/sites-1.6.1`，功能冻结在 1.6.1 |
| 运行方式 | Next.js Node Functions | Vinext / Cloudflare Worker |
| 正式数据 | Supabase PostgreSQL，私有 `ttq` schema | Sites 管理的 Cloudflare D1 |
| 认证 | Supabase Auth 邮箱密码 | Sites/ChatGPT 托管认证 |
| 本轮变更 | 运输收入单一口径、货物目录、schema v5、高德服务端定位 | 不移植功能，保持冻结 |
| 运行配置来源 | `netlify.toml`、`deploy/env-vars.md` | 本分支 `.openai/hosting.json` 及 Sites 环境配置 |

CloudBase、腾讯云容器/CFS 均不是当前部署方案；旧版本 changelog 中的候选方案不构成新任务或上线依据。

## 账号和数据不能混用

- 两边登录系统、内部身份、fleet 和数据库独立。相同邮箱或显示名不代表同一账本。
- 没有自动同步、双写、自动故障切换；Sites 不等于 Supabase 的实时备份。
- 显式 JSON 跨平台恢复会完整替换目标车队业务内容，不能当“合并两本账”。先分别导出完整备份、核对唯一数据、摘要和目标账号，再由用户确认恢复。
- 主线 schema v5 继续读取 v1/v2/v3/v4 备份；Sites 1.6.1 不识别 v4/v5 业务字段，不得用它恢复主线新备份。Sites 的 500-operation 恢复限制仍在，也没有主线 IndexedDB 草稿或大型临时导入区。
- 未来主线若升级备份 schema，必须明确兼容范围；不能承诺冻结的旧 Sites 版本可完整读取新字段，更不能伪装成旧格式丢字段。

## 开发与发布

1. 使用既有本地目录，修改前 `git fetch origin` 并比较 `develop...origin/develop`；保留本地领先提交和未提交进度，不重新克隆或重置工作目录。
2. 主线功能只在 `develop` 或其派生分支迭代。完成验证后按根目录 `AGENTS.md` 提交本地 `develop`。未经明确授权，不触碰 `main`。
3. GitHub 是源码备份/协作入口，不是数据库备份。推送前检查是否关联自动部署；没有当前发布授权时，不以“同步分支”为由触发生产上线。
4. Sites 只保留归档、必要说明修正或另获授权的安全修复。不整分支合并主线，不复制 Netlify/Supabase 的认证、SQL、环境变量到 Sites。
5. Sites 的 GitHub 备份与 Sites source repository/publish 是不同步骤。任何重新发布必须重新确认 Sites 目标及访问范围，遵循 Sites 构建/托管流程。
6. 本轮不关闭 Sites、不删除分支或数据库、不修改线上域名/资源、不执行生产迁移。不因测试通过自动获得部署授权。

## 本地测试避坑

- 主线使用 `npm run dev:local`，等待 Ready，保持进程运行，只打开终端实际打印的 Local URL。
- 禁止 `file://` 直开源 HTML；`ERR_CONNECTION_REFUSED` 先检查服务进程，不要换真实账号或关闭认证。
- 浏览器恢复回归使用 `npm run test:browser`：独立临时 SQLite、`127.0.0.1:3107` 精确 Origin、隔离 Chrome profile；不会连接生产或复用你的日常本地账本。
- 两个 worktree 不共用 `node_modules`、构建产物、认证配置或测试数据库。不能拿 Sites 的开发命令启动主线。

## 交付记录

主线本轮代码版本为 2.0.0，Sites 归档应用仍保持 1.6.1，不参与本次发布。Netlify 对应生产库已经授权完成 recovery 和 trip-business 增量，marker 1/2/3 齐全；2.0.0 复用 JSON 字段，不需要新 migration，但需要 Netlify 服务端高德变量。部署状态见 `deploy/NETLIFY-SUPABASE.md`，不能写成“两站已升级”。
