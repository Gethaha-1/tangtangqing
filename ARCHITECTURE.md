# 技术架构（ARCHITECTURE）

适用版本：v1.3.0。本文描述本地版应用结构与**不允许随意更改的硬约定**。

## 1. 总体思路

零外部依赖、零构建、本地优先。业务规则已经从页面中拆到 `src/domain.js`，其余界面暂留在 `index.html`，后续按 `AI-GUIDE.md` 的路由逐步拆分。

| 段落 | 职责 |
|---|---|
| [CSS-1] | 主题令牌：`body.theme-day`（宣纸账房）/ `body.theme-night`（瓷青泥金）两组 CSS 变量 |
| [CSS-2] | 通用布局与组件样式（panel / btn / sheet / chips / pad / nav / stamp…） |
| [CSS-3] | 各视图专属样式 |
| [HTML-1] | 五个主视图容器：home / trips / stats / maint / more |
| [HTML-2] | 弹层（sheet）：发车 / 快记 / 收车 / 详情 / 补录 / 账期 / 车辆 / 科目 / 报告 / 确认 |
| [JS-1] | 存储适配层 Store + defaultData + migrate（含导入数据清洗） |
| [JS-2] | 页面工具函数 + 对 `TTQDomain` 的业务调用 |
| [JS-3] | 视图渲染 render*（全量重渲染） |
| [JS-4] | 键盘 makePad / 滑动收车 initSlide / 弹层栈与历史栈 / 事件委托 / 手势 |
| [JS-5] | 报告生成 / 备份恢复 / 主题 / 启动 init |
| [JS-6] | 内置自检 runSelfTests（`#test` 触发） |
| `src/domain.js` | schema v2 迁移、账期范围、到家日期排序、分车趟号、单车/汇总统计 |
| `tests/domain.test.js` | 可在 Node 中执行的纯业务规则测试 |
| `scripts/verify-backup.js` | 真实备份升级前后数量与金额守恒校验 |

## 2. 数据模型（schemaVersion = 2）

```js
{
  schemaVersion: 2,
  settings: {
    theme: 'day' | 'night',
    lastReportSeen: 'YYYY-MM',   // 已读过的月报横幅
    lastBackupAt: 'YYYY-MM-DD',
    activeVehicleId: 'all' | vehicleId,
    periodStartDate: 'YYYY-MM-DD',
    periodEndDate: 'YYYY-MM-DD'
  },
  vehicles: [{
    id, name, plateNo, active, createdAt
  }],
  categories: {
    expense: [{ id, name, icon, builtin, active }],  // 软删除：active=false，不物理删
    income:  [{ id, name, icon, builtin, active }]
  },
  trips: [{
    id, vehicleId, startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' | null,
    status: 'open' | 'closed', createdAt: ISOString, closedAt?: ISOString,
    expenses: [{ id, catId, amount, date, note }],
    incomes:  [{ id, catId, amount, date }]          // 收入按科目聚合，一科目一条
  }],
  maintenance: [{ id, vehicleId, date, amount, note }]
}
```

## 3. 硬约定（改前必须三思，改动即破坏历史数据语义）

1. **趟次编号口径**：按「车辆 + 当前账期」分组，已收车趟按【到家日期 endDate】正序编号；编号动态计算，补录旧账会使同车后续趟号顺延。
2. **列表排序口径**：已收车趟按到家日期倒序；在途趟暂按发车日期排序并显示预计趟号。
3. **利润归属口径**：只统计账期内已收车趟，整趟收入和支出按到家日期归入账期。
4. **维修口径**：维修按自身日期和车辆归属，单独列账，不计入趟次利润。
5. **在途限制**：每辆车最多一个在途趟；不同车辆可以同时在途。
6. **车辆软停用**：有历史记录的车辆不物理删除；在途车不能停用；至少保留一辆启用车。
7. **金额规则**：入口处统一 `Math.round(x*100)/100` 保留两位小数；不允许负数。
8. **科目软删除**：只翻转 `active`，绝不物理删除。
9. **所有用户输入渲染前必须过 `esc()`**（防 XSS）。

完整口径以 [BUSINESS-RULES.md](BUSINESS-RULES.md) 为准。

## 4. 状态流

全局唯一状态 `S`（单一数据源）。任何操作三步走：**改 S → save() → 重渲染当前视图/弹层**。

- `save()`：150ms 防抖后调 `Store.save(S)`；**失败会 toast 警告用户**（v1.2.0）。
- 渲染是全量 innerHTML 重建。动态元素一律不单独绑事件，靠 document 级事件委托 + `data-*` 属性路由（见 [JS-4] 的全局 click 监听）。给新元素加交互 = 加一个 `data-xxx` 属性 + 在委托里加一个分支。

## 5. 存储适配层与迁移

- 三级降级：localStorage（正常）→ window.storage（Claude 预览环境，首页会挂"预览模式"横幅）→ 内存（兜底，数据不落盘）。
- `src/domain.js` 的 `TTQDomain.migrate()` 是唯一迁移入口；
- v1 → v2 自动创建「原有车辆」并给旧趟次、旧维修补 `vehicleId`；
- 金额、日期、ID、科目和备注不改写；金额仅做数字类型清洗；
- 规则详见 [DATA-MIGRATION.md](DATA-MIGRATION.md)。

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

全量重渲染 + 动态 `tripSeq` 在几百趟/账期的量级下足够。若未来达到数千趟，先为「车辆 + 账期」建立一次性编号缓存。联网阶段开始前再决定是否引入构建工具，不在本地阶段提前加入框架。
