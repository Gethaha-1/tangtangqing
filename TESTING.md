# 测试

适用版本：**v1.5.0 + Unreleased 本地改进 · 严格在线写入**。全部测试使用独立本地 D1/测试车队；不得用唯一真实账本做破坏性验证。

## 1. 自动化与构建

项目 engines 为 Node.js 22.13+；当前测试会直接导入 TypeScript，推荐 Node.js 24。

```bash
npm install
npm test
npm run lint
npx tsc --noEmit
npm run build
git diff --check
```

不要在文档硬编码最终测试项数，以命令退出码和当次输出为准。

| 文件 | 重点 |
|---|---|
| `tests/domain.test.js` | schema v3、日期、账期、净利润、fuel 定点联算、报告摘要 |
| `tests/cloud-sync.test.js` | v3 record/fuel 守恒、expectedVersion、批量快记 diff、回执、严格状态机、JSON 账期安全 |
| `tests/legacy-ui-contract.test.mjs` | fuel UI、快记清单/单批提交、净利润/报告接线、收车确认、模态栈与失败留层 |
| `tests/auth-client.test.js` | 同源 POST、scope 存储、旧键隔离、BFCache 和多标签锁 |
| `tests/auth-security.test.mjs` | Principal adapter、伪造头、Origin/marker/body limit、安全头、POST-only |
| `tests/ui-transition.test.js` | 共享元素几何、关键帧、源失效、reduced motion、取消/焦点恢复 |
| `tests/server-api.test.mjs` | ownership、fuel repository/bootstrap、原子 guard、D1 constraints/migrations |
| `tests/auth-logout.test.mjs` | POST 退出、provider 委托、本地 cookie、安全 `return_to` |
| `tests/legacy-xss.test.mjs` | 恶意备份、fuel/报告新增渲染 sink 的持久化 XSS |

schema 改动另运行 `npm run db:generate`，确认没有意外新 migration；检查 `0002_lonely_shriek.sql` 只做两列原位增加和 fuel 触发器，不重建旧表。

## 2. 本地认证、POST 与退出

```bash
TTQ_AUTH_MODE=local npm run dev
```

使用输出的 loopback Local URL：

1. 未登录 `/` 只显示本地测试入口，按钮文案使用 `13800000000`；非 loopback、production 或未显式 local 模式不得显示/接受该身份。
2. 本地登录是同源 JSON POST；成功设置 HttpOnly、SameSite=Strict cookie 并进入 `/ledger`。
3. 未登录 `/ledger` 和受保护静态资源不可显示账本；伪造 OAI 或 `x-ttq-auth-*` 头不能登录。
4. `/api/bootstrap`、`/api/sync`、`/auth/logout` 都由客户端 POST；bootstrap GET 返回 405，logout 没有 GET handler。
5. 缺 Origin、跨源、`Sec-Fetch-Site: cross-site`、非 JSON、缺 `X-TTQ-Request` 分别拒绝；chunked body 超过 2 MiB 返回 413。
6. HTTPS 响应有 no-store、安全头和 HSTS；loopback HTTP 不错误发送 HSTS。
7. 退出先锁住并隐藏账本，再 POST `/auth/logout`；请求失败仍保持锁定，只提供受保护的 POST 重试，不恢复旧账或提前跳转。
8. localhost 退出清 cookie；Sites 模式只在 POST 成功后返回 dispatcher-owned 下一跳；外部 URL、`//host`、反斜杠、控制字符和认证循环降级 `/`。

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
- 未提交返回、Escape、系统返回、左缘滑动和下拉都要求明确丢弃确认；会话锁定清除草稿且不写入浏览器存储。

## 5. 净利润与报告范围

用两车、跨账期/月份/年份夹具验证：

- 单趟利润始终等于该趟收入减趟内支出，不扣维修；
- 单车账期净利润只扣同车同账期维修；全部车辆只扣范围内全部维修；
- 首页主数、统计卡、账期报告、月报和年报的趟次利润/维修/净利润相同；
- 月报范围为自然月与当前账期交集，空交集留在原页并可访问地报错；
- 年报为完整自然年，年份只接受 1000–9999；
- 油费跟随所属已收车趟次 `endDate`，维修跟随自身 `date`；在途趟不进入财务/fuel 摘要。

## 6. Fuel 三项、聚合与 D1

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

D1 分别验证：

- 新库 schema、正式 `0002` 升级和 runtime 旧表升级约束等价；
- 升级前后旧行数和所有旧字段守恒，新列为 null/null；
- fuel 列成对、范围和 category update 触发器不能绕过；
- repository 写入/回执含 canonical fuel；bootstrap 对部分列、错科目、越界或金额矛盾 fail closed。

## 7. JSON schema v3

1. 导出 envelope 含 schema v3 和 conservation，但不含账号/token。
2. v3 的记录数、整数分、结构化/旧 fuel 条数、总毫升、结构化金额和 fingerprint 在导入清洗前后及服务器确认后守恒。
3. 顶层 v3 缺 meta、格式/版本不匹配或缺 conservation 时直接拒绝，不能伪装成 v2。
4. 真正 v1/v2 可显式导入；缺 fuel 的旧油费保留为 legacy，不伪造元数据。
5. 合法账期经确认恢复；缺失、伪日期、倒序或超过 366 天时保留当前账期。
6. driver 裁剪视图不能导出可完整恢复的车队备份；带 `_ownerRecordsWritable:false`、`driver-visible-partial` 或 `restorable:false` 的文件在迁移/差异规划前拒绝，owner 不能因此删除其他车辆账目。
7. 取消、服务器不可达、400/422/409 时正式状态不变；相同文件重复导入可安全再次执行，同一次失败重试复用原 operationId。
8. 超过 500 operations 明确拒绝且零部分写入。

只读核对真实备份：

```bash
node scripts/verify-backup.js /绝对路径/备份.json
```

## 8. 收车、大屏单手与无障碍

在 iPhone Max/普通尺寸以及左右手单手场景验证：

- 首页和详情都显示易触达全宽“确认收车”，源码/DOM 不再有旧收车控件；安全区不遮挡按钮；
- 第一次进入结算，第二次进入嵌套确认 sheet；摘要正确显示车辆、日期、收入、支出、预计利润；
- 零收入有警告但允许继续；返回检查保持已填收入和日期；
- 快速连点只进入一条确认流，最终提交只发一批；保存时按钮锁定且 VoiceOver 读出状态；
- 服务器成功且回执包含 closed trip 后才退出全部层；离线、网络失败、400/409/422 和异常回执都留在确认层；
- 键盘 Tab/Shift+Tab 圈在最顶层模态，底层 view/nav/sheet inert；焦点随逐层返回恢复；Escape、顶部返回和系统返回不越层；
- VoiceOver 核对 dialog 名称、零收入 alert、保存 status、按钮 busy/disabled 和“返回检查”标签。

## 9. 共享元素与移动浏览器

- 趟次卡、更多、车辆、收入/支出/维修、在途快记和收车入口打开/返回时约 390ms 展开并回源；
- 多层 sheet 用顶部返回和系统返回逐层关闭，栈与 History 各只变化一次；
- 左缘返回、顶部下拉完成时不追加第二段回源动画，未过阈值正确复位；
- 快速双击、打开中立即返回、连续返回不重复压栈或越层；
- 来源被重绘、删除、滚出视口或消失时轻缩放淡出且无残留遮罩；
- 日/夜主题、`prefers-reduced-motion` 和无 `Element.animate` 分别验证。

## 10. 腾讯云候选试用前检查

当前代码只做本地验证，尚未授权推送或部署。现有 Sites/Cloudflare Worker、D1 与身份产物不能直接作为腾讯云标准 Node 应用发布。

若用户另批确认腾讯方案，再验证上海地域、个人主体封闭非经营测试域名、域名/备案与产品资格、纯数字手机号登录名、CloudBase Auth、MySQL schema/migration、密钥管理、日志脱敏、安全头、备份回滚和移动端完整矩阵。未完成适配前不得声称“符合腾讯云规范”或“已可部署”。
