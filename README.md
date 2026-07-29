# 趟趟清 · 货运趟次云账本

当前版本：**v1.5.0 · 严格在线写入**。

趟趟清面向货运车主和司机，保留成熟的多车辆、发车、快记、收车、补录、账期统计与维修体验。Codex Sites D1 是业务数据唯一正式状态；登录使用 Sites 分发层提供的 Sign in with ChatGPT。

## 保存与离线边界

- 浏览、统计、详情和 JSON 导出在已加载账本后可离线使用。
- 发车、记账、收车、补录、维修、车辆/科目/账期修改和 JSON 导入必须真实请求服务器。
- 每个用户动作先生成内存提案；只有服务器原子确认整批写入后，页面才替换正式状态并显示成功。
- 请求失败不会把提案写进可自动上传的 localStorage 快照，也不会显示“已保存”。
- `navigator.onLine` 只用于快速切换只读提示；恢复写入前必须重新 `/api/bootstrap` 核对身份、车队、权限和版本。
- 每次写入携带 `expectedVersion` 和稳定 `operationId`。超时重试复用完全相同的 ID 与请求，避免双击或响应丢失导致重复入账。

主题、当前车辆筛选和已查看报告月份是设备偏好，可离线切换，不参与业务云写入。账号、密码和认证 token 不写入 localStorage。

## 登录与退出

登录首页流程保持不变：已登录时显示“继续到账本”，由用户手动进入 `/ledger`，不自动跳转。

所有认证 UI 使用应用稳定入口 `/auth/logout`。当前服务端 provider 适配器把生产退出委托给 Sites dispatcher-owned `/signout-with-chatgpt`；应用不实现 `/signin-with-chatgpt`、`/signout-with-chatgpt` 或 `/callback`。本地退出只清除 localhost 测试 cookie。

账本“更多”页提供退出登录。退出前会等待进行中的保存；仍有未确认写入时阻止退出并可先导出核对。

## JSON 导出与恢复

本版本继续保留完整 JSON 导出/恢复，供云端保存验证和迁移使用。

- 导出不写云端，并附带可选来源车队元数据。
- 导入前展示车辆、趟次、收入、支出、维修的数量和金额摘要，明确“完整替换当前账本”。
- 可识别到其他来源车队时会警告，但不会改变登录身份。
- 备份缺失、非法或超过 366 天的账期不会覆盖当前有效账期。
- 导入通过同一个原子在线提交；服务器拒绝、不可达或版本冲突时保持原正式状态。
- 单次超过 500 条变更会在发送前拒绝，避免拆批造成部分恢复；大型导入扩容见 `BACKLOG.md`。

## 本地开发

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run dev
```

打开开发服务器打印的 Local URL。localhost 登录页显示“用本地测试账号进入”：

- 测试身份：`local-owner@ttq.test`
- 无密码，仅限 `localhost`、`127.0.0.1`、`[::1]`
- HttpOnly、SameSite=Lax 测试 cookie

登录后打开 `/ledger#test` 运行浏览器自检。完整验证矩阵见 [TESTING.md](TESTING.md)。

## 结构

```text
app/                    登录页、通用退出 route、bootstrap/sync API
lib/auth/               provider-neutral 退出适配与 return_to 校验
lib/server/             身份、授权、原子同步服务与 D1 repository
db/ + drizzle/          D1 schema、运行时建表、正式 migrations
legacy/ledger.html      成熟账本 UI 与浏览器网络适配
src/domain.js           账期、趟号、车辆和统计规则
src/cloud-sync.js       状态/记录转换、差异、回执校验、在线状态机纯核心
tests/                  业务、XSS、认证、原子写入、迁移测试
```

构建前脚本把 `legacy/ledger.html`、`src/domain.js`、`src/cloud-sync.js` 复制到 gitignored 的 `public/ledger/`。不要直接修改生成目录。

## 依赖与体积

2026-07-29 只读审计快照：

| 范围 | 大小 | 说明 |
|---|---:|---|
| 目标基线 tracked 源码 | 约 0.75 MiB | 不含安装和构建产物 |
| 本版非忽略源码/文档 | 约 1.0 MiB | 含本次新增测试、migration 与文档 |
| 用户原主检出目录 | 约 764 MiB | 其中 `node_modules` 约 758 MiB（99.12%） |
| 当前独立 worktree `node_modules` | 约 775 MiB | Next/Vinext、Cloudflare runtime、编译器和多平台二进制 |
| 当前 `dist` / `.wrangler` / `public` | 约 2.0 MiB / 356 KiB / 232 KiB | 都是可再生成且 gitignored 的本地产物 |

因此 700 MiB 量级不是源码体积，也不等于模型需要通读的上下文。

直接依赖审计：

| 依赖 | 用途 / 结论 |
|---|---|
| `next`、`react`、`react-dom` | 页面、App Router、React renderer/RSC peer；生产必需 |
| `drizzle-orm` | D1 runtime 与 schema；生产必需 |
| `vinext`、`vite` | Sites Worker 的开发/构建核心 |
| `@cloudflare/vite-plugin`、`wrangler` | Cloudflare bindings、本地 D1/Worker runtime |
| `@vitejs/plugin-react`、`@vitejs/plugin-rsc`、`react-server-dom-webpack` | Vinext 自动加载的 React/RSC 构建 peers |
| `drizzle-kit` | migration 生成 |
| `typescript`、`@types/node`、`@types/react`、`@types/react-dom` | 类型检查与 TS/TSX |
| `eslint`、`eslint-config-next` | lint |
| `@cloudflare/workers-types` | 当前源码无直接引用，是最明确的精简候选；收益很小，需 clean build 再决定 |

本轮未增加新依赖，也未为小型类型包做高风险低收益清理。

`node_modules`、`dist`、`.wrangler`、`.next`、`public/ledger` 均保持 gitignore，不提交。

## 部署边界

Sites 项目由 `.openai/hosting.json` 中的固定 `project_id` 标识，逻辑 D1 binding 为 `DB`，R2 未启用。GitHub 旧项目不属于本版本发布链路；不要推送或开 PR。
