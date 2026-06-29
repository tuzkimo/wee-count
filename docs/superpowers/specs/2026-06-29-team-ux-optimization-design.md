# 团队账本体验优化设计

日期：2026-06-29

## 概述

团队账本功能基础可用但体验粗糙，15 个优化点覆盖：新手引导、会话持久化、成员系统、团队协作、交互细节。

## 一、新用户引导流程（#1 #2 #6）

### 当前问题
- 所有用户必须先创建本地账户，再手动配置在线同步
- 登录/注册表单在 BindSyncPage 平铺，冗长混乱
- 注册要求邮箱，门槛高

### 设计方案

**WelcomePage 改为模式选择页：**
- 两个按钮：「本地模式」「在线模式」
- 选本地 → 输入昵称 + 密码 → 创建本地账户 → 进入首页
- 选在线 → 输入 API 地址 → 进入 BindSyncPage（改版）

**BindSyncPage 改为 Tab 切换：**
- Tab「登录」：用户名 + 密码 → 调用 `/auth/login` → 创建本地账户 → bindOnline → firstFullSync → 进首页
- Tab「注册」：用户名 + 密码（昵称默认等于用户名）→ 调用 `/auth/register` → 创建本地账户 → bindOnline → firstFullSync → 进首页

**后端 API 改动：**
- `POST /auth/register` body: `{email, password, nickname}` → `{username, password, nickname?}`
- `POST /auth/login` body: `{email, password}` → `{username, password}`
- User 表新增 `username` 字段，unique

### 涉及文件
- `src/views/WelcomePage.vue` — 重写为模式选择页
- `src/views/BindSyncPage.vue` — 重构为 Tab 切换
- `src/views/RegisterPage.vue` — 保留重定向或移除
- `src/services/api.ts` — login/register 函数签名
- 后端 `auth` handler

## 二、会话持久化（#3 #7 #8）

### 当前问题
- App 切后台 WebView 被杀，Pinia 内存状态丢失，回到登录页
- `logout()` 调用 `api.clearTokens()` 删了 refresh_token，重新登录后无法恢复在线会话
- 没有独立的"退出在线同步"入口

### 设计方案

**#3 自动恢复会话：**
- 登录成功后 `localStorage.setItem("current_user_id", userId)`
- `auth.init()` 检查 localStorage，有 userId 则自动执行 localLogin + tryRestoreSession
- 路由守卫不需要改，`auth.init()` 在守卫之前完成

**#7 退出在线同步：**
- MePage 在线模式下显示「退出在线同步」按钮
- 功能：清 API 地址、server_user_id、refresh_token，mode 回退到 local
- 「退出登录」只退出本地会话，不影响在线绑定

**#8 重登不重绑：**
- `logout()` 不再调用 `api.clearTokens()`
- 下次 `localLogin()` 调用 `tryRestoreSession()` 时 refresh_token 仍存在，自动恢复

### 涉及文件
- `src/stores/auth.ts` — logout 改逻辑，init 加自动恢复，新增 unbindOnline action
- `src/views/MePage.vue` — 添加退出在线同步按钮

## 三、用户资料 & 成员系统（#10 #14 #15）

### 数据模型

**User 表（本地 SQLite 镜像）：**
```
avatar_url TEXT
```

**新增成员别名表：**
```sql
CREATE TABLE IF NOT EXISTS member_aliases (
  setter_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  alias_name TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (setter_user_id, target_user_id)
);
```

**同步协议扩展：**
`SyncPayload` 增加 `member_aliases` 字段

**后端改动：**
- `POST /auth/profile` — 更新当前用户 nickname、avatar_url
- 数据库新增 `member_aliases` 表
- 同步接口支持 member_aliases

### #14 编辑头像/昵称

SettingsPage（当前空壳）实现头像和昵称编辑：
- 头像：预设头像选择或 emoji 头像（不做图片上传，ponytail）
- 昵称：文本输入框
- 保存调用 `PUT /auth/profile`

### #10 #15 显示逻辑

流水记录和账户的归属显示：
```
别名（当前用户给对方设的） > 对方昵称 > 对方用户名
```

团队成员列表：
```
头像显示 avatar_url（没有就用首字符 fallback）
名称显示同上优先级
```

团队账本 header 显示 `{团队名}的账本`（#9）

### 涉及文件
- `src/views/SettingsPage.vue` — 实现头像/昵称编辑
- `src/views/TransactionList.vue` — 流水记录显示成员别名
- `src/components/AccountPickerSheet.vue` — 账户归属显示
- `src/stores/auth.ts` — 新增 updateProfile action
- `src/services/sync.ts` — 同步协议加 member_aliases
- `src/db/meta.ts` — 别名 CRUD
- 后端 `auth`, `sync` handler

## 四、团队体验优化（#9 #11 #12）

### #9 账本名称
- 团队账本 header 和账本切换器显示 `{团队名}的账本`
- 个人账本保持显示 `{个人账本}` 或账本原名
- 纯转换逻辑，不改数据

### #11 筛选增强
FilterPage 新增两项筛选：
- **分类筛选**（多选）：按 emoji + 名称展示，支持多选
- **成员筛选**（多选，仅团队账本）：展示成员列表，支持多选

筛选 query 参数扩展：
- `categories` — 逗号分隔的分类 ID
- `members` — 逗号分隔的成员 ID

TransactionList 的 `buildFetchOpts()` 新增对应过滤条件。

### #12 权限控制
团队账本中，检查数据归属：
- `item.owner_id === currentUserId` — 可编辑/删除
- 不匹配 — 编辑/删除按钮**置灰**，点击不响应
- 适用范围：账户编辑、流水编辑/删除、分类编辑/删除

### 涉及文件
- `src/views/TransactionList.vue` — 账本名称显示
- `src/views/FilterPage.vue` — 新增分类和成员筛选
- `src/views/RecordPage.vue` — 权限检查，非自己的流水隐藏删除按钮
- `src/views/AccountEdit.vue` — 权限检查
- `src/components/CategorySheet.vue` — 权限检查
- `src/stores/transaction.ts` — fetchAll 支持 category/member 过滤

## 五、交互细节（#4 #5 #13）

### #4 选账户时添加账户
AccountPickerSheet 底部加「+ 新建账户」按钮：
- 点击打开 AccountSheet（或跳转 AccountEdit 新建页）
- 新建完成后自动关闭 sheet 并选中新账户
- 实现方式：emit `create` 事件，父组件处理

### #5 复制反馈
CreateTeamPage 点击"复制邀请码"后：
- 按钮文字变「已复制 ✓」，样式变绿
- 1.5 秒后恢复
- 用 `navigator.clipboard.writeText()` + 本地状态控制

### #13 在线模式首页空白
根因：绑定在线后 sync 异步执行，TransactionList 的 `onMounted` 先于 sync 返回就执行完了。

修复方案：auth store 新增 `syncVersion` 计数器，每次 `performSync` 或 `firstFullSync` 成功完成后 +1。TransactionList watch `auth.syncVersion`，变化时重新 fetch 数据。

### 涉及文件
- `src/components/AccountPickerSheet.vue` — 添加新建入口
- `src/views/RecordPage.vue` — 处理 create 事件
- `src/views/CreateTeamPage.vue` — 复制反馈
- `src/views/TransactionList.vue` — 响应同步完成事件
- `src/services/sync.ts` — 同步完成通知机制

## 实施顺序建议

1. **Phase 1**（基础）：#3 会话持久化（影响最大，先修）
2. **Phase 2**（引导流程）：#1 #2 #6 新手引导 + 后端 API
3. **Phase 3**（团队体验）：#9 #11 #12 权限+筛选+显示
4. **Phase 4**（成员系统）：#10 #14 #15 别名+头像昵称
5. **Phase 5**（交互细节）：#4 #5 #13 小修补
