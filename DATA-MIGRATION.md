# 数据迁移与恢复

适用版本：**v1.9.0**。页面快照和云同步为 `schemaVersion = 4`；数据库内部 marker 2 表示恢复任务增量，marker 3 表示去返程业务 JSON 增量，与 JSON schema 版本不是同一计数器。

v1.9.0 在装卸地点和常用地点的 v4 JSON 中增加可选 `city`（市）、`county`（区县），保留兼容显示字段 `region`。没有这两个可选字段的旧 v4 数据规范化结果不变，旧 fingerprint 不失效；新导出携带两字段及其业务守恒摘要。v1/v2/v3/v4 均继续向前恢复，旧应用不理解新字段，不应拿旧版程序恢复新备份。该增量不改 PostgreSQL 表结构、无需新迁移或清空数据。

版本含义：v1 为单车旧账；v2 增加车辆与 `vehicleId` 归属；v3 增加结构化油费 `fuel` 与对应守恒；v4 增加货主/市场/分组/地点及去返程清单与业务守恒。版本号描述数据格式，不是一次程序更新的全部页面代码。备份携带业务数据，不携带程序界面代码。

## v1 / v2 / v3 → schema v4

历史 JSON 只有在用户显式选择导入文件后才经过 `TTQDomain.migrate()`：

- v1 自动建立“原有车辆”，给趟次和维修补 `vehicleId`；
- v1/v2 缺失数组和设置使用安全默认值；金额清洗后仍需通过导入预检；
- 没有 `fuel` 的历史油费保留为旧油费，只计总金额，不伪造单价或升数；
- 已有 `fuel` 必须同时包含 `unitPrice`、`liters`，并与总价在固定 1 分误差内一致，否则拒绝导入；
- v1/v2/v3 缺少新业务字段时，`settings.business` 补为空货主/分组/地点目录，每趟 `business` 补为空对象；不从旧收入行猜测去程分摊、实收或称重；
- 目标统一为 schema v4，原有金额、趟号、fuel 和账期口径不变。

导入预检必须先检查原文件账期。缺失、伪日期、倒序或超过 366 天时明确提示，并保留当前合法账期。

## 未归属 localStorage 隔离

登录会话不读取或自动迁移 `tangtangqing-data`、旧 migration 标记或旧全局 cache。这些键没有 `fleet.id + membership.id` 归属，自动搬运可能把前一个账号的数据暴露给后一个账号。

账号相关设备状态只能在成功 POST bootstrap 后写入 `tangtangqing-scope-v1:<fleet+membership>:<slot>`。需要恢复旧账时，先从可信旧版本显式导出 JSON，再在当前账号中人工导入、核对摘要并确认完整替换。

## schema v4 → PostgreSQL

适配层拆分：

```text
fleet_settings
category
vehicle
trip
trip_expense
trip_income
maintenance
```

普通金额在线上 PostgreSQL 保存为整数分。结构化油费还保存：

- `fuel_unit_price_x10000`：单价 × 10000；
- `fuel_volume_ml`：升数 × 1000。

两列必须同时为空，或同时有效且科目为 `fuel`。旧油费使用 null/null；服务端回读时不合成虚假 metadata。每条记录有独立 version，客户端不能提交 fleet/user/role/assignment。

第二轮业务不新增子记录类型，而是使用两个受校验快照：

- `fleet_settings.business_json`：货主、每个货主的市场、分组主入口/成员和常用地点；
- `trips.business_json`：同一趟的去程货主分摊与返程计费/称重/地点快照。

数据库要求顶层 JSON 为对象；服务端将其限制在 1 MB，校验稳定 ID/引用/精度，并从原始吨位、单价、箱位和抹零重算汇总。兼容的 `cargo`/`back` 收入行仅为旧界面/旧备份连续性，统计以结构化业务值为唯一口径。

## 当前 PostgreSQL schema 与本地兼容迁移

线上初始 schema 位于 `deploy/supabase/001_ledger.sql`，包含 `ttq` 私有 schema、最小权限 `ttq_app` 后端角色、业务表、约束、RLS、幂等回执和事务守卫。对已经上线的数据库不得重复运行初始化脚本；后续结构变更必须创建单独、可审查、可回滚的 PostgreSQL migration。

以下 Drizzle/SQLite 文件只用于从旧 D1 结构迁移而来的本地兼容测试，不是线上迁移来源：

- `0000_public_wildside.sql`：业务 schema、约束和 triggers；
- `0001_smart_the_twelve.sql`：`sync_commits` 幂等回执、`sync_assertions` 原子守卫；
- `0002_lonely_shriek.sql`：向 `trip_expenses` 原位增加两个 nullable fuel 定点列及 insert/update 触发器。
- `0003_tranquil_lockjaw.sql`：本地恢复任务与全账本 revision 支持；
- `0004_material_doctor_spectrum.sql`：原位增加两个 `business_json` 列和 JSON 对象约束，旧行默认 `{}`。

`0002` 不重建表、不复制或删除旧行、不回填历史油费；旧字段和值保持不变。runtime schema 逐列检查并补齐旧本地表。任何业务 schema 更新都要同步审查线上 PostgreSQL migration、本地兼容 schema、约束和自动化测试，不能用 `npm run db:generate` 的 SQLite 结果代替线上迁移。

## JSON v4 导出

导出 envelope 使用 `tangtangqing-schema-v4`，并在 `_backupMeta` 保存：

- format、schemaVersion、appVersion、exportedAt、sourceFleetId；
- conservation：各类记录数、普通金额和整数分；
- fuel：结构化/旧记录数、总毫升、结构化金额和稳定逐记录 fingerprint。
- business：货主、市场、分组、地点、去程趟、返程趟数和稳定 fingerprint。

fingerprint 只用于机器守恒比较，不作为业务内容展示。导出允许在已加载账本后离线进行，不改变云端数据。

## JSON 恢复

恢复是业务写入，必须在线：

1. 区分真正 v1/v2 旧备份与完整 v3/v4 envelope；顶层 v3/v4 缺少版本匹配 meta 或 conservation 时直接拒绝，不能降级伪装成旧格式；driver 裁剪视图或 `restorable:false` 的部分文件同样在迁移前拒绝；
2. 在迁移前检查原始账期，再清洗为 schema v4；
3. 对 v3 声明核对 fuel/金额/数量，对 v4 再加上 business 守恒比较；
4. 显示当前与目标车辆、趟次、收入、支出、维修及结构化/旧油费摘要；
5. 提示来源 fleet 可能不同，明确登录身份不会改变；
6. 用户确认“完整替换当前账本”；
7. 用内容 fingerprint 与每次确认的随机标识生成 operation ID；先在当前账号临时区按 manifest/SHA-256 上传，最后在一个原子事务中提交正式业务、幂等回执和任务完成状态；同次失败重试保留原 ID 和 payload；
8. 完整服务器回执后再次比较正式状态守恒，通过后才显示恢复成功。

相同文件重复导入不会重复记账。record version 和整车队 revision 冲突返回 409，不覆盖新云端数据。普通 sync 仍限 500 operations；专用恢复限 20 MiB、30000 operations、256 块，每块 128 KiB/250 条，分块仅写临时区。关闭页面后从本机任务或重新选择指纹一致的原文件续传，7 天内的临时任务可查询；过期不改变正式账本。

恢复增量为 `supabase/migrations/20260905164507_ledger_recovery.sql`；业务 JSON 增量为 `supabase/migrations/20260908120000_trip_business.sql`。必须按顺序验证，并只在项目所有者明确授权后对生产应用；详见 `deploy/RECOVERY-MIGRATION.md` 和 `deploy/TRIP-BUSINESS-MIGRATION.md`。SQLite 兼容迁移不能代替 PostgreSQL migration。

本机 IndexedDB 草稿保持账号隔离，不能直接当 JSON 完整备份导入。未归属的旧 localStorage 仍不自动读取或上传。本轮只在代码和本地迁移回归中实施；生产迁移、部署和真实数据操作仍待单独授权。

## 只读验证

### 恢复耗时与错误处理（v1.6.1）

- 恢复预检将当前记录、关联趟次与在途趟次、车辆、科目和当前成员分配合并在一个只读批次中读取；快照仅供本次请求校验，写事务仍重新执行权限、父记录和版本守卫。
- 正常保存只需一次只读预检和一次写事务，不按每笔费用重复往返数据库。
- 保存请求等待完整回执的截止时间为 45 秒，其他请求为 20 秒；服务器本身超时仍需明确提示。
- 请求超时或服务器异常表示回执未知，保持只读及原待确认 payload，重新连接核对，不能宣称一定未保存或创建新 ID 盲目重试。
- 400/413/422 明确拒绝时保留表单供修正；v1/v2 的迁移规则、旧油费和 v3 守恒规则保持不变。

### 本机核对

推荐 Node.js 24：

```bash
npm test
node scripts/verify-backup.js /绝对路径/备份.json
git diff --check
```

`verify-backup.js` 会把 v1/v2/v3/v4 清洗为 schema v4，核对记录数、收入/支出/维修金额和完整 fuel 守恒；原文件为 v4 时另核对 business 守恒。真实备份不得复制进仓库、写回原文件或上传第三方。
