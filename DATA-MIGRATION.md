# 数据迁移（DATA-MIGRATION）

适用版本：v1.3.0，当前 `schemaVersion = 2`。

## v1 → v2

新增：

- `vehicles[]`
- `trips[].vehicleId`
- `maintenance[].vehicleId`
- `settings.activeVehicleId`
- `settings.periodStartDate`
- `settings.periodEndDate`
- 新收车趟可带 `closedAt`

迁移规则：

1. 自动创建 `{ id: "vehicle_legacy", name: "原有车辆" }`；
2. 所有旧趟次和维修记录归入这辆车；
3. 旧金额、日期、科目、备注、ID 和创建时间不改写；
4. 默认账期为迁移当年的 1 月 1 日至 12 月 31 日；
5. 导入和启动加载统一经过 `TTQDomain.migrate()`；
6. 导出备份直接导出 v2 完整状态。

## 验证方式

通用逻辑测试：

```bash
node --test tests/domain.test.js
```

验证一份真实备份升级前后数量和金额守恒：

```bash
node scripts/verify-backup.js /绝对路径/趟趟清备份.json
```

脚本会核对：

- 趟次数；
- 维修记录数；
- 收入和支出科目数；
- 趟次收入、趟次支出和维修金额总和；
- 所有趟次和维修记录是否具有车辆归属。

真实账本文件只作为本地测试输入，不复制进仓库、不写回原文件。
