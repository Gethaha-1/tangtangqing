# AI 接手手册（AI-GUIDE）

这份文档写给**下一个接手迭代的 AI**。目标是先按任务路由读取最少文件，再安全修改，不默认通读整个项目。

## 1. 快速接手三步

1. 先读本文件的「任务路由」；
2. 只读取与需求相关的代码和规则文档；
3. 涉及数据结构时额外读 `DATA-MIGRATION.md`，涉及趟号/账期/车辆/统计时额外读 `BUSINESS-RULES.md`。

### 任务路由

| 需求 | 必读 | 主要修改位置 |
|---|---|---|
| 趟号、旧账排序、账期、车辆、统计 | `BUSINESS-RULES.md` | `src/domain.js` + `index.html` 对应 render/交互 |
| v1/v2 备份、字段变更 | `DATA-MIGRATION.md` | `src/domain.js` + `tests/domain.test.js` |
| 首页/趟次/统计/维修页面 | `DESIGN.md` | `index.html` 的 [HTML-1] / [JS-3] |
| 发车、收车、补录、车辆弹层 | `DESIGN.md` | `index.html` 的 [HTML-2] / [JS-4] |
| 手势、返回键、金额键盘 | `ARCHITECTURE.md` §6–8 | `index.html` 的 [JS-4] |
| 报告、备份恢复 | `DATA-MIGRATION.md` | `index.html` 的 [JS-5] |
| 测试 | `TESTING.md` | `tests/` + `index.html` 的 [JS-6] |
| 登录、云同步、短信 | `BACKLOG.md` | 当前阶段不要实现 |

### 可直接复制的接手提示词

```
你好，请接手「趟趟清」v1.3.0（多车辆、可自定义账期的货运趟次记账）。

开工前请务必：
1. 先按 AI-GUIDE.md 的任务路由选文件；
2. 涉及趟次时读 BUSINESS-RULES.md；
3. 涉及数据字段时读 DATA-MIGRATION.md；
4. 涉及界面时读 DESIGN.md。

本次需求：______________________

交付要求：
- 最小改动，保持零外部依赖、零构建；
- 说明你改了哪些段落、为什么这样改；
- 在 CHANGELOG.md 里补一条记录；
- 告诉我如何验证：#test 自检 + TESTING.md 冒烟清单中受影响的步骤。
```

## 2. 红线清单（违反任何一条 = 返工）

1. **不擅改业务口径**：编号按车辆+账期、已收车按到家日期排序、维修单列；完整规则见 `BUSINESS-RULES.md`；
2. **本地阶段不引外部依赖**：没有 CDN、npm、外链字体图片；
3. **不加构建步骤**：当前 Netlify 继续静态部署；
4. **数据结构变更必须走迁移**：修改 `src/domain.js` 的迁移逻辑，并补 `tests/domain.test.js` 与真实备份守恒测试；
5. **所有用户输入渲染前过 `esc()`**；
6. **金额入口处两位小数、拒绝负数**；
7. **科目只软删除**（翻 `active`）；
8. 文案遵守 DESIGN.md §6 的语气（口语、动词开头、面向司机）；颜色只用 CSS 变量；
9. 弹层一律走 `openSheet/closeSheet`，不要自己 classList 开关（会破坏历史栈和返回键）；
10. 提交型按钮记得 `guardOnce()` 防连点；
11. 当前阶段不得接入账号、Supabase、短信或联网写入。

## 3. 改动流程

```
按任务路由定位文件
→ 先改 `tests/domain.test.js` 或 [JS-6] 断言
→ 最小 diff，风格贴合现有代码
→ 跑 Node 测试 + #test
→ 过 TESTING.md 冒烟清单中受影响的条目
→ CHANGELOG.md 记一条
→ 交付时说明改动点与验证方法
```

## 4. 常见任务菜谱

**修改趟号或账期规则**
先改 `tests/domain.test.js` → 改 `src/domain.js` → 更新 `BUSINESS-RULES.md` → 调整 `index.html` 展示 → 跑两套测试。

**加一个新弹层**
[HTML-2] 仿照现有 sheet 结构（`.sheet > .shead(‹ + h3) + .sbody`）→ 打开用 `openSheet($('#sheet-xxx'))` → 关闭后如需刷新下层，在 closeSheetVisual 的 `re` 映射表里加一项 → 交互走事件委托加 `data-*` 分支。

**加一个设置项**
defaultData().settings 加默认值（不用升 schema）→ 更多页 [HTML-1] 加行 + `data-go` → 委托里处理 → 自检加一条 `migrate(null).settings.xxx` 断言。

**改主题色 / 加颜色**
只动 [CSS-1] 变量或新增变量（两主题都要给值）→ DESIGN.md 令牌表同步。

**加一种报告**
[JS-5] 仿 `genReport`：先用 `TTQDomain` 取得账期和车辆范围内的数据，再复用 `#sheet-report`。

## 5. 坑清单（前人踩过的）

- 事件委托的 `q()` 匹配是有顺序的，新分支放错位置可能被上面的分支截胡；
- `closeSheet` 之后下层会按 `re` 映射自动重渲染——别在调用点重复渲染造成闪烁;
- `String.prototype.replace` 的字符串替换在本项目补丁脚本里被 split/join 取代过：替换文本含 `$$` 会被吞（`$('#x')` 安全，`$$('.x')` 不安全），写脚本处理本文件时注意；
- iOS 对 `background-attachment:fixed` 支持差，氛围渐变画在 `body::before(position:fixed)` 上，别挪回 body；
- 弹层开着刷新页面会残留历史格（BACKLOG 已登记），别试图在 unload 里"修"它，得不偿失；
- `tripSeq` 是按「车辆 + 当前账期 + 到家日期」动态编号，不能把展示趟号存进数据；
- `src/domain.js` 使用 UMD 形式，同时供浏览器和 Node 测试使用，改导出时两端都要验证。

## 6. 段落定位速查

| 想改什么 | 去哪 |
|---|---|
| 颜色/主题 | [CSS-1] |
| 趟号/账期/车辆/统计口径 | `src/domain.js`（先读 BUSINESS-RULES） |
| 某个页面长相 | [HTML-1] + [JS-3] 对应 renderXxx |
| 弹层行为 | [HTML-2] + [JS-4] |
| 键盘/滑动/手势/返回键 | [JS-4] |
| 备份/报告/启动 | [JS-5] |
| 自检 | [JS-6] |
