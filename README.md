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

### Phase 4：UI 重构优化（已完成）
- 路由重构：流水首页（`/`）、账户详情（`/accounts/:id`）、记账页、筛选页
- 底部 Tab：首页/报表/账户/我的（记账页和筛选页隐藏 Tab）
- 首页：净资产/收支汇总卡片 + 流水列表 + FAB 记账按钮
- 账户详情：当前余额 + 收入/支出合计 + 流水列表（自动按账户过滤）
- 自定义计算器键盘（CalculatorKeypad）：九宫格 + 运算符 + 完成/再记一笔
- 日期时间选择面板（DateTimeSheet）：底部弹出，支持日期+时间或纯日期
- 全屏筛选页（FilterPage）：按账户/日期范围/标签筛选，应用后回首页
- 报表页/我的页（占位）
- 账户编辑页
- Bug 修复：负债余额 SQL 公式修正、路由 query 响应式更新、键盘布局修复等

## 路由

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | TransactionList | 流水首页，含净资产汇总卡片 + FAB |
| `/record` | RecordPage | 记账页（新增模式，隐藏 Tab） |
| `/record/:id` | RecordPage | 记账页（编辑模式，隐藏 Tab） |
| `/filter` | FilterPage | 筛选页（全屏，隐藏 Tab） |
| `/accounts` | AccountList | 账户列表 + 净资产汇总 |
| `/accounts/:id` | TransactionList | 账户详情（余额 + 流水，自动过滤） |
| `/accounts/:id/edit` | AccountEdit | 账户编辑页 |
| `/reports` | ReportsPage | 报表页（占位） |
| `/me` | MePage | 我的页（占位） |
| `/transactions` | → `/` | 旧路由重定向 |
| `/settings` | SettingsPage | 设置页（开发中） |
