# 技术架构（ARCHITECTURE）

适用版本：v1.2.0。本文描述 `index.html` 的内部结构与**不允许随意更改的硬约定**。

## 1. 总体思路

单文件、零依赖、本地优先。整个应用 = 一个 HTML 文件里的六个段落，用注释块 `[CSS-1] ... [JS-6]` 标出（文件头部有索引）：

| 段落 | 职责 |
|---|---|
| [CSS-1] | 主题令牌：`body.theme-day`（宣纸账房）/ `body.theme-night`（瓷青泥金）两组 CSS 变量 |
| [CSS-2] | 通用布局与组件样式（panel / btn / sheet / chips / pad / nav / stamp…） |
| [CSS-3] | 各视图专属样式 |
| [HTML-1] | 五个主视图容器：home / trips / stats / maint / more |
| [HTML-2] | 弹层（sheet）：发车 / 快记 / 金额盘 / 收车 / 详情 / 补录 / 科目 / 报告 / 确认 |
| [JS-1] | 存储适配层 Store + defaultData + migrate（含导入数据清洗） |
| [JS-2] | 工具函数 + **统计口径**（硬约定） |
| [JS-3] | 视图渲染 render*（全量重渲染） |
| [JS-4] | 键盘 makePad / 滑动收车 initSlide / 弹层栈与历史栈 / 事件委托 / 手势 |
| [JS-5] | 报告生成 / 备份恢复 / 主题 / 启动 init |
| [JS-6] | 内置自检 runSelfTests（`#test` 触发） |

## 2. 数据模型（schemaVersion = 1）

```js
{
  schemaVersion: 1,
  settings: {
    theme: 'day' | 'night',
    lastReportSeen: 'YYYY-MM',   // 已读过的月报横幅
    lastBackupAt: 'YYYY-MM-DD'   // 上次导出备份日期（v1.2.0 新增）
  },
  categories: {
    expense: [{ id, name, icon, builtin, active }],  // 软删除：active=false，不物理删
    income:  [{ id, name, icon, builtin, active }]
  },
  trips: [{
    id, startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' | null,
    status: 'open' | 'closed', createdAt: ISOString,
    expenses: [{ id, catId, amount, date, note }],
    incomes:  [{ id, catId, amount, date }]          // 收入按科目聚合，一科目一条
  }],
  maintenance: [{ id, date, amount, note }]
}
```

## 3. 硬约定（改前必须三思，改动即破坏历史数据语义）

1. **趟次编号口径**：按【发车日期】所在年分组、年内按发车日期排序编第 N 趟。编号是动态算的，补录旧账会使后续趟号整体后移（已在 BACKLOG 登记为已知取舍）。
2. **利润归属口径**：只统计已收车（closed）的趟，按【到家日期 endDate】归入月/年——"钱到家才算落袋"。在途趟的支出不进年度合计，只在首页"当前趟"卡片单独展示。
3. **维修口径**：维修保养单独立账（maintenance），**不计入**趟次利润，仅在年度统计中单列展示。
4. **同时只允许一个在途趟**：`openTrip()` 返回当前 open 趟，发车前必须查。
5. **金额规则**：入口处统一 `Math.round(x*100)/100` 保留两位小数；不允许负数（evalExpr 对负项返回 NaN）。
6. **科目软删除**：只翻转 `active`，绝不物理删除，否则历史账目失去科目引用（`catById` 对丢失引用兜底显示"（已删科目）"）。
7. **单文件、零依赖、零构建**：不引入任何外部 JS/CSS/字体/图片。
8. **所有用户输入渲染前必须过 `esc()`**（防 XSS）。

## 4. 状态流

全局唯一状态 `S`（单一数据源）。任何操作三步走：**改 S → save() → 重渲染当前视图/弹层**。

- `save()`：150ms 防抖后调 `Store.save(S)`；**失败会 toast 警告用户**（v1.2.0）。
- 渲染是全量 innerHTML 重建。动态元素一律不单独绑事件，靠 document 级事件委托 + `data-*` 属性路由（见 [JS-4] 的全局 click 监听）。给新元素加交互 = 加一个 `data-xxx` 属性 + 在委托里加一个分支。

## 5. 存储适配层与迁移

- 三级降级：localStorage（正常）→ window.storage（Claude 预览环境，首页会挂"预览模式"横幅）→ 内存（兜底，数据不落盘）。
- **迁移规则**：
  - 结构性变更（trips/categories 加必填字段等）→ `SCHEMA_VER` +1，并在 `migrations` 表加 `旧版本+1: (d)=>{...; d.schemaVersion=N; return d}`；
  - 仅给 `settings` 加字段 → 不用升版本，`migrate()` 里的 `Object.assign(base.settings, d.settings)` 默认值合并会自动补上（`lastBackupAt` 即此例）；
  - `migrate()` 末尾有**数据清洗**：所有金额强转数字、坏值归 0、缺失数组补齐——恢复备份的数据同样过这一关。

## 6. 弹层栈 + 历史栈（系统返回键，v1.2.0）

目标：安卓手势/实体返回键 = 关最上层弹层，而不是退出网页。

- `openSheet(el)`：入 `sheetStack` + `history.pushState` 占一格历史；
- UI 内关闭（‹ 按钮 / 左缘右滑 / 下拉 / 保存后）走 `closeSheet(el)` → 先视觉关闭，再 `expectPop++` 并 `history.back()` 消掉那格历史；
- 用户按系统返回键 → `popstate` 事件 → `expectPop > 0` 说明是程序自己 back 的，消耗计数直接返回；否则调 `closeTopSheet()` 只做**视觉关闭**（历史已被浏览器消费，不能再 back）；
- `closeAllSheets()` 一次 `history.go(-n)` 只会触发**一个** popstate，所以 `expectPop` 计的是"待到达的 popstate 事件数"，不是历史格数；
- `pushState` 抛异常（极老浏览器）→ `historyOK=false`，整套机制静默退化为纯视觉开关。

已知边界：弹层开着时刷新页面，会残留已推入的历史格，之后第一次按返回键会"没反应"（消耗残留格），再按才退出。无害，登记于 BACKLOG。

## 7. 防连点 / 防穿透（v1.2.0）

- `guardOnce()`：600ms 全局锁，用在所有"提交型"动作（键盘 OK、确认发车、补录入账、新建科目）；
- `tapShield()`：关弹层瞬间铺一层 350ms 的全屏透明挡板，吃掉双击的第二下，防止穿透误触下层元素。

## 8. 组件复用点

- `makePad(padEl, dispEl, eqEl, okLabel, onOk)`：数字键盘工厂，支持 `300+250` 连加；返回 `{reset, setOk}`，`setOk` 用于金额盘按场景换按钮文案；
- `openAmtPad(cfg)`：通用金额弹层，配置项 `{title, expr, showDate, date, showNote, note, okLabel, canDelete, catId, onSave(v,date,note), onDelete}`；传 `catId` 时会显示科目 chips（用于"改一笔支出顺手改科目"）；
- `ask(msg)`：Promise 化确认框；`toast(msg)`：轻提示；
- `initSlide(el, onDone)`：滑动确认组件，元素上挂 `ttqReset()` 供校验失败时回弹。

## 9. 性能与规模边界

全量重渲染 + `tripSeq` 的 O(n²) 在几百趟/年的量级下毫无压力（<10ms）；若未来到数千趟，优先给 `tripSeq` 做一次性编号缓存，而不是引框架。单文件超过约 3000 行时再考虑拆分构建，当前不做。
