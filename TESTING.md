# 测试

适用版本：**v2.0.1 · 运费联算、位置清除与直接保存**。自动化使用本地 SQLite 或临时 PostgreSQL 与测试车队；不得用线上真实账本做破坏性验证。

## 1. 自动化与构建

项目 engines 为 Node.js 22.13+；当前测试会直接导入 TypeScript，推荐 Node.js 24。

```bash
npm install
npm test
npm run test:browser
npm run lint
npx tsc --noEmit
npm run build
git diff --check
```

不要在文档硬编码最终测试项数，以命令退出码和当次输出为准。

| 文件 | 重点 |
|---|---|
| `tests/domain.test.js` | schema v5、可选去程分摊、货物目录/快照、返程应收/实收、历史收入去重、fuel 与报告 |
| `tests/location-client.test.mjs` | 浏览器实时坐标、同源地址 API、中国行政市县/直辖市、取消/失败、旧字段兼容 |
| `tests/location-provider.test.mjs` | 高德坐标转换、逆地理编码、数字签名、直辖市与服务商不自动回退 |
| `tests/cloud-sync.test.js` | v5 business/fuel 守恒、expectedVersion、批量快记 diff、回执、严格状态机、JSON 账期安全 |
| `tests/legacy-ui-contract.test.mjs` | 发车/返程清单、本机草稿/单批提交、fuel UI、收车确认、模态栈与失败留层 |
| `tests/auth-client.test.js` | 同源 POST、scope 存储、旧键隔离、BFCache 和多标签锁 |
| `tests/auth-security.test.mjs` | Principal adapter、伪造头、Origin/marker/body limit、安全头、POST-only |
| `tests/ui-transition.test.js` | 共享元素几何、关键帧、源失效、reduced motion、取消/焦点恢复 |
| `tests/server-api.test.mjs` | ownership、fuel repository/bootstrap、原子 guard、本地兼容 constraints/migrations |
| `tests/auth-logout.test.mjs` | Supabase/本地 POST 退出、本地 cookie、安全 `return_to` |
| `tests/legacy-xss.test.mjs` | 恶意备份、fuel/报告新增渲染 sink 的持久化 XSS |
| `tests/draft-recovery.test.mjs` | scope 隔离、原子草稿 CAS、锁定与上传续传 |
| `tests/restore-integration.test.mjs` | 旧版本超过 500 条、万条费用守恒、整批回滚、过期、权限、并发版本保护 |
| `tests/browser/recovery.spec.mjs` | 真实发车/返程/实收 0 云端回读，以及 IndexedDB、刷新恢复、回执丢失、分块续传、跨标签冲突 |

`test:browser` 使用已安装的 Google Chrome、390×844 视口、独立 loopback 3107 和自动清理的临时 SQLite，不读真实 Supabase。3107 必须空闲；不复用用户开发服务器。测试脚本仅在该隔离进程设置精确 `TTQ_ALLOWED_ORIGINS=http://127.0.0.1:3107`，不要复制到生产。浏览器失败产物在 gitignored `test-results/`；模拟断网用例出现预期网络错误日志不代表验收失败。

v2.0.0 浏览器新增：登记去程统一文案、无货主分摊整车运费、同车最近 5 个不重复运费、最近货物、可配置目录、历史收入只读，以及定位成功静默/失败提示。自动化用协议夹具验证高德调用链，不向真实高德接口发送伪造或预存坐标；国内手机的系统权限、真实 GPS 与生产 Key 只做经用户操作的设备验收。

本地 SQLite 兼容 schema 改动另运行 `npm run db:generate`，确认没有意外新 migration；`0002` 保留 fuel 升级，`0003` 增加恢复/revision，`0004` 原位增加两个带 JSON 对象约束的 `business_json` 列。`recovery-schema.test.mjs` 对旧行默认值、约束、触发器幂等与事务回滚做回归。线上 PostgreSQL 分别使用独立 recovery 和 `20260908120000_trip_business.sql` 增量，不能用 SQLite 输出替代。

## 2. 本地认证、POST 与退出

```bash
npm run dev:local
```

默认 UI 回归使用输出的 loopback Local URL，打开 `/` 会自动进入 `/ledger`，无需重复登录。`dev:local` 强制使用固定测试 Principal、本地 SQLite 和进程内随机认证边界密钥；不得改成真实账号或云端账本。直接双击 `legacy/ledger.html` 只应显示本地开发地址说明，不能绕过服务端核验显示账本。

每次本地 UI 回归都按以下顺序执行：

1. 在项目根目录运行 `npm run dev:local`，等待终端显示 `Ready`，测试结束前不要关闭终端或按 `Ctrl+C`。
2. 只打开终端打印的 **Local** 地址；默认是 `http://localhost:3000/ledger`。禁止使用 `file://` 源文件或局域网 **Network** 地址测试本地身份。
3. 确认页面自动显示“本地测试车主”的本地账本，不要求登录，也不读取 Supabase 或真实账本。
4. 修改 `legacy/ledger.html` 或 `src/` 账本脚本后等待终端出现“已更新”提示，再刷新页面检查。
5. 测试完成后才用 `Ctrl+C` 停止服务。

常见现象与处理：

| 现象 | 含义 | 处理 |
|---|---|---|
| `ERR_CONNECTION_REFUSED` / localhost 拒绝连接 | 本地开发进程未启动或已经退出 | 重新运行 `npm run dev:local`，等待 `Ready` 后刷新 |
| “请从本地开发地址打开” | 浏览器直接打开了 `legacy/ledger.html` | 改用终端打印的 Local URL |
| 长时间停在“正在核对会话” | bootstrap 没有完成，不能显示未核验账本 | 查看 `dev:local` 终端错误；不得删除会话锁或伪造身份 |
| Local 端口不是 3000 | 3000 被其他进程占用，Next.js 选择了其他端口 | 使用本次终端实际打印的 Local URL |

以上故障不通过关闭认证、改用真实账号或连接真实数据库来解决。

需要验证登录页、登录 POST 和 Cookie 时，改用 `TTQ_AUTH_MODE=local TTQ_INTERNAL_AUTH_SECRET="$(openssl rand -hex 32)" npm run dev`，并按下列契约检查：

1. 未登录 `/` 只显示本地测试入口，按钮文案使用 `13800000000`；非 loopback、production 或未显式 local 模式不得显示/接受该身份。
2. 本地登录是同源 JSON POST；成功设置 HttpOnly、SameSite=Strict cookie 并进入 `/ledger`。
3. 未登录 `/ledger` 和受保护静态资源不可显示账本；伪造 OAI 或 `x-ttq-auth-*` 头不能登录。
4. `/api/bootstrap`、`/api/sync`、`/auth/logout` 都由客户端 POST；bootstrap GET 返回 405，logout 没有 GET handler。
5. 缺 Origin、跨源、`Sec-Fetch-Site: cross-site`、非 JSON、缺 `X-TTQ-Request` 分别拒绝；chunked body 超过 2 MiB 返回 413。
6. HTTPS 响应有 no-store、安全头和 HSTS；loopback HTTP 不错误发送 HSTS。
7. 退出先锁住并隐藏账本，再 POST `/auth/logout`；请求失败仍保持锁定，只提供受保护的 POST 重试，不恢复旧账或提前跳转。
8. localhost 退出清 Cookie；Supabase 退出由服务端 Auth 动作处理；外部 URL、`//host`、反斜杠、控制字符和认证循环降级 `/`。

## 3. 会话隔离、BFCache 与多标签

1. bootstrap 返回不同 fleet/membership 时生成不同 scope key；A 账号的 cache/conflict/migration/prefs 在 B 账号中不可读。
2. 预置 `tangtangqing-data`、旧 cache 和 migration 键，确认账本启动不读取、不自动上传、不删除或归属给当前账号。
3. `pagehide.persisted` 立即锁定；BFCache `pageshow.persisted` 保持锁定并重新加载/核对，不能直接显示旧 DOM。
4. A 标签退出或收到 401 后，通过 BroadcastChannel/storage epoch 通知 B 标签；B 先锁定并清内存，再导航。
5. epoch 只包含 action/version/random epoch，不含用户、fleet、手机号或业务数据。
6. 退出、401 或换会话后终止活动请求并递增 generation；迟到回执不能提交到新会话。

## 4. 在线提交状态机

1. 提交后显示保存状态并锁定相关业务控件、设置 `aria-busy`。
2. 服务端 200 且完整回执后才显示正式记录和成功 toast。
3. 收车+多笔收入、删除趟次+子账、JSON 恢复各是一批。
4. 相同 `operationId` + 同 payload 重试返回原回执且无重复记录；同 ID + 不同 payload 返回 409。
5. version、membership/role/assignment 或数据库 CHECK 在事务内失败时整批零写入。
6. 400/422 保持在线并保留表单供修正；网络失败切只读；409 保持旧正式状态并要求重新核对。
7. `online` 事件只提示；必须真实 POST bootstrap 成功后才恢复写入。

快记清单另验证：

- 普通费用和结构化油费加入时不调用 Store/API，不提前改正式 `S`，编辑后记录 ID 保持不变；
- 多条保存只调用一次 `submitBusinessMutation()`，计划结果为同一请求内的多条 `trip_expense put`，不产生无关 trip 更新；
- 200 完整回执后才清空并关闭快记两层；400/422 保留且可改，网络失败/409 保留并锁定，重连用原请求核对；
- 最终保存防连点、按钮/层有 `aria-busy` 与 live 状态；清单合计按整数分，顶部计数、修改、移除和底部安全区按钮在日夜主题及窄屏可用；
- 未提交退出需确认暂存；刷新后清单、表达式、备注、fuel、记录 ID 保持一致，未加入清单的输入不能被“保存全部”静默删除；
- 401/退出锁定并清内存，但不删除该 scope 的 IndexedDB 草稿或待核对原请求；重新核验同一身份后才显示，其他账号不可见；
- 存储不可用/配额不足不显示“已暂存”，跨标签 CAS 失败保留新版本并提醒旧页面；
- bootstrap 重连 scope 变化必须锁定旧页面，不向新身份重放旧账号请求；会话锁同时清内存恢复列表和 DOM，但不删除本机持久记录；
- 云端已提交但回执丢失时，刷新后核对原 ID，不产生第二笔；待核对仍可看已核验正式账本，不能继续业务写入。

## 5. 去程、返程与业务草稿

- 三组两项补第三项、来源修改/清空、手工实收 0、草稿刷新后继续联算；移除数字示例且手机顶部可见两个清单操作。
- 去返程可直接保存未加入/加入后修改的最新表单；增重未确认不上传，422 后恢复最新草稿可直接重试，不重复生成趟次或收入。
- 两端定位成功/查询失败后均可清坐标或清空整段；刷新和常用地点回读不带回旧坐标，取消后迟到的 GPS 不查询也不填回。
- 用 6000 元和 1/2/3 箱位验证 1000/2000/3000；用 100 元三等分验证固定 33.34/33.33/33.33。改箱位/总价后立即重算，分摊合计始终守恒到分。
- 抹零不得超过个人分摊，分别核对分摊额/抹零/最终额；抹零不产生支出或债务记录。
- 分组点击加入全部成员；对主货主和普通成员分别执行本趟移除，设置中分组都不变。`+货主` 一次只加一人。
- 用 30.000 吨 × 240.00 验证应收 7200.00；实收空时回退应收，实收 0 时营收为 0，清空后再回退。编辑吨位/单价必须重算。
- 装卸车吨位推导的掉称只是参考；协商扣款不重复减营收。增重未勾选时页面不加入清单，绕过页面时服务端返回 422。
- 吨位/箱位超过 3 位小数、金额超过 2 位、指数、负数和越界都拒绝；`240` 必须解释为 240。
- 逐字段修改只调用 IndexedDB 草稿，不调用业务 API。最终保存每页只调用一次 `submitBusinessMutation`；200 后清草稿，400/409/422/断网/未知回执按契约保留。
- 点击定位不会先弹应用确认，系统权限由浏览器处理；成功后必须自动填入市、区/县且不弹 toast，不支持、拒绝、地址服务失败或超时才提醒，手填与最终保存不受影响。

## 6. 净利润与报告范围

用两车、跨账期/月份/年份夹具验证：

- 单趟利润始终等于该趟收入减趟内支出，不扣维修；
- 单车账期净利润只扣同车同账期维修；全部车辆只扣范围内全部维修；
- 首页主数、统计卡、账期报告、月报和年报的趟次利润/维修/净利润相同；
- 月报范围为自然月与当前账期交集，空交集留在原页并可访问地报错；
- 年报为完整自然年，年份只接受 1000–9999；
- 油费跟随所属已收车趟次 `endDate`，维修跟随自身 `date`；在途趟不进入财务/fuel 摘要。

## 7. Fuel 三项、聚合与数据库

| 场景 | 预期 |
|---|---|
| 总价+单价、总价+升数、单价+升数 | 自动算第三项，返回 canonical 与编辑显示精度 |
| 三项完全一致或差 1 分 | 允许保存 |
| 三项差超过 1 分 | 聚焦错误字段，不能保存/同步 |
| 0、负数、指数、超精度、除零、越界/极端值 | 明确拒绝且不产生部分记录 |
| 普通支出 | 继续使用普通金额盘，不携带 `fuel` |
| 旧 fuel 只有金额 | 总油费计入；升数、均价、极值排除并显示覆盖警告 |
| 编辑结构化/旧 fuel、改科目、删除 | metadata 保留或明确删除，非 fuel 不能夹带 metadata |

还要覆盖快记、支出编辑、显式旧账补录、JSON 导入导出、同步回执、冲突重组、多车辆、跨账期/月/年。断言总油费、总毫升、加权均价、最低/最高、趋势和分车汇总；加权均价应落在有效记录最低/最高之间。

本地 SQLite 兼容层分别验证：

- 新库 schema、本地兼容 `0002` 升级和 runtime 旧表升级约束等价；
- 升级前后旧行数和所有旧字段守恒，新列为 null/null；
- fuel 列成对、范围和 category update 触发器不能绕过；
- repository 写入/回执含 canonical fuel；bootstrap 对部分列、错科目、越界或金额矛盾 fail closed。

## 8. JSON schema v5

1. 导出 envelope 含 schema v5 和 conservation，但不含账号/token。
2. v5 的记录数、整数分、fuel、business 数量/fingerprint 和两套货物目录计数在导入清洗前后及服务器确认后守恒。
3. 顶层 v3/v4/v5 缺 meta、格式/版本不匹配或缺必需 conservation 时直接拒绝，不能伪装成 v2。v3 不要求 business，v4 要求基础 business，v5 还要求货物目录计数。
4. 真正 v1/v2 与完整 v3/v4 可显式导入；缺 fuel 的旧油费保留为 legacy，缺 business 的旧账补空对象，缺货物目录的旧账补内置目录，不伪造分摊/实收。
5. 合法账期经确认恢复；缺失、伪日期、倒序或超过 366 天时保留当前账期。
6. driver 裁剪视图不能导出可完整恢复的车队备份；带 `_ownerRecordsWritable:false`、`driver-visible-partial` 或 `restorable:false` 的文件在迁移/差异规划前拒绝，owner 不能因此删除其他车辆账目。
7. 取消、服务器不可达、400/422/409 时正式状态不变；相同文件重复导入可安全再次执行，同一次失败重试复用原 operationId。
8. 普通 `/api/sync` 仍拒绝超过 500 operations。JSON 恢复通过专用暂存任务处理：每块最多 250 条/128 KiB，最多 256 块、30000 条变更、20 MiB；超限在正式写入前拒绝，不拆成多个正式提交。
9. `postgres-integration.test.mjs` 对 v1/v2/v3 的 200 笔混合账目验证首次恢复、再次恢复、幂等回放和服务器回读金额/fuel 守恒；断言预检没有逐记录数据库调用。
10. HTTP 客户端区分网络中断、500/504、完整回执读取超时；未知回执不得提前提交 UI，重试复用原 operationId。
11. 分块中断、错误指纹、缺块、权限撤销、预览后新增记录、约束失败均不部分替换；重新打开沿用原任务，仅补传缺块。取消/未完成任务过期只清暂存，成功任务只保留幂等元信息，分块随提交清理。
12. 万条费用性能结果只代表本机 PostgreSQL；上线前需用隔离账号复测真实手机、平台执行时限与目标容量。20 MiB 是安全上限，不是生产性能承诺，也不是后台无人值守任务。
13. 完成恢复后若另一设备又记账，摘要不同不重复覆盖；“核对已完成结果”须用户确认并验证服务器 complete，再接受当前正式数据，保留后续新账。

只读核对真实备份：

```bash
node scripts/verify-backup.js /绝对路径/备份.json
```

## 9. 收车、大屏单手与无障碍

在 iPhone Max/普通尺寸以及左右手单手场景验证：

- 首页和详情都显示易触达全宽“确认收车”，源码/DOM 不再有旧收车控件；安全区不遮挡按钮；
- 第一次进入结算，第二次进入嵌套确认 sheet；摘要正确显示车辆、日期、收入、支出、预计利润；
- 零收入有警告但允许继续；返回检查保持已填收入和日期；
- 快速连点只进入一条确认流，最终提交只发一批；保存时按钮锁定且 VoiceOver 读出状态；
- 服务器成功且回执包含 closed trip 后才退出全部层；离线、网络失败、400/409/422 和异常回执都留在确认层；
- 键盘 Tab/Shift+Tab 圈在最顶层模态，底层 view/nav/sheet inert；焦点随逐层返回恢复；Escape、顶部返回和系统返回不越层；
- VoiceOver 核对 dialog 名称、零收入 alert、保存 status、按钮 busy/disabled 和“返回检查”标签。

## 10. 共享元素与移动浏览器

- 趟次卡、更多、车辆、收入/支出/维修、在途快记和收车入口打开/返回时约 390ms 展开并回源；
- 多层 sheet 用顶部返回和系统返回逐层关闭，栈与 History 各只变化一次；
- 左缘返回、顶部下拉完成时不追加第二段回源动画，未过阈值正确复位；
- 快速双击、打开中立即返回、连续返回不重复压栈或越层；
- 来源被重绘、删除、滚出视口或消失时轻缩放淡出且无残留遮罩；
- 日/夜主题、`prefers-reduced-motion` 和无 `Element.animate` 分别验证。

## 11. Netlify + Supabase 部署前检查

- `npm test`、lint、类型检查、`npm run build`、`npm run build:netlify` 和 `git diff --check` 全部通过；
- 目标站点、分支、公开 HTTPS origin 与 Supabase project ref 已人工核对；
- Functions 环境变量完整，生产固定 `supabase + postgres`，没有迁移管理员连接、测试密码或本地模式变量；
- Auth/业务响应保持 no-store，`ttq` 不对 Data API 暴露，`ttq_app` 仍为最小权限角色，数据库 TLS 校验开启；
- 使用专门测试账号验证登录、bootstrap、原子保存、幂等回放、账号隔离和退出；不写真实账本；
- 部署必须得到用户明确授权，测试通过不等于自动获得发布或合并权限。
