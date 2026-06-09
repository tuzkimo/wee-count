# 一起记账（WeeCount）

离线优先、家庭/团队协同的资产级记账 App，移动端优先。

- 前端：Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS v4
- 客户端壳：Tauri 2.0（Android 为目标平台，桌面端仅用于开发调试）
- 本地存储：SQLite（`@tauri-apps/plugin-sql`）
- 后端：Go + PostgreSQL + Redis

## 功能状态

### Phase 2：账户管理（已完成）
- 资产/负债双类型体系（现金、银行卡、电子钱包 / 信用卡、花呗、美团月付、其他借贷）
- 净资产汇总（资产 - 负债）
- 负债账户支持信用额度、还款日字段
- 状态栏安全区适配（`safe-area-inset-top`）
- 通用 ConfirmDialog 组件（Teleport + scale 动画）
- 账户新增底部 Sheet（资产/负债分组选择）

### Phase 3：记账交易闭环（已完成）
- 分类体系：14 个预设分类（8 支出 + 6 收入），支持自定义
- 标签系统：支持创建、搜索、多选标签
- 交易 CRUD：收入/支出/转账三种类型，支持分类、账户、日期、金额、标签
- 流水列表：按日期分组展示，支持按账户过滤，点击进入编辑
- 底部 Tab 导航：记账/流水/账户/设置
- 数据持久化：categories/tags/transaction_tags 三张新表 + transactions 表迁移

## 路由

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | RecordPage | 记账页（新增模式） |
| `/record/:id` | RecordPage | 记账页（编辑模式） |
| `/transactions` | TransactionList | 流水列表，支持账户过滤 |
| `/accounts` | AccountList | 账户列表 + 净资产汇总 |
| `/accounts/:id/edit` | AccountEdit | 账户编辑页 |
| `/settings` | SettingsPage | 设置页（开发中） |
