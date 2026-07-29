# 技术架构（ARCHITECTURE）

适用版本：**v1.4.0 · 第一阶段联网保存**。本文描述当前 Sites/D1 架构与不允许随意更改的业务、安全约定。

## 1. 总体结构

项目在保留成熟账本 UI 和 `src/domain.js` 业务规则的前提下，增加 Vinext/Next、Sites Worker、服务端 API 和 D1：

| 层 | 位置 | 职责 |
|---|---|---|
| 登录页 | `app/page.tsx`、`app/chatgpt-auth.ts` | 展示 SIWC 登录状态；不做业务授权 |
| 账本 UI | `legacy/ledger.html` | 原有页面、交互、设备缓存、首次迁移提示 |
| 业务规则 | `src/domain.js` | schema v2 清洗、账期、趟号、排序和统计口径 |
| 云端适配 | `src/cloud-sync.js` | schema v2 与独立云记录互转、差异计划、迁移守恒 |
| API | `app/api/bootstrap`、`app/api/sync` | 服务端读取身份、解析车队、校验并保存记录 |
| 授权/仓储 | `lib/server/` | 内部账号初始化、车队隔离、角色与车辆分配检查、版本控制 |
| 持久化 | `db/`、`drizzle/` | D1 schema、运行时建表和已生成 SQL migration |
| 分发 | `worker/index.ts` | 账本路由保护、静态资源、本地认证替身 |

`.openai/hosting.json` 声明逻辑 D1 binding `DB`；R2 为 `null`。正式账目不存入 R2。

## 2. 身份与数据归属

身份和账本归属分开建模：

```text
Sites 身份头
  → identities(provider, provider_subject)
  → users(id)
  → fleet_members(fleet_id, user_id, role)
  → fleets(id)
  → 车队内车辆和账目
```

- `users.id` 是内部用户主键。
- `identities` 保存登录提供方与 `provider_subject` 的关联；当前提供方为 `chatgpt`。邮箱只保存在身份层用于当前 SIWC 关联，不作为车辆、趟次或账本主键。
- 一个用户通过 `fleet_members` 加入车队，角色预留 `owner` / `driver`。
- `vehicle_assignments` 保存司机与车辆的有效期和启用状态。
- 第一阶段首次登录会创建内部用户、ChatGPT identity、一个 fleet 和 owner membership；完整司机邀请/分配 UI 尚未开放。
- 将来新增手机号身份时，只需给同一内部 user 增加 identity，不迁移车队账本。

## 3. 服务端鉴权边界

1. API 只信任 Sites/Worker 转发的 `oai-authenticated-user-*` 请求头。
2. 请求体、查询参数和 localStorage 都不能提供用户、车队、角色或归属。
3. 服务端先由 identity 找到内部 user 和活动 membership，再把每次查询限定到 `fleet_id`。
4. `owner` 可查看和写入所属车队全部车辆；内部 `driver` 规则只允许查看和写入仍有活动 assignment 的车辆。
5. 客户端不能通过同步 API修改 `fleetId`、`userId`、role 或 membership。
6. 登录只等于确认 ChatGPT 身份，不等于任意车队权限；车队归属检查必须在每次 API 请求中完成。

`localhost` 测试入口由 Worker 写入 HttpOnly、SameSite=Lax 的短期 cookie，再在服务端注入固定测试身份。该逻辑遇到非本地主机直接返回 404，不能作为生产认证。

## 4. D1 数据模型

所有业务表以 `fleet_id` 隔离。主要表如下：

| 表 | 用途 |
|---|---|
| `users` | 内部用户 |
| `identities` | `provider + provider_subject` 到内部 user 的唯一关联 |
| `fleets` | 车队账户 |
| `fleet_members` | user 在 fleet 中的 owner/driver 角色 |
| `vehicles` | 车队车辆目录 |
| `vehicle_assignments` | 司机到车辆的活动分配 |
| `fleet_settings` | 主题、当前车辆、账期、迁移初始化状态 |
| `categories` | 收入/支出科目；停用代替物理删除 |
| `trips` | 趟次主记录 |
| `trip_expenses` | 一笔一行的趟次支出 |
| `trip_incomes` | 一笔一行的趟次收入 |
| `maintenance` | 一笔一行的维修保养 |

金额在 D1 中以整数分保存；所有可写记录都有 `updated_at` 和正整数 `version`。正式 migration 与运行时 schema 使用相同的 `CHECK`、主键、索引和外键约束。`db/invariants.ts` 中的数据库触发器还原子保证：至少保留一辆启用车辆、在途车辆不能停用、停用车辆不能新增或迁入在途趟、仍有收入/支出的趟次不能删除。这样两台设备的写入交错时也不会越过跨记录业务规则。

## 5. 逐记录同步与并发

客户端界面仍使用原 schema v2 状态 `S`，但云端从不接收“整份 JSON 最后写入覆盖”：

1. `/api/bootstrap` 返回当前车队可见的独立 records 及各自 version。
2. `TTQCloudSync.planSync()` 比较当前状态与最近云端基线，只生成变化记录的 `put` / `delete`。
3. 每个操作携带 `expectedVersion`：新建为 `0`，更新或删除必须匹配当前 version。
4. 服务端逐条检查 fleet 归属、owner/driver 权限、车辆 assignment、字段和业务边界。
5. 版本不匹配返回该记录的 `conflict` 和当前值；非法输入返回 `rejected`。成功记录单独递增 version。
6. 正常保存只推进本批成功记录的基线，不会把另一设备刚新增的记录误判成删除。
7. 断线重试先以完整远端为底做三方合并：只有本机相对旧基线改过的 key 才覆盖到待上传状态；远端新增的其他 key 会保留。同一 key 两边都变过则停止并提示冲突。

大型账本按最多 200 条记录分批上传；只有最后一批全部成功才标记车队初始化完成。一个批次可以部分成功，因此重试必须先重新读取基线，再只提交剩余差异。该机制让不同车辆、不同趟次和同一趟里的不同收入/支出可以独立写入。

## 6. 正式数据源、缓存与断网

- D1 是正式数据源。
- `localStorage["tangtangqing-data"]` 只作为 v1.3.0 及以前旧账的迁移来源。
- `localStorage["tangtangqing-cloud-cache-v1"]` 按当前 `fleet_id` 标记最近设备快照和云端基线，用于当前会话断网暂存与联网后的安全续传，不代表云端成功。
- 联网恢复时，只有待上传记录的云端 version 未变化才自动续传；同一记录两边都变过会停止，并另存设备冲突缓存供导出核对。
- 主题等设备偏好可以继续留在浏览器。
- 离线或保存失败时，界面必须显示「尚未上传」；重新加载时不离线展示未重新确认归属的业务缓存，用户恢复网络后再由服务端确认身份和 fleet。
- 如果浏览器配额或隐私模式导致设备缓存也写入失败，界面必须明确要求立即导出 JSON，不能声称改动已留在设备。
- 当前缓存是第一阶段安全兜底，不是完整离线队列。多次跨设备离线编辑的自动合并留到第二阶段。

首次迁移和 JSON 备份恢复见 [DATA-MIGRATION.md](DATA-MIGRATION.md)。

## 7. schema v2 业务状态适配

页面内状态仍保持：

```js
{
  schemaVersion: 2,
  settings: {
    theme, lastReportSeen, lastBackupAt, activeVehicleId,
    periodStartDate, periodEndDate
  },
  vehicles: [{ id, name, plateNo, active, createdAt }],
  categories: {
    expense: [{ id, name, icon, builtin, active }],
    income: [{ id, name, icon, builtin, active }]
  },
  trips: [{
    id, vehicleId, startDate, endDate, status, createdAt, closedAt,
    expenses: [{ id, catId, amount, date, note }],
    incomes: [{ id, catId, amount, date }]
  }],
  maintenance: [{ id, vehicleId, date, amount, note }]
}
```

`src/cloud-sync.js` 把嵌套的 expenses/incomes 拆成独立 D1 records，回读时再重组。`src/domain.js` 继续是业务口径唯一实现，不因联网保存改变趟号或统计含义。

## 8. 不可变的业务硬约定

1. 趟号按「车辆 + 当前账期」分组，已收车按 `endDate` 正序动态编号。
2. 已收车列表按到家日期倒序；在途趟按发车日期并显示预计趟号。
3. 趟次利润只统计账期内已收车趟，整趟按到家日期归期。
4. 维修按自身日期和车辆单列，不计入趟次利润。
5. 每辆车最多一个在途趟，不同车辆可以同时在途。
6. 有历史的车辆只能停用；在途车不能停用；至少保留一辆启用车。
7. 金额入口保留两位小数、拒绝负数；D1 中转为整数分。
8. 科目只软删除。
9. 用户文本、HTML 属性和科目图标必须分别经过 `esc()`、`attrEsc()`、`safeIconText()`；不得把恢复备份中的值直接拼成 HTML。

完整口径以 [BUSINESS-RULES.md](BUSINESS-RULES.md) 为准。

## 9. 原账本交互约定

- 页面仍采用全量 `render*` 和 document 级事件委托。
- 弹层必须走 `openSheet/closeSheet`，保持 History API 返回键语义。
- 提交型动作使用 `guardOnce()`；关闭弹层使用 `tapShield()` 防穿透。
- `makePad`、`openAmtPad`、`ask`、`toast`、`initSlide` 继续作为复用入口。
- 构建前脚本从 `legacy/ledger.html` 生成 `public/ledger/index.html`；不要直接编辑生成文件。

## 10. 当前交付状态

v1.4.0 已完成本地结构、逻辑绑定、schema、migration、认证和同步实现。本轮明确 **local-only**：尚未创建 Sites 项目，未部署生产，未推送 GitHub，未创建 PR。生产域名、访问策略、监控和恢复演练不属于本阶段。
