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

### Phase 4-A：后端用户数据隔离（已完成）
- 默认分类模板拷贝模式（CreateLedger 在事务中创建账本 + 拷贝默认分类/账户）
- 数据库迁移：categories.ledger_id 改为 NOT NULL，删除 NULL-ledger 模式
- 同步服务：categories 查询增加 ledger_id 过滤，与 accounts/tags/transactions 一致
- Category Model：LedgerID 从 `*string` 改为 `string`
- 登录/注册返回 ledger_id（AuthResponse）

### Phase 4-B：前端 per-user SQLite（已完成）
- `_meta.db`：管理本地用户列表（local_users 表），支持多用户切换
- `per-user.db`：每用户独立 SQLite 数据库（`<user_id>.db`）
- 默认分类常量（`src/db/defaults.ts`）：与后端 DefaultCategories 保持一致
- 用户数据库初始化（`src/db/userDb.ts`）：建表 + 默认数据拷贝
- Pinia stores 重构：`getUserDb()` 替代 `getDb()`，`getDb()` 变为同步方法
- API 层动态 baseUrl（`setBaseUrl()`），支持多服务端切换
- bcryptjs 本地密码哈希
- 同步游标按本地用户隔离（`last_synced_at:<user_id>`），避免多用户共用游标导致团队账本里别人的数据被跳过；在线会话恢复后自动后台拉取一次远程变更

### Phase 4-C：Onboarding 引导流程（已完成）
- WelcomePage：首次启动创建本地账户（昵称 + 密码）
- 路由守卫：无用户 → `/welcome`，未登录 → `/login`

### Phase 4-D：本地→在线数据迁移（已完成）
- 迁移服务（`src/services/migration.ts`）：本地 ledger_id → 服务端 ledger_id
- BindSyncPage：配置 API 地址 + 登录/注册在线账号 + 首次全量同步
- RegisterPage 重定向到 WelcomePage

### Phase 4-E/F：登录页 + 我的页更新（已完成）
- LoginPage：改为手动输入用户名（本地账户登录）
- MePage：显示在线/本地模式状态，配置在线同步入口，登出功能

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
| `/me` | MePage | 我的页：用户信息/同步状态/团队管理/登出 |
| `/login` | LoginPage | 本地账户登录（用户名+密码） |
| `/welcome` | WelcomePage | 首次启动创建本地账户 |
| `/bind-sync` | BindSyncPage | 配置在线同步（API地址+登录/注册） |
| `/transactions` | → `/` | 旧路由重定向 |
| `/settings` | SettingsPage | 设置页（开发中） |
