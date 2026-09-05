# 数据迁移与恢复

适用版本：**v1.6.1**。页面快照和云同步使用 `schemaVersion = 3`；D1 保存独立 fleet-scoped records。

## v1 / v2 → schema v3

历史 JSON 只有在用户显式选择导入文件后才经过 `TTQDomain.migrate()`：

- v1 自动建立“原有车辆”，给趟次和维修补 `vehicleId`；
- v1/v2 缺失数组和设置使用安全默认值；金额清洗后仍需通过导入预检；
- 没有 `fuel` 的历史油费保留为旧油费，只计总金额，不伪造单价或升数；
- 已有 `fuel` 必须同时包含 `unitPrice`、`liters`，并与总价在固定 1 分误差内一致，否则拒绝导入；
- 目标统一为 schema v3，业务内容不改名、不改变趟号口径。

导入预检必须先检查原文件账期。缺失、伪日期、倒序或超过 366 天时明确提示，并保留当前合法账期。

## 未归属 localStorage 隔离

登录会话不读取或自动迁移 `tangtangqing-data`、旧 migration 标记或旧全局 cache。这些键没有 `fleet.id + membership.id` 归属，自动搬运可能把前一个账号的数据暴露给后一个账号。

账号相关设备状态只能在成功 POST bootstrap 后写入 `tangtangqing-scope-v1:<fleet+membership>:<slot>`。需要恢复旧账时，先从可信旧版本显式导出 JSON，再在当前账号中人工导入、核对摘要并确认完整替换。

## schema v3 → D1

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

普通金额在 D1 保存为整数分。结构化油费还保存：

- `fuel_unit_price_x10000`：单价 × 10000；
- `fuel_volume_ml`：升数 × 1000。

两列必须同时为空，或同时有效且科目为 `fuel`。旧油费使用 null/null；服务端回读时不合成虚假 metadata。每条记录有独立 version，客户端不能提交 fleet/user/role/assignment。

## D1 migration 0002

- `0000_public_wildside.sql`：业务 schema、约束和 triggers；
- `0001_smart_the_twelve.sql`：`sync_commits` 幂等回执、`sync_assertions` 原子守卫；
- `0002_lonely_shriek.sql`：向 `trip_expenses` 原位增加两个 nullable fuel 定点列及 insert/update 触发器。

`0002` 不重建表、不复制或删除旧行、不回填历史油费；旧字段和值保持不变。runtime schema 逐列检查并补齐旧表，另一个 isolate 抢先加列时会重新读取 schema；目标列仍缺失则原错误继续抛出。任何后续 schema 更新必须同步 `db/schema.ts`、`db/runtime-schema.ts`、Drizzle snapshot/journal、SQL 和测试。

## JSON v3 导出

导出 envelope 使用 `tangtangqing-schema-v3`，并在 `_backupMeta` 保存：

- format、schemaVersion、appVersion、exportedAt、sourceFleetId；
- conservation：各类记录数、普通金额和整数分；
- fuel：结构化/旧记录数、总毫升、结构化金额和稳定逐记录 fingerprint。

fingerprint 只用于机器守恒比较，不作为业务内容展示。导出允许在已加载账本后离线进行，不改变云端数据。

## JSON 恢复

恢复是业务写入，必须在线：

1. 区分真正 v1/v2 旧备份与完整 v3 envelope；顶层 v3 缺少匹配 meta 或 conservation 时直接拒绝，不能降级伪装成旧格式；driver 裁剪视图或 `restorable:false` 的部分文件也必须在迁移前拒绝，不能作为全量恢复来源；
2. 在迁移前检查原始账期，再清洗为 schema v3；
3. 对 v3 声明和清洗结果执行 fuel/金额/数量守恒比较；
4. 显示当前与目标车辆、趟次、收入、支出、维修及结构化/旧油费摘要；
5. 提示来源 fleet 可能不同，明确登录身份不会改变；
6. 用户确认“完整替换当前账本”；
7. 用内容 fingerprint 与每次确认的随机标识生成 operation ID，以一个原子 API 批次提交；同次失败重试保留原 ID 和 payload；
8. 完整服务器回执后再次比较正式状态守恒，通过后才显示恢复成功。

相同文件重复导入不会重复记账。version 冲突返回 409，不覆盖新云端数据。当前单次上限为 500 operations；超过上限在客户端拒绝，不拆成可能部分成功的批次。

## 恢复耗时与错误处理（v1.6.1）

- D1 继续以单个原子批次完成关联记录、权限、父记录和版本守卫；不会把旧版备份拆成可能部分成功的多次上传。
- 保存请求等待完整回执的截止时间为 45 秒，其他请求为 20 秒；服务器本身超时仍需明确提示。
- 请求超时或服务器异常表示回执未知，保持只读及原待确认 payload，重新连接核对，不能宣称一定未保存或创建新 ID 盲目重试。
- 400/413/422 明确拒绝时保留表单供修正；v1/v2 的迁移规则、旧油费和 v3 守恒规则保持不变。

## 只读验证

推荐 Node.js 24：

```bash
npm test
node scripts/verify-backup.js /绝对路径/备份.json
git diff --check
```

`verify-backup.js` 会核对 schema v3、记录数、收入/支出/维修金额和完整 fuel 守恒。真实备份不得复制进仓库、写回原文件或上传第三方。
