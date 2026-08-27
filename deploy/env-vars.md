# 环境变量清单（CloudBase 云托管）

所有变量在云托管「服务配置 → 环境变量」中设置。下方「必填」指生产部署所需。

## TTQ_* 业务变量

| 变量 | 必填 | 含义 | 示例 |
| --- | --- | --- | --- |
| `TTQ_AUTH_MODE` | **必填** | 认证模式，固定为 `cloudbase` | `cloudbase` |
| `TTQ_INTERNAL_AUTH_SECRET` | **必填** | 内部身份边界闸门密钥，≥32 位随机串。**切勿与他人共享、勿提交进仓库** | `openssl rand -hex 24` |
| `TTQ_SQLITE_PATH` | 生产**必填** | SQLite 库文件路径；生产指向 CFS 挂载点 | 生产：`/data/tangtangqing.db`；本地默认：`data/tangtangqing.db`（可省略） |
| `TTQ_CLOUDBASE_ENV_ID` | **不再需要** | 旧版「应用内 SDK 校验 token」方案才需要；当前已实现「网关注入身份」方案，应用只读网关注入的 `x-cloudbase-context` 头，**无需此变量** | — |
| `TTQ_CLOUDBASE_SIMULATE` | 仅联调 | 设为 `1` 时跳过网关注入，直接信任 `sim:<uid>:<name>` 模拟参数。**生产务必留空** | `1`（本地联调）/ 空（生产） |
| `TTQ_ALLOWED_ORIGINS` | 可选 | 跨域白名单，逗号分隔；不填则允许请求自身来源 | `https://a.example.com,https://b.example.com` |

## 运行环境变量

| 变量 | 必填 | 含义 | 示例 |
| --- | --- | --- | --- |
| `NODE_ENV` | 生产建议 | 运行模式；生产设 `production` | `production` |
| `PORT` | 由云托管注入 | 容器监听端口，CloudBase 自动注入，**勿手填** | （云托管注入，本地可 `-e PORT=3000`） |

## 生成密钥示例

```bash
# 生成内部边界密钥（≥32 位）
openssl rand -hex 24
# 例：9f2c1e7b4a8d6c0e3f5a2b1d7c4e9f0a1b2c3d4e5f6a7b8
```

## 最小生产配置

```bash
TTQ_AUTH_MODE=cloudbase
TTQ_INTERNAL_AUTH_SECRET=<openssl rand -hex 24 的输出>
TTQ_SQLITE_PATH=/data/tangtangqing.db
NODE_ENV=production
# 不要设置 TTQ_CLOUDBASE_SIMULATE
# TTQ_CLOUDBASE_ENV_ID 已不再需要（网关注入身份方案）
# PORT 由云托管注入
```

## 说明

- `TTQ_INTERNAL_AUTH_SECRET` 用于中间件铸造的内部身份头做 HMAC 式边界校验
  （见 `lib/server/auth.ts` 的 `auth_boundary_invalid`）。它是应用自身的「防伪印章」，
  与外部身份提供方（微信 / CloudBase）是否启用无关，生产**必须**设置且足够随机。
- `TTQ_CLOUDBASE_SIMULATE=1` 仅用于本地/联调；一旦进入生产，移除该变量，
  否则任何人都可伪造身份参数。
- 已实现的「网关注入身份」方案（见 `CLOUDBASE-DEPLOY.md` 第 5 步）：应用在 Edge
  中间件里读取云托管网关注入的 `x-cloudbase-context`（Base64(JSON)，含 `uid`），
  **不**调用 `@cloudbase/node-sdk`、不持有微信密钥。`TTQ_CLOUDBASE_ENV_ID` 因此无需设置。
