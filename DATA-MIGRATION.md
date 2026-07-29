# 数据迁移与恢复

适用版本：**v1.5.0**。页面快照继续使用 `schemaVersion = 2`；D1 保存独立 fleet-scoped records。

## v1 → v2

历史 v1 输入统一经过 `TTQDomain.migrate()`：

- 自动建立“原有车辆”；
- 趟次和维修补 `vehicleId`；
- 金额清洗为非负数字；
- 缺失数组补齐；
- 业务内容不改名、不改变趟号口径。

注意：`migrate()` 会给缺失账期提供兼容默认值。JSON 导入预检必须先检查原文件账期；缺失、非法日期、倒序或超过 366 天时，明确提示并保留当前云端有效账期。

## schema v2 → D1

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

金额在 D1 中保存为整数分。每条记录有独立 version。客户端永远不提交 fleet/user/role/assignment。

## 旧账首次上云

`tangtangqing-data` 是旧账只读来源：

| 本机 / 云端 | 行为 |
|---|---|
| 本机有旧账，云端空 | 显示数量/金额摘要，明确选择上传或建立新账 |
| 双方有业务数据 | 不自动合并或覆盖；可导出本机 JSON，再进入云端 |
| 本机无旧账 | 使用云端；双方空则原子创建默认账本 |

上传使用单个稳定 operation ID 和原子 D1 batch；成功后重新 bootstrap 并做目标记录数量/金额守恒检查。旧 `tangtangqing-data` 默认保留，用迁移指纹避免重复提示。

## v1.4 旧待上传缓存升级

启动在线 bootstrap 后只检测一次 `tangtangqing-cloud-cache-v1`：

- 无差异：清理旧缓存，进入严格模式；
- 云端相关 version 未变：展示摘要，用户明确选择“在线核对并上传”或“只进入云端”；
- 本机和云端改过同一记录：停止上传，允许导出并保存冲突副本，进入云端时不覆盖。

处理后删除旧自动续传缓存。v1.5 不再产生新的业务快照缓存。

## JSON 导出

导出完整 schema v2，并附 `_backupMeta`：

- format；
- appVersion；
- exportedAt；
- sourceFleetId（若已知）。

元数据不参与业务同步；旧备份没有它仍可恢复。导出允许离线，不修改 `lastBackupAt` 或云端数据。

## JSON 恢复

恢复是业务写入，必须在线：

1. 解析 JSON 并确认基本 schema；
2. 在迁移前检查原始账期；
3. 清洗到 schema v2；
4. 保留科目/有历史车辆的软删除兼容目录；
5. 显示当前与导入后车辆、趟次、收入、支出、维修数量及金额；
6. 提示来源车队是否不同，明确登录身份不会改变；
7. 明确确认“完整替换当前账本”；
8. 用内容 fingerprint 派生稳定导入 operation ID；
9. 单个原子 API 提交；
10. 只有完整服务器回执后替换正式 UI。

相同文件重复导入不会重复记账：状态无差异时不写；响应丢失时幂等回放原回执。version 冲突返回 409，不覆盖新云端数据。

当前单次上限为 500 个 record operations。超过上限在客户端拒绝，不拆批。平台限制/超时导致失败时 D1 batch 仍为零部分写入。超大型专用导入 endpoint 见 backlog。

## D1 migration

- `0000_public_wildside.sql`：业务 schema、约束和 triggers；
- `0001_smart_the_twelve.sql`：`sync_commits` 幂等回执、`sync_assertions` 原子守卫。

任何 schema 更新必须同步 `db/schema.ts`、`db/runtime-schema.ts`、生成 SQL 和测试。

## 只读验证

```bash
npm test
node scripts/verify-backup.js /绝对路径/备份.json
```

真实备份不得复制进仓库、写回原文件或上传第三方。
