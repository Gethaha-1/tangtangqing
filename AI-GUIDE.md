> **本分支是 Netlify + Supabase 隔离实验**，不是原 Sites/CloudBase 发布版本。
> 当前实施与验证以 [Netlify/Supabase 部署说明](deploy/NETLIFY-SUPABASE.md) 为准。
> 保留原业务规则；旧托管、D1/SQLite运行和发布指令仅作历史参考，不适用于本分支。
> 禁止向原 Sites 项目发布，禁止合并 main/develop，禁止使用真实账本测试。

# AI 接手手册

适用版本：**v1.5.0 · 严格在线写入**。

## 先读什么

| 任务 | 必读 | 主要位置 |
|---|---|---|
| 趟号、账期、车辆、金额、统计 | `BUSINESS-RULES.md` | `src/domain.js`、`legacy/ledger.html` |
| 在线写入、冲突、原子性 | `ARCHITECTURE.md` §3–5 | `src/cloud-sync.js`、`app/api/sync`、`lib/server/sync-*` |
| 迁移与 JSON | `DATA-MIGRATION.md` | `legacy/ledger.html`、`src/cloud-sync.js` |
| 登录/退出 | `ARCHITECTURE.md` §2 | `app/chatgpt-auth.ts`、`lib/auth/logout.ts`、`worker/` |
| D1 schema | `DATA-MIGRATION.md` | `db/`、`drizzle/` |
| 验证/部署 | `TESTING.md` | `tests/`、`.openai/hosting.json` |

项目含 `.openai/hosting.json`；任何网站发布必须遵守 Sites 构建和托管规范，并复用其中的现有 `project_id`。不要创建第二个项目。

## 红线

1. D1 是业务唯一正式状态。不得把 localStorage、sessionStorage 或内存快照变回权威账本。
2. 离线/服务器不可达时只读。`navigator.onLine` 只是提示，不能作为保存成功或恢复可写的证据。
3. 所有业务写入使用统一 proposal → atomic API → acknowledgement → UI commit；不得先修改全局 `S` 再异步保存。
4. 一个用户动作只发一个原子批次；不要恢复客户端 chunking。收车+收入、删除趟次+子账、JSON 替换必须全成或全不成。
5. 每批携带全部 `expectedVersion` 和稳定 `operationId`。响应丢失时只可重放同 ID、同 payload。
6. 401 回登录；409 保持只读并重新加载；400/422 不得冒充保存成功。
7. 新版本不得写 `tangtangqing-cloud-cache-v1`。它只在升级时检测一次并要求显式处理。
8. theme、当前车辆筛选等设备偏好可离线，不得进入业务同步；历史字段为兼容保留。
9. 认证 UI 只调用 `/auth/logout`。绝不实现或占用 `/signin-with-chatgpt`、`/signout-with-chatgpt`、`/callback`。
10. 身份/车队/角色/分配只由服务端可信头和数据库决定。客户端 ownership 字段一律拒绝。
11. schema 变更同步修改 Drizzle schema、runtime schema、生成 migration、测试和文档。
12. 业务口径以 `BUSINESS-RULES.md` 为准；不要借联网改造改变趟号、账期或金额含义。
13. 恶意备份字段分别经过 `esc()`、`attrEsc()`、`safeIconText()`。
14. `public/ledger/`、`dist/`、`.wrangler/`、`node_modules/` 是生成物，不提交。
15. 禁止向 GitHub 旧项目推送或开 PR，除非用户另行明确改变范围。
16. 快记清单只能是当前页面内的非权威草稿：不得持久化成离线队列，不得逐条上传；最终保存必须保持一趟、一个动作、一个原子批次。未知回执期间不得修改或丢弃待重放 payload。

## 常见改动

### 新增写入口

表单可直接读正式 `S`，但提交必须：

1. `canStartBusinessWrite()`；
2. `submitBusinessMutation(draft => ...)` 只改 clone；
3. 保存中不关闭表单；
4. `result.ok` 后才关闭、toast 成功和重渲染；
5. 失败保留当前表单输入。

若写入口包含“先加入清单”，加入阶段只能修改独立 UI 草稿；最终确认阶段才按以上五步提交。条目 ID 在加入时生成并跨编辑/重试保持稳定；退出/会话锁定、未知回执锁定及重连核对都要有测试。

提交后运行：

```bash
rg -n '\bsave\(\)|Store\.save|S\.(trips|maintenance).*push|deviceCached|resumeCache' legacy/ledger.html
```

不应出现旧乐观写路径。

### 修改同步记录或 D1

先补失败测试，再依次检查：

- `SYNC_TYPES`、输入清洗和 ownership 拒绝；
- client normalize/recordsToState/planSync；
- preflight 授权和 batch projection；
- transaction 内 membership/assignment/version guard；
- D1 trigger/constraint；
- `sync_commits` 幂等回执；
- `npm run db:generate` 的 SQL diff。

### 修改 JSON

必须保留导出与完整恢复。预检至少覆盖摘要、来源、账期合法性、明确替换确认、stable fingerprint、版本冲突和重复导入。非法账期保留当前账期，不得由 `migrate()` 的年度默认值静默替换。

### 修改认证

当前 ChatGPT provider 只存在服务端适配边界。未来手机号等 provider 替换 `/auth/logout` 后端，不改 UI URL。验证安全回跳和 localhost cookie；不要把 token 放进浏览器存储。

## 验证顺序

```text
npm test
→ npm run lint
→ npx tsc --noEmit
→ npm run build
→ /ledger#test
→ TESTING.md 的登录、退出、在线/失败/离线/恢复/401/409/JSON 冒烟
→ git diff --check
→ migration、敏感信息、hosting project_id、生成物审计
```

有部署授权时：提交精确源码 → 推送精确 commit 到 Sites source repository → package → save version → deploy → 轮询终态。部署链路不经过 GitHub。
