# 团队账本体验优化（第二轮）设计

> 接续 `docs/superpowers/plans/2026-06-30-team-ux-optimization.md`（已实施完成）。本轮针对 12 项遗留优化。

**日期：** 2026-07-07
**技术栈：** Vue 3 + TypeScript + Pinia + SQLite（前端），Go + Chi + PostgreSQL（后端）

---

## 背景与现状摸底

第一轮计划完成后，仍存在 12 项体验缺口。摸底发现几条贯穿多个优化点的前置问题：

1. **成员数据闭环缺失**：sync 协议不携带 `users` / `team_members`，前端只有 `user_id` + 本地 `member_aliases`。`getUserDisplayName`（`TransactionList.vue:28-37`）与 `ownerLabel`（`AccountPickerSheet.vue:30-33`）各写一份，fallback 到 id 前 8 位。第 5/6/7/8/12 点都依赖"如何拿到队友昵称和头像"。
2. **账户归属不一致**：`AccountList.vue:52` 新建账户用 `ledger.owner_id`，`AccountCreateSheet.vue:45` 用当前用户 id。团队账本里账户归属语义混乱，影响第 6/11 点。
3. **备注字段端到端缺失**：`Transaction` 类型、SQLite 表、Go model、sync、RecordPage 表单全无 note 字段。
4. **头像上传基础设施为零**：后端无上传接口、无静态资源、无对象存储，`avatar_url` 存的是 emoji 字符串。
5. **创建团队后账本未切换**：`addLedger` 隐式切换被紧随其后的 `performSync()` 覆盖回个人账本。
6. **多用户切机隔离**：meta.db 中 `member_aliases` 靠 `setter_user_id` 列逻辑隔离，物理共享一张表，存在切账号数据混淆隐患。

## 关键决策（已与用户确认）

| 决策点 | 选择 |
|---|---|
| 成员昵称/头像数据来源 | 后端补 `GET /teams/{id}/members` 接口（不进 sync payload） |
| 成员缓存隔离 | team_members 缓存放 **userDb**（每用户独立 db） |
| 账户归属语义 | `owner_id = 创建者本人`，修正 AccountList 错误赋值 |
| 头像上传落地 | 后端本地磁盘 + 静态文件服务（`/static/avatars/...`） |
| 头像选项 | 上传图片 + 保留 emoji 选项并存 |
| 他人流水卡片 | 置灰样式 + 不可点击 |
| 成员管理页范围 | 最小：选团队 + 成员列表 + 改别名（不加邀请/退出/踢人） |
| member_aliases 迁移 | 从 meta.db 迁到 userDb，**去掉 setter_user_id 列**，PK=target_user_id；sync apply 过滤 setter=me |
| 第 10 点浮动按钮 | 仅指账户详情页内的浮动按钮 |
| 创建团队跳转 | 页面跳转逻辑不动，修"账本未切换到新团队账本"的 bug |

## 数据层 schema 变更（命中红线，已获授权）

按 plan 开头"数据库将清空重测"，不写数据迁移脚本，直接重建表。

- **userDb 新增 `team_members` 表**：`(team_id, user_id, username, nickname, avatar_url, role, updated_at)`，PK `(team_id, user_id)`。
- **userDb 新增 `member_aliases` 表**（替代 meta.db 同名表）：`(target_user_id, alias_name, updated_at)`，PK `target_user_id`。去 setter 列——userDb 主人即唯一 setter。
- **userDb `transactions` 表加列** `note TEXT`。
- **meta.db 删除 `member_aliases` 表**（数据丢弃重测）。

---

## A. 数据层前置

### A1. 后端 team members 接口

- 新增 `GET /teams/{id}/members`（受保护路由），返回 `[{user_id, username, nickname, avatar_url, role, joined_at}]`，复用 `backend/internal/service/team.go` 现有 `team_members` 表 JOIN `users`。
- 前端 `src/services/api.ts` 新增 `fetchTeamMembers(teamId)`。
- 前端 `src/db/userDb.ts` 新增 `team_members` 表建表 + CRUD（`upsertTeamMembers`、`getTeamMembers`）。
- 拉取时机：进团队账本时（ledger store 切到 team 账本 / TransactionList fetch）调用 `fetchTeamMembers` 刷新缓存。不进 sync payload，改 avatar/nickname 后下次进页面刷新即生效。

### A2. 账户归属统一

- 修正 `AccountList.vue:52`、`AccountSheet` 新建逻辑：`owner_id = auth.currentLocalUser?.server_user_id || getCurrentUserId()`，与 `AccountCreateSheet.vue:45` 一致。
- 个人账本里 owner_id 仍是自己，无影响。
- 历史数据丢弃重测，不写迁移。

### A3. 备注字段端到端（优化点 2）

- `src/types/index.ts` `Transaction` 加 `note?: string`。
- `src/db/userDb.ts` `transactions` 表加 `note TEXT` 列（migration）。
- `backend/internal/model/transaction.go` 加 `Note *string`；`sync.go` 读写 `note`（sync payload 已是整条 transaction，自动带）。
- `RecordPage.vue` 表单加单行输入（maxlength 100，可选，支出/收入/转账通用）。
- `TransactionList.vue` 流水卡片在描述下展示 `note`（灰色小字），个人/团队账本都显示。

### A4. 头像上传基础设施（前置于优化点 4/7）

- 后端新增 `POST /auth/avatar`（multipart/form-data）→ 存 `./uploads/avatars/{userid}.{ext}` → 返回 `{avatar_url: "/static/avatars/{userid}.{ext}"}`。
- `backend/cmd/server/main.go` 注册 `r.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("./uploads"))))`。
- `backend/internal/service/auth.go` `UpdateProfile` 不变（仍写 `avatar_url` 字段，值现在是 URL）。
- `avatar_url` 字段语义：emoji 字符串 或 图片 URL（保留兼容）。展示端判断：以 `http` 开头 → `<img>`，否则当 emoji 文字，再否则昵称首字。
- `src/services/api.ts` 新增 `uploadAvatar(file: File)`。
- 新增 `src/components/MemberAvatar.vue`：props `userId/size`，内部用 `useMemberInfo` 拿 `avatarUrl`，按上述规则渲染（img / emoji / 首字）。

### A5. member_aliases 迁 userDb

- `src/db/userDb.ts` 新增 `member_aliases` 表（去 setter 列），CRUD 函数从 `getMetaDb` 改 `getUserDb`：`getMemberAliases()` / `setMemberAlias(targetUserId, aliasName)`。
- `src/db/meta.ts` 删除 member_aliases 建表与 CRUD。
- `src/services/sync.ts`：
  - 推送：`enqueueSync` / `mergeChanges` 把本地 userDb 所有 member_aliases 收集进 payload，每条补 `setter_user_id = 当前用户 server_user_id`。
  - apply：`applyRemoteChanges` 收到 member_aliases payload，过滤 `setter_user_id === me` 再写本地 userDb（去 setter 列）；其余丢弃。
- 后端 sync 协议不变（payload 仍带 setter_user_id 标识）。

### A6. 统一成员解析 helper

- 新增 `src/composables/useMemberInfo.ts`，导出 `useMemberInfo()` 返回 `getMember(userId)` → `{displayName, avatarUrl}`：
  - `self → { displayName: "我", avatarUrl: 当前用户自己的 avatar_url }`
  - 别名：查当前 userDb `member_aliases`（无 setter 列，userDb 主人即 setter）
  - 昵称：查当前 userDb `team_members` 缓存
  - username：同 team_members 缓存
  - displayName 规则：别名 > 昵称 > username（**不再 fallback id 前 8 位**）
  - avatarUrl：team_members 缓存的 avatar_url
- 替换 `TransactionList.vue` `getUserDisplayName`、`AccountPickerSheet.vue` `ownerLabel` 两份重复实现。

---

## B. 筛选与展示

### B1. 筛选项排序（优化点 1）

`FilterPage.vue` 调整顺序为：账户 → 日期 → 分类 → 成员 → 标签（标签排最后）。成员块仅团队账本显示。

### B2. 成员筛选（优化点 5）

- 消费侧已就绪（`route.query.members` / `transactionStore.fetchAll` 的 `memberIds` / `filterSummary` 摘要）。
- FilterPage 新增成员 chip 多选块：用 `useMemberInfo` + userDb `team_members` 缓存渲染成员列表，选中透传 `members` query。
- 个人账本不显示成员块。

### B3. 流水/账户卡片成员标注（优化点 6/7/8）

- 流水卡片（`TransactionList.vue`）：团队账本时，描述行加 `👤 {displayName}`；右侧或成员名前用 `MemberAvatar`（20px 圆图）展示头像。displayName 用 `useMemberInfo`（别名 > 昵称 > username，不 fallback id）。个人账本不显示成员归属。
- 账户卡片（`AccountCard.vue`）+ `AccountPickerSheet.vue`：团队账本时账户名后显示归属 `({displayName})`。个人账本不显示。

---

## C. 权限与交互

### C1. 他人流水置灰 + 不可点（优化点 9）

`TransactionList.vue` 流水 item：团队账本时若 `tx.user_id !== me` → 卡片加 `opacity-60`，金额不高亮，`@click` 加守卫（非 owner 直接 return / 轻提示"他人记录，不可编辑"）。已有 `RecordPage.vue` 内 `isOwner` 拦截保留作兜底。

### C2. 他人账户隐藏编辑按钮（优化点 10）

`AccountEdit.vue`：
- 右上角编辑按钮 `v-if="isOwner"`（已有 `isOwner` 判断 `account.owner_id === currentUserId`）。
- 账户详情页内浮动添加按钮 `v-if="isOwner"`。
- 保留现有"他人账户"提示与禁用保存。
- 注意：账户列表页（`AccountList.vue`）的全局浮动"+"不隐藏——用户可在团队账本建自己的账户。

### C3. 只能选自己创建的账户（优化点 11）

`RecordPage.vue` 的 `availableAccounts`（及 `AccountPickerSheet` 内部 `availableAccounts`）在团队账本时过滤 `owner_id === me`。支出=扣款账户、收入=入账账户、转账=转出账户三处选择器统一过滤。配合 A2 账户归属修正后语义成立。个人账本不过滤（都是自己）。

---

## D. 入口与流程

### D1. 创建团队后自动切换账本（优化点 3）

- 现状 bug：`CreateTeamPage.vue` 创建成功后 `addLedger` 隐式切到新团队账本，但紧随其后的 `performSync()` 拉回远程 ledgers 后 store 把 `currentLedgerId` 重置回 `rows[0]`（个人账本）。
- 修复：`performSync()` 完成后显式 `ledgerStore.setCurrentLedger(newLedgerId)`。页面跳转逻辑不动。
- 根因待实现时定位（addLedger 未生效 / 或 sync 覆盖），最终以"创建后 currentLedger 为新团队账本"为准。

### D2. 头像上传 UI（优化点 4）

`ProfilePage.vue` 头像区改为"上传图片 + emoji 选项"并存：
- 上传组件：点击头像 → 选图 → 调 `api.uploadAvatar` → 返回 URL → 存 `avatar_url`。
- 保留 emoji grid 作为快速默认。
- `MemberAvatar` 按三级 fallback 渲染（URL/emoji/首字）。

### D3. 成员管理页（优化点 12）

- 新增路由 `/teams/members`（hideTab）。
- `MePage.vue` 团队管理分组加"成员管理"入口（仅在线模式且当前有 team 账本时显示）。
- 页面结构：
  - 顶部下拉：选团队账本（`ledgerStore.ledgers` 过滤 `type === 'team'`）。
  - 下方成员列表：`GET /teams/{id}/members` 拉取，成员卡片显示 `MemberAvatar` + displayName + 角色标签。
  - 卡片右侧"修改别名"按钮 → 弹窗输入 → `setMemberAlias(targetUserId, alias)` 写 userDb + 触发 `enqueueSync` 推送。
- 不加邀请/退出/踢人（YAGNI）。

### D4. MePage 入口调整

MePage 团队管理分组：保留"创建团队""加入团队"，新增"成员管理"。

---

## 测试

- 备注字段：Transaction store / sync apply 单测覆盖 note 读写。
- useMemberInfo：单测覆盖 别名 > 昵称 > username 优先级与 self 判断。
- 账户归属过滤：RecordPage availableAccounts 在团队账本过滤 owner_id 的单测。
- 后端：`GET /teams/{id}/members`、`POST /auth/avatar` handler 测试。
- member_aliases sync apply 过滤 setter=me 的单测。

## 验证清单

1. 筛选项顺序：账户→日期→分类→成员→标签；成员块仅团队账本出现
2. 流水记录可填备注、卡片展示备注
3. 创建团队后首页 currentLedger 为新团队账本
4. ProfilePage 可上传图片头像，emoji 仍可选
5. 团队账本 FilterPage 有成员筛选
6. 团队账本账户卡片/选择器标注归属成员
7. 流水/账户卡片成员头像用 MemberAvatar 渲染
8. 成员 displayName 为 别名>昵称>username，不出现 id 前 8 位
9. 团队账本他人流水卡片置灰不可点
10. 他人账户详情页隐藏编辑按钮与页内浮动添加按钮
11. 团队账本记账时支出/收入/转账账户选择器只列自己账户
12. MePage 有成员管理入口，页面可切换团队、查看成员、改别名
13. 多用户切机：切账号后 team_members / member_aliases 不串
