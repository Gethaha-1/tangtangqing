# 技术架构

适用版本：**v1.5.0 · 严格在线写入**。

## 1. 分层

| 层 | 位置 | 职责 |
|---|---|---|
| 登录页 | `app/page.tsx`、`app/chatgpt-auth.ts` | 展示 Sites 身份；已登录仍等待用户点“继续到账本” |
| 通用退出 | `lib/auth/logout.ts`、`app/auth/logout/route.ts` | 安全 `return_to`、provider 适配、本地退出 |
| 账本 UI | `legacy/ledger.html` | 浏览、表单、提案→确认→正式状态接线、JSON 交互 |
| 纯业务规则 | `src/domain.js` | schema v2 清洗、账期、趟号、排序、统计 |
| 云同步纯核心 | `src/cloud-sync.js` | 状态↔独立记录、diff、回执校验、旧缓存判定、在线状态机 |
| API | `app/api/bootstrap`、`app/api/sync` | 身份读取、原子写入契约、HTTP 状态 |
| 服务端 | `lib/server/` | fleet/role/assignment 授权、输入校验、D1 批次与幂等 |
| 持久化 | `db/`、`drizzle/` | D1 schema、运行时建表、正式 migration |
| Worker | `worker/index.ts` | 账本路由保护、静态资源、localhost 测试身份 |

成熟 UI 仍在单文件中，避免大重写。高风险逻辑已经在第一方纯模块或服务端边界中可测试：认证 provider、状态/记录转换、在线提交语义、原子 repository。

## 2. 身份与退出

```text
Sites 身份头
  → identities(provider, provider_subject)
  → users
  → fleet_members(role)
  → fleets
  → fleet-scoped business rows
```

- API 只信任 `oai-authenticated-user-*` 转发头。
- 请求体、query、localStorage 不能指定 user、fleet、role、membership 或 assignment。
- SIWC 是认证；fleet membership/role/assignment 是服务端业务授权。
- `/auth/logout` 是 UI 唯一稳定退出入口。生产委托 dispatcher-owned `/signout-with-chatgpt`；本地清理固定测试 cookie。
- `return_to` 只接受同源根相对路径，拒绝绝对 URL、`//`、反斜杠、控制字符和认证循环。
- 应用不实现 `/signin-with-chatgpt`、`/signout-with-chatgpt`、`/callback`。

## 3. 正式状态与设备状态

D1 是业务唯一正式状态。浏览器只保存：

- `tangtangqing-data`：旧版账本的只读迁移来源；
- `tangtangqing-cloud-cache-v1`：只在升级时检测一次的旧版待上传快照；新版本不再写；
- `tangtangqing-cloud-migration-v2`：旧账处理指纹；
- `tangtangqing-device-prefs-v1`：theme、当前车辆筛选、已查看报告月份；
- 冲突导出副本：仅用于人工核对，不自动上传。

未重新 bootstrap 时不展示未经重新授权的业务缓存。主题等设备偏好不进入 fleet settings 写入；历史 D1 字段保留以兼容 schema。

## 4. 严格在线状态机

```text
online
  → clone current confirmed S
  → mutate proposal in memory
  → plan record operations with expectedVersion
  → POST one operationId-bound atomic batch
  → validate complete acknowledgement
  → replace S from acknowledged baseline

network/server failure → keep old S + readonly + in-memory retry token
409 conflict           → keep old S + readonly + require reload/review
400/422 rejection      → keep old S + remain connected for corrected retry
401                    → return to login
```

相关提交控件在 saving 阶段锁定。失败表单仍留在当前 UI；失败提案不会成为正式记录，也不会写入自动续传缓存。

恢复网络后先 `/api/bootstrap`，重新核对身份、fleet、权限和版本。若上一次响应丢失，客户端只在远端仍安全时用原 `operationId` 和完全相同 operations 重放；服务器回放原回执。

## 5. 原子批次与幂等

每个业务动作是一批 operations：

- 新建 `expectedVersion=0`；
- 更新/删除必须匹配当前正整数 version；
- `operationId` 为 8–160 位稳定标识；
- 同 fleet + 同 ID + 同 request hash 返回原回执；
- 同 ID 不同 payload 返回 409；
- 任一 version guard、授权 guard、数据库约束或写入失败，D1 `batch()` 整批回滚。

`sync_assertions` 的 `CHECK(ok=1)` 把 membership、driver assignment 和记录 version 守卫放进同一事务；`sync_commits` 在同批保存请求 hash 与回执。删除趟次+子账、收车+多笔收入、车辆关联动作因此全成或全不成。

跨记录触发器继续保证：至少一辆启用车、在途车不可停用、停用车不可发车/迁入在途趟、含子账趟次不可删除。

## 6. JSON 恢复

JSON 导出/恢复本版继续开放。导入：

1. 解析并清洗 schema v2；
2. 显示当前与目标的数量/金额摘要、来源提示和完整替换确认；
3. 缺失/非法账期保留当前合法账期；
4. 保留软删除目录语义；
5. 用稳定导入指纹作为 operation ID，通过同一原子 API；
6. 只有完整回执后替换 UI。

单次最多 500 条变化。平台容量或超时导致的失败仍保证零部分写入；更大型专用 staging/import endpoint 在 backlog。

## 7. 不变业务口径

趟号、账期、车辆、金额和统计以 [BUSINESS-RULES.md](BUSINESS-RULES.md) 为准。联网改造不改变到家日归期、动态趟号、维修单列、金额两位小数和科目/有历史车辆软删除规则。

## 8. 构建与部署

`.openai/hosting.json` 只保存 Sites `project_id` 与逻辑 D1/R2 bindings。迁移保存在 `drizzle/`；`db/runtime-schema.ts` 支持本地/首次运行。构建输出和本地缓存不提交。
