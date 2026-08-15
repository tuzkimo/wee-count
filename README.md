# 一起数钱（WeeCount）

离线优先、家庭/团队协同的资产级记账 App，移动端优先。

- 前端：Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS v4
- 客户端壳：Tauri 2.0（Android 为目标平台，桌面端仅用于开发调试）
- 本地存储：SQLite（`@tauri-apps/plugin-sql`）
- 后端：Go + PostgreSQL + Redis

## 已知问题修复记录

### 安全与同步修复（2026-08-15 桶一 + 桶三）

- 令牌分层击穿：`AuthMiddleware` 只验签名与 `sub`、不验 `typ`，30 天 refresh token 可直接当 access 访问 `/me`、`/sync` 等受保护路由，架空 15 分钟 access 过期；现强制 `typ=="access"`（与 `Refresh` 的 `typ=="refresh"` 成对）。
- 非 owner 成员可改共享账本：`lwwMergeLedger` 的 UPDATE 只要求 `canReadLedger`（成员即可），普通成员可改 team 账本 name/type；现 team 账本仅 owner 可改名/type，并删除不可达的 INSERT 死分支（账本仍只能服务端创建）。
- 输入校验缺失 + 账号枚举：各 handler `Decode` 无 body 上限，超长 username/nickname 直冲 DB 500；register 返回 409「已注册」可被逐名探测。现加 `http.MaxBytesReader`（1MB）+ 字段长度校验（≤100），注册话术改「用户名不可用」。
- 邀请码先消费：`JoinByInvite` 在校验成员资格与 INSERT 之前就 `redis.Del`，已成员重进/DB 失败白白烧码；现移到成功加入之后消费。
- Register TOCTOU：`SELECT EXISTS` 查重与 INSERT 分离，并发同名注册撞唯一约束返回 500；现捕获 `23505` 返回 409。
- 标签同名去重：`lwwMergeTag` 在 id 未命中时按 `(ledger_id, name, is_deleted=FALSE)` 查重，命中则 UPDATE 旧行而非 INSERT，避免 `UNIQUE(ledger_id,name)` 冲突毒化同步。
- `GetMe` 账本口径与 sync 不一致：`GetMe` 只按 `owner_id` 查账本，经邀请加入的成员重启后拿不到共享账本；现改 owner UNION team_members（与 `getUserLedgerIDs` 同款口径）。

### 同步正确性（2026-08-14 复盘修复）

- 清空流水标签不同步：前端 `assembleTransaction` 无标签时不设 `tag_ids`，后端 `lwwMergeTransaction` 用 `len(t.TagIDs) > 0` 守卫跳过删旧关联，导致清空标签后旧标签被回传「复活」。修复：后端无条件先删旧关联再插新；前端 `applyRemoteChanges` 标签重建移入「插入/覆盖」分支（远端更旧时不再回滚本地标签，`tag_ids` 缺失视作空用于清空）。
- 同步确定性 500：`lwwMergeCategory` 命中同名同类型分类且本地更旧时误返回外层 `pgx.ErrNoRows`，整个同步 500 卡死；改为跳过返回 nil。
- 网络异常丢队列：`performSync` 的 `apiFetch` 无 try/catch，断网/超时 throw 时已清空的 `pendingChanges` 不回队、UI 误报「已同步」；现包 try/catch 回队变更并标记失败。
- 流水删除数据污染：`remove`/`batchRemove` 只推 `{id, is_deleted, updated_at}` 部分墓碑，后端整行 LWW UPDATE 用零值覆盖 amount/type/occurred_at 等字段；现仿 account.ts 推完整对象。
- 跨账号串数据：登出/切用户不清空模块级 `pendingChanges`，用户 A 的积压变更会被当 B 的推到 B 账号；新增 `clearPendingSync()` 并在 logout/unbindOnline 调用。
- LWW 误判「行不存在」：6 个 `lwwMerge*` 用 `err != nil` 判定「不存在→INSERT」，把真实 DB 错误误判；统一改 `errors.Is(err, pgx.ErrNoRows)`。
- 增量游标竞态：`ServerTime` 在读取远程变更之后才取 `time.Now()`，提交落在「读完成→取游标」窗口的变更会被下次增量跳过；改为在读取前取样，残留的客户端时钟偏移问题另立架构级任务（服务端权威游标）。
- 后端同步层架构级收口（复盘第三节）：6 份 `lwwMerge*` 样板抽 `mergeByKey` 通用骨架（category 查重分支保留），消灭「ErrNoRows 误判/return err 混淆」类 bug；增量游标改 `REPEATABLE READ` 只读事务取快照时间，消除「读↔取游标」竞态（客户端时钟偏移仍另立服务端权威游标任务）；补 testcontainers 真 Postgres 集成测试 5 条（`go test -tags integration`）网住真实 SQL 语义类 bug。
- 同步模块互斥（复盘第三节第 1 点）：`performSync` 加模块级 `isSyncing`/`syncQueued` 互斥，并发调用时在途同步不重复执行；在途期间积压的变更在本次结束后补跑一次，避免卡在 `pendingChanges`。

### 安全 / 越权（2026-08-14 复盘修复）

- 团队成员越权（IDOR）：`ListMembers` 不校验调用者归属，任意登录用户可按 team_id 枚举任意团队的成员 PII；现校验调用者必须是团队成员，非成员返回 403。
- access/refresh token 混用：`Refresh` 不区分 token 类型，access token 可当 refresh 无限续期；签发时加 `typ` 声明并在 `Refresh` 强制 `typ=="refresh"`。
- member_aliases 无隔离：写入信任客户端 setter、读取全局返回所有别名；现强制 setter=当前用户并按 setter 过滤。
- Tauri CSP 为空：`csp: null`，已补严格 CSP（`script-src 'self'` 阻断内联脚本注入，`connect-src` 放行 http/https 供动态 API 地址）。
- docker-compose 弱默认密钥：`JWT_SECRET`/`POSTGRES_PASSWORD` 去掉弱默认值，改 `${VAR:?}` 强制注入。
- 授权原语收口：抽 `canReadTeam`/`canReadLedger` 两个鉴权原语（`authz.go`），`ListMembers` 与同步写路径强制调用；封死账本归属覆写——`lwwMergeLedger` 不再接受客户端 `owner_id`/`team_id`，归属只由服务端 Register/CreateTeam 决定。
- 账本删除冻结：`lwwMergeLedger` 的 INSERT/UPDATE 不再接受 `is_deleted`（与 `owner_id`/`team_id` 一并冻结），团队成员不能通过 sync 软删共享账本；账本删除（若将来需要）走服务端专属端点。

### 中危修复（2026-08-14 复盘修复）

- 流水列表点击监听器未清理：`TransactionList` 的 `document.addEventListener("click")` 无 `onUnmounted` 移除，每次进首页叠加监听器并持有已卸载组件 ref；现抽 `closeLedgerSwitcher` 具名函数并在 `onUnmounted` 移除。
- 全站无速率限制：登录/注册可暴力破解、6 位邀请码（10^6 空间）可被登录用户离线爆破入组；现用 `httprate.LimitBy` 按 IP 对 `/auth/login`、`/auth/register`、`/teams/join` 限流 10 次/分钟（限流 key 经 `middleware.RealIP` 解析，可被 `X-Forwarded-For` 伪造，后续需按部署改用 chi v5.3.0+ `ClientIPFrom*` 收紧信任模型）。
- refresh_token 明文存 localStorage：设备 root 后可取走冒充用户；现迁出 webview 可达的 localStorage 至 Tauri 原生 store（`tauri-plugin-store`，非 Tauri 环境回落 localStorage），封堵 XSS 直接取 token 的路径（仍为明文持久化，对 root 不构成终极防护）。
- 同步失败无自动重试：`performSync` 失败只回队不重武装定时器，「断网编辑→恢复」不自动补推；现失败后按指数退避（5s→60s 上限）自动重试，成功重置计数。
- 改昵称不刷新账本内存缓存：`updateProfile` 改名后账本名要等下次 `init()` 才更新；现改名后刷新 ledgerStore 缓存。
- 软删账户不校验关联流水：`accountStore.remove` 无 COUNT 校验，软删后名下流水成孤儿；现与 `categoryStore.remove` 一致，有活跃流水时拒绝删除。
- LWW 时间戳字符串字典序比较：空格格式（`datetime('now')`）与 ISO 格式因 `" " < "T"` 恒判「更旧」，且 `firstFullSync` 未归一化致旧数据首同步可能 400；现加 `compareTimestamp` 按 epoch 比较并归一化 firstFullSync 出口时间戳。
- 错误回显泄露内部细节：`Invite`/`Join`/`UpdateProfile` 用 `err.Error()` 原样回显 redis/pgx 内部错误，且 403/400/500 状态码混用；现定义哨兵错误并按语义映射 404/403/400/409/500，统一通用文案。
- `GetMe` 漏查 `rows.Err()`：迭代中途错误被静默吞掉返回截断结果；现已补检查。
- 缺复合索引：`categories(ledger_id, updated_at)`、`ledgers(team_id)`、`team_members(user_id)` 缺失致团队/账本多了全表扫；迁移 007 补齐。
- Docker 供应链加固：移除 `GOSUMDB=off`（恢复 go.sum 校验）、运行阶段切非 root 用户、Postgres/Redis 端口收窄到 `127.0.0.1`、Redis 加 `--requirepass` 并新增 `REDIS_PASSWORD` 环境变量（Go 侧独立读取，地址与密码解耦）。
- 输入校验硬化：`/auth/register`、`/auth/login`、`/auth/refresh`、`/auth/profile`、`/teams`、`/teams/join` 的 JSON body 统一用 `http.MaxBytesReader` 限 1MB（防超大 body DoS）；register 的 username/nickname 与建团队 name 超 100 字符返回 400；注册遇用户名已占用改回通用话术「username unavailable」（不再回显「already registered」，防账号枚举）。

- 流水列表按天分组改用本地时区取日期 key，修复东八区 0–8 点流水被归到上一天的问题。
- 编辑收入类型流水时，分类不再被默认分类覆盖，正确回显原分类。
- 编辑收入类型流水时，保存校验不再因 `from_account_id` 为空而静默失败，可正常保存。
- 日期时间选择器分钟由 5 分钟步进改为每分钟可选。
- 分类图标库按类型分组展示（餐饮/交通/购物/居家/娱乐/运动/旅行/医疗/收入理财/教育/数码/社交/宠物/亲子/节日/办公/美容/其他），始终显示全部分组；输入名称命中关键词时仅自动滚动定位到对应分组，用户仍可上下滚动浏览其他分组；图标总数扩充至约 200 个。
- 分类编辑/标签选择底部 Sheet 接入 `useKeyboardInset` composable（基于 `visualViewport`），软键盘弹出时动态上抬底部内边距，避免确定按钮被遮挡、图标区滚动失效。
- 新增 `useKeyboardInset` composable：监听 `window.visualViewport` 的 resize/scroll，返回软键盘占据视口内高度。
- 修复 `CategorySheet` 进入记账页白屏：`watch(matchedGroupKey)` 注册在 `formName` 声明之前，watch 同步求值 source 触发 `formName` 的 TDZ `ReferenceError`，setup 抛错导致组件挂载失败；已将 watch 移至 `formName` 声明之后，并补 `CategorySheet` 组件单测（11 例，覆盖 TDZ 回归、列表/表单模式、Tab 切换、新建/编辑提交、团队账本权限、关键词匹配）。
- 修复报表页在有流水时仍显示「暂无数据」：净资产序列的期间新增账户子查询（`INITIALS_SQL`）复用了 transactions 的分桶表达式（硬编码 `occurred_at`），但查询的是 accounts 表（只有 `created_at`），SQLite 抛 `no such column: occurred_at`，经 `getReportData` 的 `Promise.all` 拖垮全部查询后被 `reload()` 静默吞掉。修复：`bucketExpr` 增加列参数，`INITIALS_SQL` 传 `created_at`；同时补两处健壮性——`useReports` 首屏加载前先 `await ledgerStore.init()`（修复冷启动直达报表页因账本未初始化而空态），`reload()` 增加 catch 并把错误暴露到 `error` ref，报表页区分「加载中 / 加载失败(可重试) / 暂无数据」三态。
- 修复报表页分类下钻跳转目标：点分类 / 未分类此前跳到筛选页（`/filter`，需再点「应用筛选」），现改为直接跳转流水首页（`/`）并透传 `dateFrom` / `dateTo` / `categories` / `uncategorized` 筛选参数，TransactionList 的 `buildFetchOpts` 与 `watch(route.query)` 已能完整消费。
- 修复团队账本增量同步卡死：增量同步按 `updated_at > since` 分表过滤，当一笔流水晚于游标、但它引用的账户/分类/账本早于游标且本地从未有过该父行时，客户端插入流水触发 SQLite 外键约束违反，抛异常导致游标永不推进（UI 误报「已同步」）。修复：后端 `getRemoteChanges` 增量返回时按 id 反查补齐流水引用的父行（账本/账户/分类/标签，不看 `updated_at`），保证父行先于子行到位；前端 `performSync` 给 `applyRemoteChanges` 包 try/catch，失败时如实标记同步失败、游标不虚推进。
- 前端大组件拆分（复盘第三节第 6 点）：`TransactionList.vue`/`RecordPage.vue` 的纯展示函数（事务展示/金额/日期/表达式求值）抽到 `utils/`，表单状态与校验抽成 `useTransactionForm` composable；补转账 `from===to` 校验（转出转入账户相同则拒绝）。

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

### Phase 5：报表功能（已完成）
- `/reports` 单页滚动仪表盘：总览卡片（收入/支出/结余 + 环比）、收支趋势折线、分类占比环形图 + 排行列表、账户净资产曲线
- 周期切换：月 / 季 / 年 / 近12月 四档，◀ ▶ 平移，中心标签显示当前周期；切换时保留旧数据防闪烁
- 自绘 SVG 图表（`LineChart` / `DonutChart`，几何纯函数抽到 `src/utils/chart.ts`），零图表库依赖
- 点分类 / 未分类下钻流水：直接跳转流水首页（`/`）并透传日期范围 + 分类 / 未分类筛选参数（不经过筛选页）；环形图「其他」合并项不可下钻
- 本地 SQLite 聚合服务层（`src/services/reports.ts` + `src/composables/useReports.ts`）：0 schema 变更、0 后端改动、0 新依赖；按本地时区归桶
- 设计文档：`docs/superpowers/specs/2026-08-03-reports-design.md`

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
| `/reports` | ReportsPage | 报表页：周期切换 + 总览/趋势/分类/资产仪表盘 |
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
| `REDIS_PASSWORD` | 否 | — | Redis 密码（Docker Compose 下必填，直连无密码 Redis 可留空） |
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
REDIS_PASSWORD=<改成强密码>
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
