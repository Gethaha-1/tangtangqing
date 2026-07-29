# 测试

适用版本：**v1.5.0 · 严格在线写入**。全部测试使用独立本地 D1/测试车队；不得用唯一真实账本做破坏性验证。

## 1. 自动化与构建

```bash
npm install
npm test
npm run lint
npx tsc --noEmit
npm run build
```

覆盖：

| 文件 | 重点 |
|---|---|
| `tests/domain.test.js` | v1→v2、账期、趟号、车辆统计 |
| `tests/cloud-sync.test.js` | record 转换、expectedVersion、回执、严格状态机、旧缓存显式处理、主题设备偏好、JSON 账期安全 |
| `tests/server-api.test.mjs` | 可信身份、ownership 拒绝、原子 guard、D1 constraints/migrations |
| `tests/auth-logout.test.mjs` | 通用退出、provider 委托、本地 cookie、安全 return_to |
| `tests/legacy-xss.test.mjs` | 恶意备份持久化 XSS |

schema 改动还要运行：

```bash
npm run db:generate
```

检查生成 migration 只含预期表、索引、外键和 constraints。

## 2. 本地登录与退出

运行 `npm run dev`，使用输出的 Local URL：

1. 未登录 `/` 显示 ChatGPT 登录和“仅本地测试”入口。
2. 未登录 `/ledger` 返回登录页，不显示账本。
3. 本地测试入口建立 HttpOnly cookie 并进入 `/ledger`。
4. 回到 `/` 后仍显示“继续到账本”；不得自动跳转。
5. 首页和账本退出均先走 `/auth/logout`。
6. localhost 退出清除测试 cookie；再访问 `/ledger` 被拦截。
7. 生产 provider 适配只重定向 dispatcher-owned `/signout-with-chatgpt`；worker/app 不实现保留路由。
8. 外部 URL、`//host`、反斜杠、控制字符和认证循环 `return_to` 降级 `/`。
9. 无可信身份访问 `/api/bootstrap`、`/api/sync` 返回 401；账本请求收到 401 后回登录页。

## 3. 在线提交状态机

对每个动作观察正式 UI 与 API：

1. 提交后显示“正在保存”，相关写入口锁定。
2. 服务端 200 且完整回执后才显示新记录和成功 toast。
3. 收车+多笔收入、删除趟次+子账、JSON 恢复各是一批。
4. 相同 `operationId` + 同 payload 重试返回 `replayed:true`，无重复记录。
5. 同 ID + 不同 payload 返回 409。
6. 预检后 version 改变，transaction 内 guard 让整批 409、零写入。
7. 一条触发 UNIQUE/CHECK/业务 constraint，整批 422、零写入。
8. membership/role/driver assignment 在预检后变化，transaction 内 authorization guard 中止整批。

## 4. 失败、离线、恢复

1. 成功加载后模拟 fetch 网络失败，再提交一笔。
2. 正式列表/统计保持提交前状态；表单内容仍留在当前页。
3. 页面显示只读横幅，不出现“已保存”或“设备已暂存”。
4. 只读时验证所有业务写入口：发车、快记、收车、补录、维修、车辆、科目、账期、删除、隐藏弹层/手势、JSON 导入均被统一拦截。
5. 浏览、统计、详情、JSON 导出和主题/车辆筛选仍可用。
6. 浏览器 `online` 事件只提示重连，不直接解锁。
7. 点重连后先 bootstrap；成功后才恢复可写。
8. 若上次响应丢失且服务端已提交，重放同 ID 获得回执；若远端 version 已变则 409，不上传本地快照。
9. 重新加载且 bootstrap 不可达时，不展示旧业务缓存。
10. 有未确认请求时点退出：等待进行中请求；仍不确定则阻止退出并允许导出未确认内容。

## 5. 首次迁移与旧缓存

分别用新浏览器资料：

- 旧账 + 空云端：摘要 → 明确上传/建新账 → 守恒回读；
- 旧账 + 有数据云端：不合并、不覆盖，可导出后进入云端；
- 无旧账：读取云端或创建默认账本；
- v1.4 cache 无差异：清理，不提示上传；
- cache 安全差异：明确选择后才上传；
- cache 与云端同记录冲突：停止上传，可导出冲突内容。

处理完成后确认新版本不再创建 `tangtangqing-cloud-cache-v1`。

## 6. JSON

1. 在线和离线都能导出完整 JSON。
2. 导出带可选 source fleet 元数据；账号/token 不在文件中。
3. 导入前显示当前/目标车辆、趟次、收入、支出、维修数量和金额。
4. 不同来源 fleet 明确提示，登录身份不变。
5. 合法账期只有在完整替换确认后恢复。
6. 缺失、非法日期、倒序、超过 366 天账期保留当前账期。
7. 取消确认不发送请求。
8. 服务器不可达、422、409 时正式状态不变。
9. 同文件重复导入幂等。
10. 超过 500 operations 明确拒绝且零部分写入。

可用只读脚本核对真实备份：

```bash
node scripts/verify-backup.js /绝对路径/备份.json
```

## 7. 原业务与浏览器自检

登录后打开 `/ledger#test`，应弹出全部通过的自检报告。然后冒烟：

- 两辆车分别发车，同车重复发车被拦截；
- `300+250` 快记，快速双击不重复；
- 零收入收车提醒，多收入原子保存；
- 修改/删除收入支出、补录旧账、动态趟号；
- 科目软删除、车辆停用规则；
- 跨自然年账期；
- 维修单列；
- 返回键/手势关闭弹层；
- 主题离线切换并刷新保留。

## 8. 部署前后

部署前：

- `git diff --check`
- 搜索敏感信息、真实备份、认证 token
- 核对 `.openai/hosting.json` 项目 ID
- 核对 `drizzle/0001_smart_the_twelve.sql`
- 确认 `node_modules`、`dist`、`.wrangler`、`public/ledger` 未跟踪
- 本地有意义 commit，`commit_sha` 与推送 Sites source 状态一致

部署后在生产 URL 验证：

- 登录页不自动跳账本；
- SIWC 会话和退出；
- bootstrap、正常保存、401/409；
- JSON 导入导出；
- `/ledger#test`；
- deployment 状态为 succeeded。
