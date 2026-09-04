# 待办与已知取舍

适用版本：**v1.5.1-supabase.0 + Unreleased 批量快记**。

## 后续优先事项

1. 司机邀请、加入 fleet、assignment 管理和司机端 UI。
2. 手机号/短信 identity，与现有内部 user 的显式安全绑定。
3. 逐条冲突解决界面，展示本次表单值与云端值。
4. 面向普通用户的 Excel 导出；在严格在线/断网保护得到生产验证前，JSON 导入导出继续保留。
5. 操作审计、错误监控、容量告警、Supabase PostgreSQL 备份和恢复演练。
6. iPhone Safari、安卓 Chrome、微信内浏览器真机回归。

## 大型 JSON 导入

当前完整恢复使用单个 PostgreSQL SERIALIZABLE 事务，最多 500 个 record operations。Netlify Functions 执行时限、跨区网络和数据库事务时长仍可能让大型导入失败；失败必须保持零部分写入。

后续应设计专用 staging/import API：先把文件放入隔离 staging，服务端单语句/受控事务校验并替换，再产生一份回执。完成前不得恢复旧的客户端 200 条 chunking，因为那会破坏“完整恢复全成或全不成”。

## 已知取舍

- 第一阶段 UI 只开放 owner；driver 数据模型和授权 guard 已存在，但完整产品流程尚未开放。
- 网络失败提案只保存在当前页面内存；刷新会丢失未提交表单，这是“不让失败快照自动覆盖云端”的安全选择。
- `sync_commits` 暂未实现定期清理策略；需要结合审计保留期后再做。
- Supabase user id 只存在 identity 层；邮箱和显示名不作为 fleet 或账本主键。
- 主题、当前车辆筛选、已查看报告为设备偏好，不跨设备同步。
- 趟号是动态展示值；补录旧账会让后续趟号顺延。
- 弹层刷新历史格和 iOS 边缘手势仍需真机长期观察。

## 禁止提前做

- 不引入第二套状态管理、认证、离线同步或 Excel 重依赖；
- 不把 JSON 隐藏为 localhost-only；
- 不在未核对目标站点、分支和 Supabase project ref 时部署；
- 不用邮箱作为 fleet/账本主键；
- 不用自动离线快照替代严格在线写入。
