# 趟趟清 · 货运趟次记账

一个给货运车主和司机使用的多车辆趟次账本。

- 当前版本：**v1.4.0 · 第一阶段联网保存**
- 正式数据源：Codex Sites D1（本地开发使用兼容的本地 D1）
- 登录方式：Sites 原生 Sign in with ChatGPT
- 业务规则：`src/domain.js` 与 [BUSINESS-RULES.md](BUSINESS-RULES.md)
- 设计语言：日间「宣纸账房」/ 夜间「瓷青泥金」（见 [DESIGN.md](DESIGN.md)）

这一阶段先让车主使用：登录后可查看和记录所属车队的全部车辆。数据归属于内部 `fleet`，不直接归属于邮箱；`owner` / `driver` 角色和司机车辆分配已经进入服务端模型，但司机登录、邀请和分配界面留到第二阶段。

## 本地启动

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm test
npm run build
npm run dev
```

打开开发服务器打印的 Local URL。`localhost` 登录页会额外显示「用本地测试账号进入」：

- 测试身份：`local-owner@ttq.test`
- 不需要密码；
- 该替身只在 `localhost`、`127.0.0.1` 或 `[::1]` 生效；
- 点击退出可清除本地测试会话。

本地替身只用于验证页面和权限流程。正式环境的身份头由 Sites 登录分发层提供，客户端不能自行指定邮箱、用户、车队或角色。

## 第一次打开账本

v1.4.0 会检测旧浏览器中的 `tangtangqing-data`（schema v2），但 localStorage 不再是正式账本。

1. **本机有旧账、云端为空**：页面列出车辆、趟次和金额摘要，必须由用户明确选择「核对并上传到云端」或「先建一个新的云端账本」。
2. **本机和云端都有账**：绝不自动合并或覆盖；先导出本机 JSON 备份，再明确选择进入云端账本。
3. **本机没有旧账**：云端已有数据就直接读取；两边都空则建立新的云端账本。

上传按车辆、趟次、收入、支出、维修等独立记录执行，并在回读后核对数量和金额守恒。重复执行只会提交相对于云端基线的差异，不会重复记账。旧 localStorage 在迁移后仍保留，便于人工复核。

完整流程见 [DATA-MIGRATION.md](DATA-MIGRATION.md)。

## 保存、断网与备份

- D1 是正式数据源；localStorage 只用于旧账迁移来源、设备缓存和设备偏好。
- 每次变更按独立记录携带 `expectedVersion` 保存，不会用一整份 JSON 覆盖其他车辆或其他记录。
- 保存失败或发生版本冲突时，界面会明确显示「尚未上传」或「云端有新改动」，不会把设备缓存说成云端成功。
- 浏览器设备缓存写入失败时会要求立即导出 JSON，不会谎称改动已经留在设备。
- 已打开账本后断网，新改动会暂存在当前设备并明确标记；重新加载前必须恢复网络，让服务端先确认身份和车队，再安全续传。
- JSON 导出和恢复仍然保留。建议每月导出一份并保存到自己的可靠位置。

## 仓库结构

```text
app/                    登录页、认证 helper、bootstrap/sync API
worker/                 Sites Worker 入口、登录保护和 localhost 测试身份
db/                     D1/Drizzle schema 与运行时建表
drizzle/                已生成并保存的 SQL migrations
lib/server/             服务端身份、车队初始化、授权、校验和逐记录同步
legacy/ledger.html      原账本 UI；保留成熟交互和业务体验
src/domain.js           趟号、账期、车辆和统计规则
src/cloud-sync.js       schema v2 与云端独立记录之间的适配层
tests/                  业务规则、迁移守恒、授权边界和并发版本测试
scripts/                构建前复制账本资源、真实备份守恒校验
.openai/hosting.json    Sites 逻辑绑定：D1=`DB`，R2 未使用
```

`npm run dev` 和 `npm run build` 会先把 `legacy/ledger.html`、`src/domain.js`、`src/cloud-sync.js` 复制到生成目录 `public/ledger/`。不要直接修改生成目录。

## 测试

```bash
npm test
npm run build
node scripts/verify-backup.js /绝对路径/趟趟清备份.json
```

登录后还应在 `/ledger#test` 运行浏览器内置 28 项自检，并完成 [TESTING.md](TESTING.md) 的联网、迁移、断网和原业务冒烟清单。Node 测试还包含恶意备份渲染、D1 正式 migration、跨记录原子约束和双端三方合并。

## 当前交付边界

这是 **local-only** 的第一阶段实现：仓库已适配 Sites 和 D1，但本轮没有创建 Sites 项目，没有部署生产环境，没有推送 GitHub，也没有创建 PR。先由用户在本地验证。

第二阶段再开放：

- 司机邀请、登录、加入车队和车辆分配流程；
- 手机号、短信验证码及多身份绑定；
- 更完整的离线队列、自动重试与冲突处理界面；
- 生产部署、监控、备份与恢复演练。
