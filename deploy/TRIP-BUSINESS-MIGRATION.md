# 去返程业务 JSON 增量迁移

目标文件：`supabase/migrations/20260908120000_trip_business.sql`。2026-09-08 已按项目所有者明确授权在生产执行，marker `[1,2,3]`、两处业务 JSON 列与对象约束已核验。本说明保留作为今后其他环境的操作流程；不要对当前生产重跑初始化。v1.9.0 的可选市县字段使用已有 JSON，不需要新 DDL。

## 前置条件

1. 已应用初始 schema marker 1 和恢复增量 marker 2。
2. 使用管理连接执行迁移；Netlify 中的 `ttq_app` 最小权限连接不应有 DDL 权限。
3. 先做可恢复备份，记录数据库 project ref 与当前 schema marker，并在隔离库执行同一脚本。

## 预检

```sql
SELECT version FROM ttq.schema_versions ORDER BY version;
SELECT COUNT(*) AS fleet_settings_rows FROM ttq.fleet_settings;
SELECT COUNT(*) AS trip_rows FROM ttq.trips;
```

既有生产库预期至少存在 marker 1/2，且两表当前没有 `business_json`。如果列或 marker 3 已存在，停止并核对迁移历史，不要重跑初始脚本。新建隔离库的完整初始化脚本已含列和约束，增量脚本可安全重放以补 marker 3；这不构成对既有生产库跳过预检的理由。

## 执行后验证

```sql
SELECT version FROM ttq.schema_versions ORDER BY version;
SELECT COUNT(*) FROM ttq.fleet_settings WHERE business_json <> '{}';
SELECT COUNT(*) FROM ttq.trips WHERE business_json <> '{}';
SELECT COUNT(*) FROM ttq.fleet_settings WHERE jsonb_typeof(business_json::jsonb) <> 'object';
SELECT COUNT(*) FROM ttq.trips WHERE jsonb_typeof(business_json::jsonb) <> 'object';
```

刚升级且尚未运行 v1.8.0 业务写入时，非空业务 JSON 数应为 0；两个非对象查询必须为 0。应用启动检查会要求 marker 1/2/3 俱全。

## 发布顺序

1. 在隔离环境通过迁移和 v3/v4 备份导入回归。
2. 生产维护窗口内先应用迁移，验证 marker/列/约束。
3. 再部署 v1.8.0 应用，用专用测试账号做一趟去程和一笔返程，确认首页营收口径。
4. 检查 Netlify 日志中无 schema 缺失、JSON 校验或 422 异常，再结束窗口。

## 回滚边界

这是添加列迁移，旧行默认 `{}`。应用发布后若只回滚代码，服务端会保留现有 `business_json`，不应立即删列。物理删列会丢失新业务资料，必须另行获得破坏性变更授权，先导出/验证数据并编写独立回滚脚本。
