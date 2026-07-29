# 待办与已知取舍

适用版本：**v1.5.0**。

## 后续优先事项

1. 司机邀请、加入 fleet、assignment 管理和司机端 UI。
2. 手机号/短信 identity，与现有内部 user 的显式安全绑定。
3. 逐条冲突解决界面，展示本次表单值与云端值。
4. 面向普通用户的 Excel 导出；在严格在线/断网保护得到生产验证前，JSON 导入导出继续保留。
5. 操作审计、错误监控、容量告警、D1 备份和恢复演练。
6. iPhone Safari、安卓 Chrome、微信内浏览器真机回归。

## 大型 JSON 导入

当前完整恢复使用单个 D1 原子 batch，最多 500 个 record operations。D1 每次 Worker invocation 的查询数和 30 秒执行时间仍可能让 200–500 条的大型导入失败；失败保证零部分写入。

后续应设计专用 staging/import API：先把文件放入隔离 staging，服务端单语句/受控事务校验并替换，再产生一份回执。完成前不得恢复旧的客户端 200 条 chunking，因为那会破坏“完整恢复全成或全不成”。

## 已知取舍

- 第一阶段 UI 只开放 owner；driver 数据模型和授权 guard 已存在，但完整产品流程尚未开放。
- 网络失败提案只保存在当前页面内存；刷新会丢失未提交表单，这是“不让失败快照自动覆盖云端”的安全选择。
- `sync_commits` 暂未实现定期清理策略；需要结合审计保留期后再做。
- ChatGPT provider subject 当前来自 Sites 转发邮箱，只存在 identity 层，不扩散到业务表。
- 主题、当前车辆筛选、已查看报告为设备偏好，不跨设备同步。
- 趟号是动态展示值；补录旧账会让后续趟号顺延。
- 弹层刷新历史格和 iOS 边缘手势仍需真机长期观察。

## 依赖与磁盘

本版非忽略源码/文档约 1.0 MiB；安装后的数百 MiB 主要来自 Next/Vinext/Cloudflare 编译和本地 runtime。保持生成目录 gitignore 比删除少量类型包更有收益。

审计发现 `@cloudflare/workers-types` 是较明确的未使用候选，`@types/react-dom` 是低收益候选。本版安全改造不移除它们；若后续精简，必须在 clean `npm ci` 后分别验证 lint、typecheck、build、migration 生成和本地 D1。

## 禁止提前做

- 不引入第二套状态管理、认证、离线同步或 Excel 重依赖；
- 不把 JSON 隐藏为 localhost-only；
- 不推送 GitHub 旧生产项目；
- 不用邮箱作为 fleet/账本主键；
- 不用自动离线快照替代严格在线写入。
