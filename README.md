# 一起数钱（WeeCount）

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
- 交易 CRUD：收入/支出/转账三种类型，支持分类、账户、日期、金额、标签、备注
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
- 在线服务降级容错：所有 fetch 经 `fetchWithTimeout`（会话恢复 5s / 业务请求 15s / 登录注册 10s）兜底，服务 TCP 可达但 HTTP 不响应时不再永久挂起；启动/登录时会话恢复改为后台非阻塞，本地数据立即可用（不白屏）；服务下线期间保持本地模式，本地变更入队暂不推送，后台指数退避（10s→60s 上限）探测服务，恢复后自动重连 + 拉取远程 + 推送积压变更
- member_aliases 同步：本地 userDb 无 setter 列（本地用户即唯一 setter）；推送时由 `collectMemberAliasesForSync` 全量补盖 `setter_user_id`（在线模式取服务端 user id，回退本地 user id），apply 时过滤 `setter=me` 再写本地，忽略他人为同一 target 设的别名
- 账户变更同步修复：`accountStore.update/remove` 此前未调用 `enqueueSync`，导致改账户余额/名称或删除账户后只落本地、不同步线上；现已补上入队，并推送完整账户对象（后端 `lwwMergeAccount` 按整体 LWW 合并，部分字段会让缺失字段被零值覆盖）
- 标签删除同步修复：`tagStore.remove` 此前未调用 `enqueueSync`，删除标签不同步；现已补上入队，推送完整标签对象 + `is_deleted:true`
- 流水标签编辑同步修复：`transactionStore.update` 仅改 `tag_ids` 时未 bump `updated_at`，导致 `enqueueSync` 带旧时间戳被后端 LWW 跳过、标签变更静默不同步；现已补 `UPDATE transactions SET updated_at` 后再入队

### Phase 4-C：Onboarding 引导流程（已完成）
- WelcomePage：首次启动创建本地账户（昵称 + 密码）
- 路由守卫：无用户 → `/welcome`，未登录 → `/login`

### Phase 4-D：本地→在线数据迁移（已完成）
- 迁移服务（`src/services/migration.ts`）：本地 ledger_id → 服务端 ledger_id
- BindSyncPage：配置 API 地址 + 登录/注册在线账号 + 首次全量同步
- RegisterPage 重定向到 WelcomePage

### Phase 4-E/F：登录页 + 我的页更新（已完成）
- LoginPage：改为手动输入用户名（本地账户登录）
- MePage：显示在线/本地模式状态，配置在线同步入口，团队管理（创建/加入团队、成员管理），登出功能；在线服务降级时（`isOnlineBound && !isOnline`）同步状态显示「在线服务暂不可用，正在自动重连」，团队入口隐藏并替换为文字提示，退出在线同步仍可用

### Phase 4-G：头像裁剪与 data URL 存储（已完成）
- 头像统一存 `avatar_url` 为 data URL（与 emoji 同路），本地/在线一致；在线模式经 `auth.updateProfile` 同步到 `users.avatar_url`
- 后端迁移 006：`users.avatar_url` 由 `VARCHAR(255)` 改 `TEXT`，容纳 data URL
- 删除后端 `POST /auth/avatar` 端点 + `/static` 静态服务 + `UploadDir` 配置（文件落盘方案不再使用）
- `AvatarCropper` 组件：固定 280px 正方形视窗，拖动平移 + 滑块缩放（中心锚点），canvas 采样输出 256×256 JPEG（质量 0.85）data URL
- `computeCrop` 纯函数（`src/utils/crop.ts`）由视窗几何反推源采样参数，配单测覆盖正方形/宽/高/缩放/偏移
- ProfilePage 上传入口改为圆形预览 + 相机徽标，支持图片裁剪与 emoji 两种方式
- `MemberAvatar` 支持渲染 `data:` / `http` / 服务器相对 URL 头像

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
| `/welcome/local` | LocalSetupPage | 本地账户初始化（昵称+密码） |
| `/teams/create` | CreateTeamPage | 创建团队（仅在线模式，隐藏 Tab） |
| `/teams/join` | JoinTeamPage | 加入团队（仅在线模式，隐藏 Tab） |
| `/teams/members` | TeamMembersPage | 团队成员管理：查看成员+改别名（隐藏 Tab） |
| `/profile` | ProfilePage | 个人资料页（头像上传等，隐藏 Tab） |
| `/transactions` | → `/` | 旧路由重定向 |
| `/settings` | SettingsPage | 设置页（开发中） |

## 后端配置

后端通过环境变量配置（`backend/.env`），加载逻辑见 `backend/internal/config/config.go`：

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `DATABASE_URL` | 是 | — | PostgreSQL 连接串 |
| `REDIS_URL` | 是 | — | Redis 地址 |
| `JWT_SECRET` | 是 | — | JWT 签名密钥 |
| `PORT` | 否 | `8080` | 监听端口 |
| `CORS_ALLOWED_ORIGINS` | 否 | `http://tauri.localhost,http://localhost:1420` | 允许的来源，逗号分隔，需含 scheme |

CORS 默认放行 Tauri Android webview 来源（`http://tauri.localhost`）与 Vite dev server（`http://localhost:1420`）。生产环境若需锁定单一来源，显式设置 `CORS_ALLOWED_ORIGINS=http://tauri.localhost` 即可。

## 后端部署

后端用 Docker Compose 一键拉起 API + PostgreSQL + Redis，配置见 `backend/Dockerfile` 与 `backend/docker-compose.yml`。

### 1. 准备服务器

- 安装 Docker + Docker Compose（或直接用 Podman）
- 开放入站端口：`8080`（API）。PostgreSQL/Redis 仅容器内通信，**不要**对公网开放

### 2. 配置环境变量

在 `backend/` 下创建 `.env`（compose 会自动读取），**务必改掉默认密码与 JWT 密钥**：

```env
POSTGRES_USER=wee
POSTGRES_PASSWORD=<改成强密码>
POSTGRES_DB=wee-count
JWT_SECRET=<改成随机长字符串>
CORS_ALLOWED_ORIGINS=http://tauri.localhost
```

> `DATABASE_URL` / `REDIS_URL` 不需要手填——compose 用容器服务名 `postgres` / `redis` 拼好默认值透传给 API。

### 3. 启动

```bash
cd backend
docker compose up -d
```

数据库迁移在服务启动时自动执行（`internal/database` 的 `RunMigrations`）。

### 4. 验证

```bash
curl http://<服务器IP>:8080/api/v1/auth/register
```

返回 4xx（缺少请求体）即说明 API 已正常监听。

### 5. 前端对接

在 Tauri App 的在线同步配置页填入 API 地址：

```
http://<服务器IP>:8080/api/v1
```

> **安全建议**：生产环境建议前置 nginx 反向代理 + HTTPS（Let's Encrypt 或 Cloudflare Tunnel），此时 `CORS_ALLOWED_ORIGINS` 保持 `http://tauri.localhost` 不变——CORS 校验的是 webview 来源，与后端域名无关。
