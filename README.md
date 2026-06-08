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
- 点击账户进入流水页 → 流水页可导航到编辑页
- 编辑页支持修改所有字段及删除账户
- 状态栏安全区适配（`safe-area-inset-top`）
- 通用 ConfirmDialog 组件（Teleport + scale 动画）
- 账户新增底部 Sheet（资产/负债分组选择）

## 路由

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | Home | 首页 |
| `/accounts` | AccountList | 账户列表 + 净资产汇总 |
| `/accounts/:id/transactions` | TransactionList | 流水占位页 |
| `/accounts/:id/edit` | AccountEdit | 账户编辑页 |
