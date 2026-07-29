# AI 接手手册（AI-GUIDE）

适用版本：**v1.4.0 · 第一阶段联网保存**。先按任务路由读取最少文件，再安全修改。

## 1. 快速接手

1. 先读本文件的任务路由；
2. 涉及趟号、账期、车辆或统计时读 `BUSINESS-RULES.md`；
3. 涉及数据形状、D1 或备份时读 `DATA-MIGRATION.md`；
4. 项目含 `.openai/hosting.json`，网站任务必须遵守 Sites 构建规范；
5. 未得到用户明确授权时，不创建 Sites 项目、不部署、不推送、不建 PR。

### 任务路由

| 需求 | 必读 | 主要修改位置 |
|---|---|---|
| 登录页、SIWC 展示 | `ARCHITECTURE.md` §2–3、`DESIGN.md` | `app/page.tsx`、`app/chatgpt-auth.ts` |
| 身份、车队、角色、车辆分配 | `ARCHITECTURE.md` §2–4 | `lib/server/auth.ts`、`lib/server/bootstrap.ts`、`db/` |
| 云端读取/保存、并发冲突 | `ARCHITECTURE.md` §5–6、`DATA-MIGRATION.md` | `app/api/`、`lib/server/sync-*`、`src/cloud-sync.js` |
| D1 schema/migration | `DATA-MIGRATION.md` | `db/schema.ts`、`db/runtime-schema.ts`、`drizzle/` |
| 首次上云、JSON 备份恢复 | `DATA-MIGRATION.md`、`TESTING.md` | `legacy/ledger.html` [JS-1]/[JS-5]、`src/cloud-sync.js` |
| 趟号、旧账排序、账期、统计 | `BUSINESS-RULES.md` | `src/domain.js` + `legacy/ledger.html` |
| 首页/趟次/统计/维修页面 | `DESIGN.md` | `legacy/ledger.html` [HTML-1]/[JS-3] |
| 发车、收车、补录、弹层 | `DESIGN.md`、`ARCHITECTURE.md` §9 | `legacy/ledger.html` [HTML-2]/[JS-4] |
| 测试 | `TESTING.md` | `tests/`、`legacy/ledger.html` [JS-6] |
| 第二阶段功能 | `BACKLOG.md` | 先确认范围，不提前开放 |

`public/ledger/` 是构建前生成目录，不是源文件。修改账本页面用 `legacy/ledger.html`；脚本会复制页面、`domain.js` 和 `cloud-sync.js`。

## 2. 红线

1. **不擅改业务口径**：编号按车辆+账期、已收车按到家日期、维修单列；以 `BUSINESS-RULES.md` 为准。
2. **D1 是正式数据源**：localStorage 只能是旧账来源、设备缓存或设备偏好，不能重新成为云端账本真相。
3. **不整份覆盖**：业务写入必须拆成独立记录，携带 `expectedVersion`，明确处理 conflict/rejected。
4. **鉴权只在服务端**：身份只读可信 Sites/Worker headers；请求体、query、localStorage 不能决定 user、fleet、role 或 assignment。
5. **邮箱不是业务主键**：使用内部 user id；外部 claim 只存在 `identities(provider, provider_subject)`。
6. **所有查询按 fleet 隔离**：owner 可操作所属车队全部车辆；driver 只能操作活动 assignment 指向的车辆。
7. **schema 变更必须完整落盘**：同步修改 Drizzle schema、运行时 schema、SQL migration、契约/迁移测试和文档。
8. **金额服务端存整数分**：入口两位小数、拒绝负数，上传与回读必须守恒。
9. **科目和有历史车辆保持软删除语义**。
10. **按上下文安全渲染**：文本过 `esc()`，HTML 属性过 `attrEsc()`，科目图标过 `safeIconText()`；恢复备份中的字段不得直接拼进 `innerHTML`。
11. 文案遵守 `DESIGN.md` §6；颜色只用双主题 CSS 变量；不加外链字体或图像依赖。
12. 弹层走 `openSheet/closeSheet`；提交动作走 `guardOnce()`。
13. 不硬编码生产凭据，不把真实备份提交到仓库。

## 3. 改动流程

```text
按任务路由读规则
→ 先补最小失败测试
→ 修改对应层，保持 fleet/版本边界
→ npm test
→ npm run build
→ /ledger#test
→ TESTING.md 对应冒烟
→ 更新 CHANGELOG 和受影响文档
→ 按用户授权决定是否仅本地交付
```

当前 v1.4.0 交付为 local-only；不要把 `.openai/hosting.json` 的逻辑 binding 误写成“已经创建或部署了生产 D1”。

## 4. 常见任务

### 改 D1 字段

先补授权/校验/迁移测试 → 改 `db/schema.ts` → 同步 `db/runtime-schema.ts` → `npm run db:generate` → 检查 `drizzle/*.sql` → 更新 repository/adapter → 跑完整测试。

运行时 schema 中每个数组项只能是一条 SQL；D1 用 `prepare().run()` 或 `batch([...])`，不要把多条 SQL 拼进同一个 `prepare()`。

跨记录触发器的单一来源是 `db/invariants.ts`；Drizzle 不会自动生成这些 trigger。首次 migration 已显式包含同一组 SQL。以后若 migration 重建 `vehicles` 或 `trips`，必须检查并在重建后重新创建 trigger。

### 新增一种同步记录

同时更新：

- D1 表与索引；
- `SYNC_TYPES`、输入校验、put/delete 顺序；
- repository 的 fleet/role/assignment 检查；
- `src/cloud-sync.js` 拆分、重组和 diff；
- 重复记录、孤儿、删除、版本冲突、守恒测试。

客户端不得提交 ownership 字段。

### 修改首次迁移

覆盖三类主分支：本机旧账+空云端、双方都有数据、本机无旧账。任何自动选择都不得导致双方有数据时静默覆盖。上传后必须回读并比较数量/金额，旧 localStorage 默认保留。

### 修改趟号或账期

先改 `tests/domain.test.js` → 改 `src/domain.js` → 更新 `BUSINESS-RULES.md` → 调整 `legacy/ledger.html` 展示 → 跑 Node 测试和 `/ledger#test`。

### 修改登录

SIWC 入口、退出和回跳路径属于 Sites 分发层，不自行实现 OAuth callback。页面可用 `getChatGPTUser()` 做可选展示，API 必须另行调用服务端身份和 membership 检查。

## 5. 已知坑

- `src/domain.js`、`src/cloud-sync.js` 都是 UMD，同时供浏览器和 Node 测试使用。
- 事件委托的 `q()` 分支有顺序，新分支可能被前面截胡。
- `closeSheet` 会按映射重渲染下层，不要在调用点重复渲染。
- 弹层打开时刷新会残留历史格；不要在 unload 中补偿。
- iOS 不可靠支持 `background-attachment: fixed`，背景氛围留在固定伪元素。
- `tripSeq` 是动态展示值，绝不能持久化。
- 云端批次可逐记录部分成功；重试前必须重新 bootstrap，不能盲目重放旧 expectedVersion。
- 正常保存不能拿本机整份快照和刷新后的完整远端做 diff；重试必须用旧基线、本机待传和最新远端做三方合并，保留远端新增的不同 key。
- “至少一辆启用车、在途车不可停用、含子账目的趟次不可删除”等跨记录规则必须保留 D1 原子触发器，不能只做先查后写。
- 设备缓存里的“最新状态”不等于云端已保存，所有提示都要区分。
- 本地测试身份只允许 localhost；不要扩大到局域网主机名或生产域名。

## 6. 交付前检查

- `npm test`、`npm run build`、`/ledger#test`；
- 授权、归属、并发、三种迁移、断网重试和 JSON 恢复；
- `git diff --check`；
- 检查没有凭据、真实备份或生成目录误入版本控制；
- 最终明确是否推送、建 PR 或部署；没有授权就保持本地。
