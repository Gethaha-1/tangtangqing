# 趟趟清 · 货运趟次云账本

当前版本：**v1.5.0 + Unreleased 本地改进 · 严格在线写入**。

趟趟清面向货运车主和司机，提供多车辆、发车、快记、二次确认收车、补录、账期统计、结构化油费和维修体验。当前实现由服务端 D1 保存正式业务状态；认证边界已经抽象为 provider-neutral `Principal`，但生产实现仍是 Sites/Cloudflare 技术栈。

## 保存与离线边界

- 浏览、统计、详情和 JSON 导出在已加载账本后可离线使用。
- 发车、记账、收车、补录、维修、车辆/科目/账期修改和 JSON 导入必须真实请求服务器。
- 每个用户动作先生成内存提案；只有服务器原子确认整批写入后，页面才替换正式状态并显示成功。
- 请求失败不会把提案写进可自动上传的 localStorage 快照，也不会显示“已保存”。
- `navigator.onLine` 只用于快速切换只读提示；恢复写入前必须重新 POST `/api/bootstrap` 核对身份、车队、权限和版本。
- 每次写入携带 `expectedVersion` 和稳定 `operationId`。超时重试复用完全相同的 ID 与请求，避免双击或响应丢失导致重复入账。

主题可作为全设备偏好；当前车辆筛选、已查看报告和待核对状态只保存在 bootstrap 确认的 `fleet.id + membership.id` scope。未归属的旧 localStorage 不会自动读取或迁移。账号、密码和认证 token 不写入 localStorage。

## 登录与退出

登录首页流程保持不变：已登录时显示“继续到账本”，由用户手动进入 `/ledger`，不自动跳转。

所有认证写动作使用带 Origin/请求标记检查的同源 JSON POST。`/auth/logout` 返回经校验的下一跳；当前 `sites` adapter 再委托 dispatcher-owned `/signout-with-chatgpt`。本地退出只清除 loopback 测试 cookie；`cloudbase` 模式尚未实现，默认 fail closed。

账本“更多”页提供退出登录。退出前会等待进行中的保存；仍有未确认写入时阻止退出并可先导出核对。

## JSON 导出与恢复

本版本继续保留完整 JSON 导出/恢复，schema v3 会守恒核对结构化 fuel 元数据、总升数和逐记录 fingerprint。

只有车主可以导出可完整恢复的车队备份。司机裁剪视图或待核对状态若生成部分数据文件，会明确标记为不可完整恢复；导入端在迁移和差异规划前直接拒绝，避免把未分配车辆误当成应删除数据。

- 导出不写云端，并附带可选来源车队元数据。
- 导入前展示车辆、趟次、收入、支出、维修、结构化/旧油费的数量和金额摘要，明确“完整替换当前账本”。
- 可识别到其他来源车队时会警告，但不会改变登录身份。
- 备份缺失、非法或超过 366 天的账期不会覆盖当前有效账期。
- 导入通过同一个原子在线提交；服务器拒绝、不可达或版本冲突时保持原正式状态。
- 单次超过 500 条变更会在发送前拒绝，避免拆批造成部分恢复；大型导入扩容见 `BACKLOG.md`。

## 本地开发

项目声明 Node.js 22.13 或更高版本；当前本地测试链直接导入 TypeScript，推荐使用 Node.js 24。

```bash
npm install
npm test
npm run lint
npx tsc --noEmit
npm run build
TTQ_AUTH_MODE=local npm run dev
```

打开开发服务器打印的 Local URL。只有显式 `TTQ_AUTH_MODE=local`、development 且 loopback 时才显示本地入口：

- 登录名：`13800000000`（固定测试 Principal）
- 无密码，仅限 `localhost`、`127.0.0.1`、`[::1]`
- HttpOnly、SameSite=Strict、短时测试 cookie

登录后打开 `/ledger#test` 运行浏览器自检。完整验证矩阵见 [TESTING.md](TESTING.md)。

## 结构

```text
app/                    登录页、POST 认证动作、bootstrap/sync API
lib/auth/               provider-neutral 退出与 return_to 校验
lib/server/             edge Principal、安全头、授权、同步与 D1 repository
db/ + drizzle/          D1 schema、运行时建表、正式 migrations
legacy/ledger.html      成熟账本 UI 与浏览器网络适配
src/domain.js           schema v3、fuel 联算、净利润和报告摘要规则
src/cloud-sync.js       v3 状态/记录、fuel 守恒、差异、回执和在线状态机
src/auth-client.js      同源 POST、scope 存储、多标签与 BFCache 会话锁
src/ui-transition.js    共享元素几何、WAAPI 转场与旧浏览器降级
tests/                  业务、XSS、认证、原子写入、迁移测试
```

构建前脚本把 `legacy/ledger.html` 和 `src/domain.js`、`src/cloud-sync.js`、`src/auth-client.js`、`src/ui-transition.js` 复制到 gitignored 的 `public/ledger/`。不要直接修改生成目录。

## 依赖与体积

2026-08-08 本地实验审计快照：

| 范围 | 大小 | 说明 |
|---|---:|---|
| 目标基线 tracked 源码 | 891,830 B（约 0.85 MiB） | 不含安装和构建产物 |
| 本实验源码/文档 | 约 0.88 MiB | 含转场模块、测试与文档修改 |
| 用户原主检出目录 | 约 764 MiB | 其中 `node_modules` 约 758 MiB（99.12%） |
| 当前独立 worktree `node_modules` | 约 763 MiB | 删除候选后干净 `npm ci`；仍主要是 Sites/构建工具链和多平台二进制 |
| 当前 `dist` / `.wrangler` / `public/ledger` | 约 2.0 MiB / 372 KiB / 248 KiB | 都是可再生成且 gitignored 的本地产物 |

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
| `@cloudflare/workers-types` | 无源码/配置引用；干净测试、lint、tsc、build 全通过后已删除，安装约减少 12 MiB |

本轮动画未增加依赖；只删除上述一个证据充分的直接类型依赖，生产构建输出体积不变。

`node_modules`、`dist`、`.wrangler`、`.next`、`public/ledger` 均保持 gitignore，不提交。

## 报告与部署边界

`buildReportSummary()` 已统一账期/月度交集/自然年、车辆、净利润和 fuel 口径，供当前卡片与文字报告共用。定时生成、视频、外部 OpenAI/API、网络 endpoint 和新依赖均未实现。

当前 `.openai/hosting.json`、Vinext Worker、D1 adapter 与 Sites 身份仍属于 Sites/Cloudflare 构建，不能直接上传为腾讯云标准 Node 应用。本地代码尚未完成腾讯适配、部署或合规认证。腾讯上海地域、个人主体小范围封闭非经营试用、纯数字手机号用户名、CloudBase Auth + MySQL 只作为下一批候选方案，需用户确认平台资格、域名/备案、安全和迁移细节后再实施。
