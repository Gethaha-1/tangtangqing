# 趟趟清 · 货运趟次记账

一个给货车司机用的多车辆趟次记账本。当前版本没有服务器、不要账号，数据只存在自己手机浏览器里。

- 当前版本：**v1.3.0**（见 [CHANGELOG.md](CHANGELOG.md)）
- 应用入口：`index.html`
- 核心业务规则：`src/domain.js`
- 设计语言：日间「宣纸账房」/ 夜间「瓷青泥金」（见 [DESIGN.md](DESIGN.md)）

## 这是给谁用的

一趟一趟跑运输、同时管理多辆车的司机：每辆车有自己的趟次、维修和账期统计，「汇总」目录集中显示全部车辆收益。补录旧账后按到家日期自动插入正确趟号。

## 怎么用（手机安装）

当前版本包含 `index.html` 和 `src/domain.js`，正式使用推荐通过 Netlify 地址打开，不再只分发一个 HTML 文件。

电脑上直接双击 `index.html` 即可打开试用。

## ⚠️ 数据安全铁律（务必告诉使用者）

数据存在浏览器的 localStorage 里，这意味着：

1. **固定用同一个浏览器打开**——换浏览器 = 换了一个空账本；
2. **不要清理该浏览器的"网站数据/缓存"**——清了账本就没了；
3. **每月备份一次**：更多 → 备份数据，把导出的文件发到自己微信收藏。首页会在超过 30 天没备份时自动挂横幅提醒；
4. 换手机时：旧手机导出备份 → 新手机「恢复备份」导入。

应用在保存失败时会弹出警告提示，看到警告立即导出备份。

## 仓库结构

```
index.html        页面、样式和主要交互
src/domain.js     趟号、账期、多车辆统计和 v1→v2 迁移
tests/            不依赖浏览器的业务规则测试
scripts/          真实备份只读迁移校验
BUSINESS-RULES.md 趟号、账期、车辆和统计口径
DATA-MIGRATION.md 备份结构与迁移守恒规则
README.md         本文件
ARCHITECTURE.md   技术架构：分层、数据模型、硬约定、机制详解
DESIGN.md         设计系统：双主题令牌、组件规范、文案语气
TESTING.md        测试：内置自检用法、手工冒烟清单
AI-GUIDE.md       给 AI 的接手手册（迭代前必读）
CHANGELOG.md      版本变更记录
BACKLOG.md        待办、已知取舍、候选功能池
```

## 自检

浏览器打开应用，在地址末尾加上 `#test` 回车刷新，会弹出自检报告（当前 28 项断言）。业务规则还可执行 `node --test tests/domain.test.js`。详见 [TESTING.md](TESTING.md)。

## 迭代方式

本项目为"AI 协作迭代"而设计。接手时先读 [AI-GUIDE.md](AI-GUIDE.md) 的任务路由，不要默认通读全部代码；涉及趟号、账期、车辆或统计时，再读 [BUSINESS-RULES.md](BUSINESS-RULES.md) 和 `src/domain.js`。

改动的基本流程：**最小 diff → 跑 `#test` 自检 → 过一遍手工冒烟清单 → 在 CHANGELOG.md 记一条 → 提交**。

## 技术栈

原生 HTML / CSS / JavaScript（ES6+），零外部依赖、零构建。`src/domain.js` 同时支持浏览器和 Node 测试；localStorage 持久化带 schema v2 迁移；Pointer/Touch Events 实现滑动收车与手势返回；History API 接管系统返回键；Clipboard / Web Share API 分享报告。
