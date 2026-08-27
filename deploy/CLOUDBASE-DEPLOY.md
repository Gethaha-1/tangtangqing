# 部署到 CloudBase 云托管（容器 + CFS）

本文档说明如何把这个 Next.js（App Router）货运账本应用，作为 **CloudBase 云托管容器** 部署，
并用 **CFS 文件存储** 持久化 SQLite 数据库（`node:sqlite`，零原生依赖，无需 better-sqlite3）。

> 适用范围：本仓库已从 Cloudflare Workers 迁移到 CloudBase。原 `worker/index.ts` 已由
> `middleware.ts`（Next.js Edge 中间件）取代；数据库由 `node:sqlite` 兼容层驱动。

---

## 1. 创建 CloudBase 环境

1. 登录 [CloudBase 控制台](https://console.cloud.tencent.com/tcb)。
2. 新建环境（云开发），按量计费版或基础版均可（低频自用几乎在免费额度内）。
3. 记录环境 ID（`envId`），后面配置 `TTQ_CLOUDBASE_ENV_ID` 会用到。

## 2. 开通 CloudBase Auth 的微信登录

1. 在控制台进入 **身份认证**（或「用户管理 / 登录授权」）。
2. 启用 **微信登录**，按提示填入你的 **微信公众平台 / 开放平台 AppID** 与回调域名。
3. 回调域名填云托管服务对外域名（第 3 步创建服务后会得到）。

> 这一步只是让 CloudBase 具备「微信身份源」。真正把身份注入应用有两种方式，见第 5 步。

## 3. 新建云托管服务（容器 + CFS）

1. 进入 **云托管**，新建服务，部署方式选 **容器**。
2. 上传本仓库源码（或关联代码仓库），构建使用仓库根目录的 **`Dockerfile`**（已就位）。
   - 镜像基于 `node:22-bookworm-slim`，`node:sqlite` 是 Node 22.13+ 内置，构建无需编译工具。
3. 在 **服务配置 → 存储** 里 **挂载 CFS 文件存储到 `/data`**（读写）。
   - SQLite 库文件 `TTQ_SQLITE_PATH=/data/tangtangqing.db` 就落在 CFS 上，
     容器重建 / 扩容后数据不丢。
4. 端口填 `3000`（Dockerfile 里 `EXPOSE 3000`，运行时用 CloudBase 注入的 `PORT` 启动）。
5. 配置环境变量（见 `env-vars.md`），至少填：
   - `TTQ_AUTH_MODE=cloudbase`
   - `TTQ_INTERNAL_AUTH_SECRET=$(openssl rand -hex 24)`（≥32 位随机串，边界闸门）
   - `TTQ_SQLITE_PATH=/data/tangtangqing.db`
   - `NODE_ENV=production`

## 4. 配置环境变量

详见同目录 `env-vars.md`。生产环境务必把 `TTQ_CLOUDBASE_SIMULATE` 留空（非 `1`）。

## 5. 关于账户识别（已实现：云网关身份认证 + 受信任请求头）

应用通过 CloudBase 云托管 **HTTP 身份认证** 识别「当前请求是谁」，已从代码层面实现：

- 在云托管服务开启 **身份认证**，选择 **微信**。
- 由 **CloudBase 网关**在请求到达应用前完成微信登录校验，并把登录用户身份注入
  **受信任的请求头** `x-cloudbase-context`（Base64(JSON)，含稳定 `uid`；另有
  `x-wx-openid` / `x-wx-unionid`）。
- 应用在 `middleware.ts`（Edge 中间件）里读取这个 **由网关注入、外部无法伪造** 的头，
  解码出 `uid` 后铸造内部账户头（`x-ttq-auth-*`），再交给下游业务。
  - 不加载任何 Node SDK、不持有微信密钥，身份校验在网关闭环，最省事也最安全。
  - `middleware.ts` 在铸造后会**主动剥离**原始 `x-cloudbase-*` 头，避免被转发或重放。
- 未携带有效网关上下文的请求一律 `unauthenticated`（fail-closed）。

> 登录按钮（`/` 页「使用微信登录」）指向 `/auth/cloudbase/login?return_to=/ledger`，
> 生产模式下该路由直接把浏览器带到受保护路径 `/ledger`，由网关接管微信登录；
> 登录成功后网关回注 `x-cloudbase-context`，应用即可识别身份。无需自建 OAuth。

## 6. 本地联调（sim 模式）

不连真实 CloudBase，也能完整跑通微信登录链路（模拟网关注入身份）：

```bash
TTQ_AUTH_MODE=cloudbase TTQ_CLOUDBASE_SIMULATE=1 \
TTQ_INTERNAL_AUTH_SECRET=$(openssl rand -hex 24) TTQ_SQLITE_PATH=:memory: \
npm run dev
```

然后：

1. 浏览器打开登录页 → 点「使用微信登录」。
2. 访问模拟回调
   `/auth/cloudbase/login?return_to=/ledger&uid=u123&name=张师傅`
   即可以 `u123 / 张师傅` 的身份进入账本。

> `TTQ_CLOUDBASE_SIMULATE=1` 让 `verifyCloudbaseIdentity` 跳过真实 token 校验，
> 直接信任模拟参数。生产环境**务必**去掉该变量。

## 7. 费用说明

- **云托管**：按量计费，低频自用几乎在免费额度内。
- **CFS 文件存储**：极便宜，仅按实际占用空间计费；本应用 SQLite 库很小。
- **数据库费**：无（SQLite 文件直接落在 CFS，不额外买云数据库）。
- 微信登录：CloudBase Auth 基础额度内免费。

## 8. 上线前需你在控制台完成的动作（非代码改动）

代码层面微信登录链路已完整实现并通过模拟链路 + 单元测试验证；以下为**控制台侧**的一次性配置，
完成后即可真实使用：

- **开启云托管 HTTP 身份认证并选择微信**：在云托管服务的访问配置里开启「身份认证」，
  绑定你的 **微信公众平台 / 开放平台 AppID**，并把云托管对外域名填为回调域名。
  - 这一步决定网关是否会注入 `x-cloudbase-context`；不开启则所有请求都会 `unauthenticated`。
- **确认网关注入头字段名**（以控制台实际为准）：代码默认读取 `x-cloudbase-context`
  （Base64(JSON) → `uid`），并以 `x-cloudbase-uid` 作为兜底。若你的环境实际注入的是别的头名，
  在 `lib/server/cloudbase-auth.ts` 的 `CLOUDBASE_GATEWAY_HEADERS` 调整即可。
- **生产务必移除 `TTQ_CLOUDBASE_SIMULATE`**（联调专用，开启后任何人可伪造身份）。

> 已知限制：网关注入的 `x-cloudbase-context` 主要提供稳定 `uid`；若其中不含昵称，
> 应用会以 `uid` 作为展示名（首登自动建车队时使用）。如需更友好昵称，可在控制台
> 补充用户资料字段或在网关配置中确认是否注入昵称。

---

## 构建/运维速查

- 构建：`docker build -t tangtangqing .`（本地验证 Dockerfile 用）
- 本地起容器：`docker run -p 3000:3000 -e PORT=3000 -e TTQ_AUTH_MODE=cloudbase -e TTQ_INTERNAL_AUTH_SECRET=$(openssl rand -hex 24) -e TTQ_SQLITE_PATH=/data/tangtangqing.db -v ttq-data:/data tangtangqing`
- 健康检查：访问 `/` 应返回 200；受保护路径 `/ledger` 未登录会跳回首页。
