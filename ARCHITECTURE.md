# 技术架构

适用版本：**v1.5.0 + Unreleased 本地改进 · 严格在线写入**。

## 1. 分层

| 层 | 位置 | 职责 |
|---|---|---|
| 登录页 | `app/page.tsx`、`app/chatgpt-auth.ts`、`app/auth-post-button.tsx` | provider-neutral 会话展示；认证写动作使用同源 POST |
| 认证边界 | `lib/server/auth*.ts`、`lib/auth/logout.ts` | edge adapter、内部 `Principal`、模式隔离、退出与 `return_to` |
| 客户端会话 | `src/auth-client.js` | POST 客户端、会话 scope、多标签/BFCache 锁定 |
| 账本 UI | `legacy/ledger.html` | 浏览、fuel 表单、收车确认、提案→确认→正式状态、JSON 交互 |
| UI 转场 | `src/ui-transition.js` | 共享元素几何、WAAPI 控制、降级与焦点恢复 |
| 纯业务规则 | `src/domain.js` | schema v3 清洗、fuel 联算、账期/趟号/统计、报告摘要契约 |
| 云同步纯核心 | `src/cloud-sync.js` | schema v3 状态↔记录、fuel 守恒、diff、回执和严格在线状态机 |
| API | `app/api/bootstrap`、`app/api/sync`、`app/auth/logout` | POST 请求边界、原子写入契约、HTTP 状态 |
| 服务端 | `lib/server/` | fleet/role/assignment 授权、输入校验、D1 批次与幂等 |
| 持久化 | `db/`、`drizzle/` | D1 schema、运行时旧表升级、正式 migrations |
| Edge 中间件 | `middleware.ts` | 认证 adapter、账本资源保护、本地登录和全响应安全头（替代原 Cloudflare Worker） |

成熟 UI 仍保留在单文件中。高风险逻辑尽量放在第一方纯模块或服务端边界中测试，没有为本批增加图表、视频或认证 SDK。

## 2. Provider-neutral 身份边界

```text
public request
  → Worker 删除全部外部伪造的 OAI / x-ttq-auth-* 身份头
  → 已选 adapter 验证 provider assertion
  → Worker 用进程内 proof 铸造 Principal(issuer, subject, displayName, ...)
  → API 只读取内部 Principal
  → identities(issuer, subject) → users → fleet_members → fleet rows
```

- `TTQ_AUTH_MODE` 必须显式为 `sites`、`local` 或 `cloudbase`，不能从请求参数选择；
- `sites` adapter 使用稳定 provider subject，email/loginName 只作请求级提示，不写入业务归属；
- `local` 只允许 `NODE_ENV=development` 且 host 为 loopback，固定 subject 和纯数字登录名 `13800000000`，cookie 为 HttpOnly、SameSite=Strict、短时有效；
- `cloudbase` 目前只保留类型并 fail closed：不会铸造 Principal，也没有 endpoint、SDK、token 验证或密钥；
- 公共请求无法自造 user、fleet、role、membership 或 assignment；应用内部 user id 才是业务关联键。

## 3. POST 与 HTTP 安全边界

- `/api/bootstrap`、`/api/sync`、`/auth/logout` 和本地登录动作统一使用同源 JSON POST；bootstrap 的 GET 明确返回 405，logout 不提供 GET handler；
- 写请求验证 Origin allowlist、拒绝 `Sec-Fetch-Site: cross-site`、要求 `application/json` 与 `X-TTQ-Request: ledger-v1`；
- body 逐流计数，不能依赖可伪造或缺失的 `Content-Length`，上限 2 MiB；
- 动态响应统一 `Cache-Control: no-store`、`frame-ancestors 'none'`、`X-Frame-Options: DENY`、`nosniff`、`no-referrer` 和受限 Permissions Policy；HTTPS 才添加 HSTS；
- `/auth/logout` 先用 POST 完成应用侧退出，再把经校验的同源相对 `return_to` 返回给客户端；Sites provider 的保留 GET 跳转只发生在该 POST 成功之后。

## 4. 正式状态、scope 存储与会话失效

D1 是当前实现的业务正式状态。浏览器状态分为：

- 全设备 `tangtangqing-device-prefs-v1`：只保存 day/night 主题；
- `fleet.id + membership.id` scope：`cache`、`conflict`、`migration`、`prefs`，账号相关内容只有 bootstrap 确认归属后才可读取；
- `tangtangqing-session-epoch-v1` 与 BroadcastChannel：只传 logout/session-invalid epoch，不包含账号、车队或业务数据。

未归属旧键（包括 `tangtangqing-data`、旧 migration/cache 键）不在登录会话中读取，也不自动搬到新账号。需要恢复旧账时，用户必须显式导入 JSON 并经过摘要、守恒和覆盖确认。

BFCache `pagehide/pageshow`、其他标签页退出、401 或手动退出都会先锁界面、清空内存正式状态、终止请求并递增 generation；迟到回执不能重新解锁旧账。恢复只能重新加载并 POST bootstrap。

快记清单是例外明确、生命周期很短的 UI 草稿：只保存在 `quickDrafts` 内存变量，不并入正式 `S`，也不进入任何浏览器存储。它以同一趟次为边界，每条在加入时生成稳定 ID；会话锁定时与其他敏感页面状态一起清空。

## 5. 严格在线状态机

```text
online → clone confirmed S → mutate proposal
       → plan operations(expectedVersion)
       → POST one operationId-bound atomic batch
       → validate complete acknowledgement → replace S

network/server failure → keep old S + readonly + in-memory retry token
409 conflict           → keep old S + readonly + reload/review
400/422 rejection      → keep old S + current form for corrected retry
401/session signal     → lock and hide all business state
```

保存阶段锁定业务控件并设置 `aria-busy`。失败表单和收车确认层保留，只有完整服务器回执才显示成功和关闭弹层。网络恢复先 bootstrap；响应丢失时仅在版本仍安全的前提下用相同 `operationId` 和 operations 重放。

快记中的「加入清单」只改 UI 草稿，不是业务写入，所以网络中断后仍可继续整理当前已打开的清单；「保存全部」才调用一次 `submitBusinessMutation()`。一旦该请求进入未知回执状态，清单锁定编辑和退出，避免屏幕内容偏离待重放的同 ID、同 payload 请求。

## 6. 原子批次、fuel 与 D1

- 新建 `expectedVersion=0`，更新/删除必须匹配正整数 version；同 fleet + operation ID + hash 回放原回执，ID 相同但 payload 不同返回 409；
- `sync_assertions CHECK(ok=1)` 把 membership、driver assignment 和 version guard 放进同一批；`sync_commits` 保存幂等回执；
- `drizzle/0002_lonely_shriek.sql` 只向 `trip_expenses` 增加 nullable `fuel_unit_price_x10000`、`fuel_volume_ml` 和约束触发器，不重建旧表、不回填旧油费；
- 两个 fuel 列必须同时为空，或同时为合法范围且 `category_id='fuel'`。服务端另外用 BigInt 定点规则核对金额 2 位、单价 4 位、升数 3 位和固定 1 分误差；
- bootstrap/repository 对成对字段、科目、范围和金额一致性 fail closed；旧 fuel 的 null/null 只作为明确兼容记录返回，不伪造 metadata；
- schema v3 同步和 JSON 守恒摘要同时核对记录数、整数分、结构化/旧 fuel 条数、总毫升、结构化金额与逐记录 fingerprint。

## 7. 报告摘要服务边界

`TTQDomain.buildReportSummary(state, scope)` 是内部纯函数/结构契约：

- 输入：账期范围、月份或自然年，以及车辆范围；
- 输出：实际统计范围、趟次收入/支出/利润、维修、净利润、fuel 汇总/极值/车辆拆分与旧数据警告；
- 月份与当前账期取交集；自然年使用完整年份；所有范围共用同一车辆筛选；
- 当前统计页面、数值卡片和文字报告共同消费该摘要。

这里没有新建网络 endpoint、定时任务、外部 OpenAI/API、视频生成、数据库表或依赖。未来若做视频，必须在另批确定“服务端摘要 → 模板/视频渲染 → 用户审核 → 导出/分享”的方案及费用、隐私和权限。

## 8. 收车与共享元素弹层

- 首页和趟次详情的全宽按钮打开收车结算；结算页按钮再打开 `sheet-close-confirm`，形成真实嵌套模态栈；
- 确认层展示车辆、到家日期、收入、支出、预计利润和零收入警告；提交锁定、状态 live region、失败留层、成功回执后 `closeAllSheets()`；
- `syncSheetModality()` 只让最顶层 sheet 可交互，其他 view/nav/sheet 使用 inert；Tab 焦点圈、Escape/系统返回、顶部返回沿栈逐层处理；
- `src/ui-transition.js` 只负责视觉与焦点。来源消失或离屏时降级，reduced motion/旧浏览器同步完成，不接触业务状态或回执；
- 左缘返回与顶部下拉仍是通用“关闭弹层”手势，不是收车提交方式。
- 快记清单使用 `sheet-quick-batch` 作为嵌套模态层：顶部返回只回到继续添加，最终按钮固定在安全区上方；未提交退出经确认框，系统返回和手势沿用同一退出策略。

## 9. JSON 恢复与 schema v3

导出使用 `tangtangqing-schema-v3`，在 `_backupMeta.conservation` 内保存守恒声明。导入先区分真正 v1/v2 旧备份与完整 v3 envelope；顶层 v3 缺少匹配 meta/守恒声明时不能伪装成旧格式降级。清洗、预检、完整替换确认、单批提交和服务器回读后都要核对守恒；单次最多 500 operations。

全量恢复文件只由 owner 生成。driver bootstrap 的裁剪视图带内部只读能力标记；这类部分数据即使被导出，也会写入 `driver-visible-partial`/`restorable:false`，导入必须在 `migrate()` 和 `planSync()` 前拒绝，不能把不可见记录规划成删除。

## 10. 构建与腾讯试用边界

构建脚本把 `legacy/ledger.html`、`src/domain.js`、`src/cloud-sync.js`、`src/auth-client.js`、`src/ui-transition.js` 复制到 gitignored `public/ledger/`。当前 `.openai/hosting.json`、Vinext Worker、Cloudflare D1 adapter 和 Sites 身份模式仍是 Sites/Cloudflare 产物，**不能直接作为腾讯云标准 Node 应用部署**。

腾讯云仅有架构预检结论，尚未适配、建库、配置账号、部署或验证合规。若用户另批确认，候选为上海地域的小范围封闭非经营测试、个人主体、纯数字手机号用户名，以及 CloudBase Auth + MySQL；仍需再确认实际产品资格、域名/备案、安全与迁移方案后实施。
