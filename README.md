> 当前线上架构是 **Netlify + Supabase**：Netlify 运行完整 Next.js 应用，Supabase 提供 Auth 与 PostgreSQL。
> 当前部署与运维以 [Netlify/Supabase 部署说明](deploy/NETLIFY-SUPABASE.md) 为准；迁移期验证数据保存在 [历史验证报告](deploy/VALIDATION-RESULTS.md)。
> 本文只描述 `develop` 主线。Sites/Cloudflare D1 的独立 1.6.1 归档站仍保留，但不接收本轮功能；CloudBase 不属于任何当前部署方案。双平台边界见 [PLATFORM-MAINTENANCE.md](PLATFORM-MAINTENANCE.md)。

# 趟趟清 · 货运趟次云账本

当前代码版本：**v1.9.0 · 清单后台上传、装卸市县定位与业务大键盘**。线上发布状态见 [本次交付说明](ITERATION-2-BUSINESS.md)。

趟趟清面向货运车主和司机，提供多车辆、一趟往返、发车货主清单、按箱位分摊去程运费、返程应收/实收与称重、批量快记、二次确认收车、账期统计、结构化油费和维修体验。线上由 Netlify 承载完整 Next.js 应用与服务端 API，Supabase Auth 提供邮箱密码会话，Supabase PostgreSQL 的私有 `ttq` schema 保存正式业务状态。

## 保存与离线边界

- 浏览、统计、详情和 JSON 导出在已加载账本后可离线使用。
- 发车、记账、收车、补录、维修、车辆/科目/账期修改和 JSON 导入必须真实请求服务器。
- 快记可连续把多笔费用加入当前页面的「待保存清单」，修改或移除后再点「保存全部」；清单不是正式账本或离线队列，只有整批收到云端确认才显示成功。
- 发车和返程也采用“本地填写/试算 → 一次原子保存”；不会每输入一个字就上传。本机草稿与账号/车队隔离，失败或回执未知时保留供重试和核对。
- 每个用户动作先生成内存提案；只有服务器原子确认整批写入后，页面才替换正式状态并显示成功。
- 请求失败不会把提案写进可自动上传的 localStorage 快照，也不会显示“已保存”。
- `navigator.onLine` 只用于快速切换只读提示；恢复写入前必须重新 POST `/api/bootstrap` 核对身份、车队、权限和版本。
- 每次写入携带 `expectedVersion` 和稳定 `operationId`。超时重试复用完全相同的 ID 与请求，避免双击或响应丢失导致重复入账。

清单页返回会后台上传已加入的记录，先可靠记录请求再关闭弹层，不等待云端回执；正式账目仍在服务器确认后更新，下次登录随账号加载。底部“放弃修改”只删除本次本机草稿，不上传、不删除云端旧记录。空白或改回原样的表单可直接退出。返程加入后又改动但未重新加入的字段、快记未加入的输入只留本机，不混入上传。

草稿按已核验账号/车队暂存在 IndexedDB。刷新后可在首页继续填写或丢弃；未知回执先查询服务器，再按原操作 ID 核对，不能重复入账。它不是自动上传的离线队列。退出/401 清内存但保留本机草稿供同账号恢复；清除浏览器数据或存储回收会丢失本机暂存。存储失败时不发送业务请求，仍允许用户明确放弃，不强制保存。

去返程金额、吨位、箱位、抹零和掉称用网页大键盘输入。装卸位置的市、区县分栏；“使用当前位置”经本次同意后向 BigDataCloud 查询，缺失项/弱网可手填。定位不发送账号、账目或历史坐标，详见 [业务规则](BUSINESS-RULES.md)。

主题可作为全设备偏好；当前车辆筛选、已查看报告和待核对状态只保存在 bootstrap 确认的 `fleet.id + membership.id` scope。未归属的旧 localStorage 不会自动读取或迁移。账号、密码和认证 token 不写入 localStorage。

## 登录与退出

线上登录使用 Supabase 邮箱密码认证。已登录时首页显示“继续到账本”，由用户手动进入 `/ledger`，不自动跳转。

所有认证写动作使用带 Origin/请求标记检查的同源 JSON POST。Supabase 会话保存在安全 Cookie 中，API 对业务请求重新向 Auth 服务核验用户；浏览器不能用公开身份头选择业务账号。本地退出只清除 loopback 测试 Cookie。

账本“更多”页提供退出登录。退出前会等待进行中的保存；仍有未确认写入时阻止退出并可先导出核对。

## JSON 导出与恢复

本版本继续保留完整 JSON 导出/恢复。schema v4 在 v3 的金额和 fuel 守恒上，新增货主/市场/分组/地点数量及去返程清单 fingerprint；仍能导入 v1/v2 旧文件和带完整 envelope 的 v3 备份。

只有车主可以导出可完整恢复的车队备份。司机裁剪视图或待核对状态若生成部分数据文件，会明确标记为不可完整恢复；导入端在迁移和差异规划前直接拒绝，避免把未分配车辆误当成应删除数据。

- 导出不写云端，并附带可选来源车队元数据。
- 导入前展示车辆、趟次、收入、支出、维修、结构化/旧油费的数量和金额摘要，明确“完整替换当前账本”。
- 可识别到其他来源车队时会警告，但不会改变登录身份。
- 备份缺失、非法或超过 366 天的账期不会覆盖当前有效账期。
- 导入通过同一个原子在线提交；服务器拒绝、不可达或版本冲突时保持原正式状态。
- 完整恢复使用专用临时任务：最多 20 MiB 文件/变更数据、30000 条变更、256 块，每块不超过 128 KiB/250 条；分块只写临时区，最后一个事务生效。普通 `/api/sync` 仍限制 500 条。
- 上传中断后可按原任务续传；最终提交包含整车队版本检查，别的设备新增记录也会阻止覆盖。完成后回读守恒，不能把“分块上传成功”当成“恢复成功”。
- 本机已验证一万条费用的 PostgreSQL 恢复；生产网络、Netlify 时限和手机容量需上线前另行验收。恢复边界见 [第一轮交付说明](ITERATION-1-RECOVERY.md)，新业务清单与待上线项见 [第二轮交付说明](ITERATION-2-BUSINESS.md)。

## 本地开发

项目声明 Node.js 22.13 或更高版本；当前本地测试链直接导入 TypeScript，推荐使用 Node.js 24。

日常开发和测试以长期保留的本地 `develop` 工作目录为基础，不需要每次重新克隆仓库。开始修改前只获取 GitHub 的增量信息并比较本地与 `origin/develop`：远端没有新提交时直接继续本地工作；远端领先时才进行快进同步；本地领先时保留本地进度，完成验证后推送到 `develop`。未经项目所有者明确要求，不得合并或直接修改 `main`。

```bash
npm install
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run dev:local
```

打开开发服务器打印的 Local URL，或直接访问 `http://localhost:3000/ledger`。`dev:local` 会自动进入固定测试车主的本地 SQLite 账本，不需要反复登录；运行期间修改 `legacy/ledger.html` 或 `src/` 下的账本脚本也会自动同步到本地页面。它会忽略云端凭据，并且身份适配层仍只允许 development + loopback 请求。不要直接双击 `legacy/ledger.html`，`file://` 页面没有 Next.js、登录 Cookie 和 `/api/bootstrap`，无法核对账号与车队。

### 本地预览避坑

- 运行 `npm run dev:local` 后，必须等终端显示 `Ready`，并在测试期间保持该进程和终端运行；关闭终端或按 `Ctrl+C` 会停止网站。
- 浏览器必须打开终端打印的 **Local** 地址（通常是 `http://localhost:3000/ledger`）。不要打开 `file://.../legacy/ledger.html`，也不要使用终端打印的局域网 **Network** 地址；本地测试身份按安全规则只接受 loopback。
- 浏览器出现 `ERR_CONNECTION_REFUSED` 或“localhost 拒绝连接”，表示本地服务没有运行，不是账号、车队或数据库错误。回到项目目录重新执行 `npm run dev:local`，看到 `Ready` 后再刷新。
- 直开 HTML 时出现“请从本地开发地址打开”是预期保护；如果通过 Local 地址长时间停在“正在核对会话”，先查看运行 `dev:local` 的终端报错，不得通过删除会话锁或伪造身份来绕过。
- `dev:local` 只使用固定测试车主和 `data/tangtangqing.db`，不得导入或连接真实账本数据。

需要手动检查登录页、登录 POST 和 Cookie 时，使用 `TTQ_AUTH_MODE=local TTQ_INTERNAL_AUTH_SECRET="$(openssl rand -hex 32)" npm run dev`。本地身份为：

- 登录名：`13800000000`（固定测试 Principal）
- 无密码，仅限 `localhost`、`127.0.0.1`、`[::1]`
- HttpOnly、SameSite=Strict、短时测试 cookie

登录后打开 `/ledger#test` 运行浏览器自检。完整验证矩阵见 [TESTING.md](TESTING.md)。

## 结构

```text
app/                    登录页、POST 认证动作、bootstrap/sync API
proxy.ts                Next.js 16 认证代理、受保护账本改写与安全头
lib/auth/               provider-neutral 退出与 return_to 校验
lib/server/             Supabase Principal、安全头、授权与 D1-shaped repository
db/postgres.ts          线上 PostgreSQL 适配器与 SERIALIZABLE 批次
db/sqlite.ts            仅本地开发/兼容测试的 SQLite 适配器
deploy/supabase/        当前 PostgreSQL 初始 schema
legacy/ledger.html      成熟账本 UI 与浏览器网络适配
src/domain.js           schema v4、去返程/fuel 定点联算、净利润和报告摘要
src/cloud-sync.js       v4 状态/记录、业务/fuel 守恒、差异、回执和在线状态机
src/auth-client.js      同源 POST、scope 存储、多标签与 BFCache 会话锁
src/ui-transition.js    共享元素几何、WAAPI 转场与旧浏览器降级
tests/                  业务、XSS、认证、原子写入、迁移测试
```

构建前脚本把 `legacy/ledger.html` 和 `src/domain.js`、`src/cloud-sync.js`、`src/auth-client.js`、`src/ui-transition.js` 复制到 gitignored 的 `public/ledger/`。不要直接修改生成目录。

## 运行依赖

| 依赖 | 用途 / 结论 |
|---|---|
| `next`、`react`、`react-dom` | 页面、App Router、React renderer/RSC；生产必需 |
| `@supabase/ssr`、`@supabase/supabase-js` | Supabase Auth 的服务端会话与用户核验；生产必需 |
| `pg` | PostgreSQL 连接与 D1-shaped 数据访问适配；生产必需 |
| `@netlify/plugin-nextjs` | 把 Next.js 页面、API 和认证代理打包为 Netlify 运行产物 |
| `node:sqlite`、`drizzle-orm`、`drizzle-kit` | 本地测试、旧 SQLite schema 兼容与迁移回归；不作为线上数据库 |
| `typescript`、`@types/node`、`@types/react`、`@types/react-dom` | 类型检查与 TS/TSX |
| `eslint`、`eslint-config-next` | lint |
| `embedded-postgres` | 自动化集成测试使用的临时真实 PostgreSQL；不进入线上运行时 |

`node_modules`、`dist`、`.next`、`public/ledger` 均保持 gitignore，不提交。

## 报告与现行部署边界

`buildReportSummary()` 已统一账期/月度交集/自然年、车辆、净利润和 fuel 口径，供当前卡片与文字报告共用。报告仍仅在本地生成文字；未实现定时报告、视频或外部 AI/API。恢复接口与开发测试依赖的变化见本轮 CHANGELOG。

当前线上只支持 Netlify + Supabase：Netlify 运行 Next.js 页面、Node API 与认证代理；Supabase Auth 负责账号会话，Supabase PostgreSQL 保存 `ttq` 私有 schema。生产配置强制 `TTQ_AUTH_MODE=supabase` 与 `TTQ_DATABASE_MODE=postgres`，不会回退本地身份或 SQLite。部署、环境变量和验证流程见 [deploy/NETLIFY-SUPABASE.md](deploy/NETLIFY-SUPABASE.md) 与 [deploy/env-vars.md](deploy/env-vars.md)。
