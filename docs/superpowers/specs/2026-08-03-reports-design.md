# 报表功能（Reports）设计文档

日期：2026-08-03
状态：已评审通过，待实现

## 1. 目标与范围

`/reports` 页面目前是占位页（「功能开发中」）。本文档定义第一版报表（MVP）的完整设计。

**MVP 内容**（与用户头脑风暴确认）：

- 单页滚动仪表盘：总览卡片 → 收支趋势 → 分类统计 → 账户资产变动
- 周期切换：月 / 季 / 年 / 近12月 四档，◀ ▶ 切换，中心标签显示当前周期
- 自绘 SVG 图表（零图表库依赖）
- 点分类下钻到流水列表（复用现有 FilterPage + TransactionList 管道）

**明确不做**（MVP 外，YAGNI）：

- 按成员统计（团队账本维度后续再说）
- 预算功能
- 每账户单独曲线（资产变动只画净资产一条线）
- 后端报表 API（违背离线优先）
- 余额快照表（无需，见 §4.4 推导）
- 分类/趋势/账户图的 tooltip 之外的高级交互（缩放、长按等）

## 2. 现状约束（探索结论）

- 数据模型：`transactions`（income/expense/transfer，带 `user_id`、`occurred_at` 存 UTC ISO）、`categories`、`accounts`（asset/liability，`initial_balance`）、`ledgers`（personal/team）
- 账户余额完全由流水推导（`current_balance = initial_balance ± 相关账户收支`，见 `BALANCE_QUERY`），无独立于流水的余额调整入口
- 记账页校验强制：expense/transfer 必有扣款账户，income/transfer 必有入账账户（`RecordPage.vue` 校验逻辑）→ **收支必有账户、转账净额恒为 0**
- `TransactionList.vue` 监听 `route.query` 变化自动重查；`FilterPage.vue` 支持从路由 query 预填 `account/dateFrom/dateTo/tags/categories/members`
- 时区归天修复已沉淀在 `utils/datetime.ts` 的 `utcToLocalDateKey`，报表复用同一函数保证一致
- 测试惯例：`vi.mock("@/db/userDb")` + 手写 `mockDb` 对象（`select`/`execute` 为 `vi.fn()`）
- 项目 CLAUDE.md 约定：测试优先（非 bugfix 功能必须附带单测）、TypeScript 严格模式、不重构无关代码

## 3. 架构与模块划分

新增 4 个模块，**0 表结构变更、0 后端改动**：

| 模块 | 职责 |
|------|------|
| `src/services/reports.ts` | 报表聚合服务。纯 SQL 查询 + 类型化返回，不持有状态。函数见 §4 |
| `src/composables/useReports.ts` | 周期状态 + 加载编排。持有当前周期档位/偏移、loading、四组数据集；暴露 `switchPeriod`/`prev`/`next` |
| `src/components/charts/LineChart.vue` + `DonutChart.vue` | 纯 SVG 图表组件，数据驱动、无副作用。几何计算抽到 `src/utils/chart.ts` 纯函数 |
| `src/views/ReportsPage.vue` | 重写占位页：顶栏周期切换 + 四段布局组装 |

**数据流**：

```
账本切换 / 周期切换 / 进入页面
  → useReports 并发调 reports.ts 四组 SQL 查询
  → 返回类型化聚合数据
  → LineChart / DonutChart 渲染
```

**关键决策**：

- 报表是派生数据，每次查询即最新，不缓存、不监听写操作（SQLite 是单一事实源）
- 图表组件为通用纯组件：`LineChart` 吃 `{ labels: string[], series: { key, name, color, values: number[] }[] }`，`DonutChart` 吃 `{ segments: { id?, label, value, color }[], total }` 形状；reports 服务负责把 SQL 行组装成该形状
- 下钻复用现有 `FilterPage`，不新建详情页

## 4. 聚合 SQL 设计

### 统一入参

`{ ledgerId, range: { start, end } }`。`start`/`end` 由 JS 用本地时区边界转 UTC ISO（复用 transaction store 过滤语义：`occurred_at >= start AND occurred_at < end`，半开区间）。

### 时区归桶

SQL 直接按**本地日/月**聚合，用显式偏移修饰符：`date(occurred_at, '+480 minutes')` / `strftime('%Y-%m', occurred_at, '+480 minutes')`。偏移在每次查询时由 JS 计算（`-new Date().getTimezoneOffset()` 分钟），与范围边界同源，天然一致；值是纯数字派生，直接内联进 SQL，不经过参数绑定。

**为什么不用「UTC 桶 + JS 重归」**：正时区（如东八区）下单个 UTC 日/月桶会横跨两个本地日/月（UTC 08-02 含本地 08-02 早 8 点到 08-03 早 8 点），把整桶归到任一本地桶都会错分，且 UTC 日桶无法拆开重分。必须让 SQL 按本地边界切桶。

### 4.1 getOverview — 总览卡片

```sql
SELECT
  COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
  COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
FROM transactions
WHERE ledger_id=? AND is_deleted=0 AND occurred_at>=? AND occurred_at<?
```

返回 `{ income, expense, balance }`，`balance = income - expense` 在 JS 计算。**环比**：同查询换前一周期范围再跑一次，得 `prevIncome/prevExpense`，JS 算 `环比 = (cur - prev) / prev`，prev 为 0 时显示 `—`。

### 4.2 getTrend — 收支趋势

```sql
SELECT <utc_bucket> AS bucket,
  COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
  COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
FROM transactions
WHERE ledger_id=? AND is_deleted=0 AND type!='transfer'
  AND occurred_at>=? AND occurred_at<?
GROUP BY bucket ORDER BY bucket
```

- `<bucket>`：月档用 `date(occurred_at, '+480 minutes')`（本地日），季/年/近12月档用 `strftime('%Y-%m', occurred_at, '+480 minutes')`（本地月）；偏移按 §4 时区归桶 实时计算
- SQL 已按本地边界切桶，JS 只需**补齐无数据的天/月为 0** 保证折线连续
- 返回 `{ labels: string[], income: number[], expense: number[] }`（补齐后，长度=该周期采样点数）

### 4.3 getCategoryBreakdown(range, type) — 分类占比

```sql
SELECT t.category_id AS cid, c.name, c.icon,
  COALESCE(SUM(t.amount),0) AS total
FROM transactions t
LEFT JOIN categories c ON t.category_id=c.id
WHERE t.ledger_id=? AND t.is_deleted=0 AND t.type=?
  AND t.occurred_at>=? AND t.occurred_at<?
GROUP BY t.category_id ORDER BY total DESC
```

- `category_id` 为 NULL 或分类已删（`c.name` NULL）→ 归入 `{ id: null, name: '未分类' }`
- 支出/收入由调用方传 `type` 分别查询
- JS 侧：返回全部排序列表 `{ segments, list }`，其中 `segments` = Top 6 + 其余合并「其他」供环形图，`list` = 全部条目（含 `total`、`percent` 占比）供排行列表

### 4.4 getNetAssetSeries — 账户资产变动

**核心公式**（因收支必有账户、转账净零）：

```
net_asset(T) = Σ_{created_at ≤ T} 账户期初(资产+, 负债−)
             + Σ_{occurred_at < T} 收入 − Σ_{occurred_at < T} 支出
```

推导：`Σ 各账户(in − out) = 总收入 − 总支出`（转账在账户间抵消）；负债期初取负号沿用现有 `BALANCE_QUERY` 符号约定。该公式与当前余额查询完全自洽。

**实现分三块**（其中「桶内流动」复用 getTrend 的桶数据）：

1. **baseline**（范围起点的真实净资产）：
   - 历史流动：`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) FROM transactions WHERE ledger_id=? AND is_deleted=0 AND type!='transfer' AND occurred_at<?`（`< start`，无下界，一条聚合）
   - 已有账户期初：`SELECT COALESCE(SUM(CASE WHEN category='asset' THEN initial_balance ELSE -initial_balance END),0) FROM accounts WHERE ledger_id=? AND is_deleted=0 AND created_at<=?`（`<= start`）
   - `baseline = 历史流动 + 已有账户期初`
2. **桶内流动**：复用 getTrend 的桶收入/支出（同 range），JS 逐桶累加
3. **新增账户期初**：`SELECT <bucket> AS bucket, COALESCE(SUM(CASE WHEN category='asset' THEN initial_balance ELSE -initial_balance END),0) AS initial FROM accounts WHERE ledger_id=? AND is_deleted=0 AND created_at>=? AND created_at<? GROUP BY bucket ORDER BY bucket`（范围内按本地创建桶分组，`<bucket>` 同 getTrend），在创建桶那一点加进累加

JS 从 baseline 起步逐桶累加 → `{ labels, netAsset: number[] }`。月档 31 点、年档 12 点。

**边界说明**：账户删除后其期初不再计入（`is_deleted=0`），其历史流水仍留在流动求和里——与现有 `BALANCE_QUERY` 的简化一致，删除账户场景罕见，MVP 接受该近似。

## 5. UI 与交互

### 页面结构（单页滚动，自上而下 4 段）

```
┌ 顶栏：周期切换（月/季/年/近12月 + ◀ ▶ + 中心标签「2026年8月」）
├ ① 总览卡片
├ ② 收支趋势（LineChart）
├ ③ 分类统计（支出|收入 分段 + DonutChart + 排行列表）
└ ④ 账户资产变动（LineChart）
```

### 周期切换

- 档位：`month`（默认，本月）/ `quarter` / `year` / `twelveMonths`（近12月）
- 中心标签：`2026年8月` / `2026年Q3` / `2026年` / `2025年9月–2026年8月`
- ◀ ▶ 平移一个周期；近12月档平移 12 个月
- 聚合粒度：月档按天，季/年/近12月按月
- 切换时保留旧数据渲染，防闪烁（loading 不整页清空）

### 各段交互

| 段 | 内容 | 交互 |
|----|------|------|
| ① 总览卡片 | 三格：收入(绿)/支出(红)/结余(主色) | 每格下方环比「比上月 ±12.3%」，prev 为 0 显示 `—` |
| ② 收支趋势 | 双折线（收入、支出）+ 面积 | 手指点数据点显示 tooltip（日期+金额）；无数据补 0 |
| ③ 分类统计 | 环形图（Top 6+其他）+ 排行列表（全部，含占比条） | 区块内 支出\|收入 分段切换；点扇形/排行项 → 下钻流水 |
| ④ 账户资产变动 | 净资产单线 + 面积填充 | 图上标注期末净资产值 |

### 下钻（复用现有管道）

- 真实分类：`router.push({ path:'/filter', query:{ categories: id, dateFrom: <start>, dateTo: <end> } })` → FilterPage 预填 → apply → `/` 看流水。`dateFrom`/`dateTo` 传本地 `YYYY-MM-DDTHH:mm`（复用 `toLocalDatetimeString`），与 FilterPage/TransactionList 现有格式一致
- **未分类**：现有 `categories` 参数表达不了，给筛选管道补一个小的扩展（本次唯一触到现有筛选逻辑的改动，约 20 行）：
  - `transactionStore.fetchAll` 增加 `uncategorized: true` 选项 → SQL 加 `AND (t.category_id IS NULL OR NOT EXISTS(SELECT 1 FROM categories c WHERE c.id=t.category_id AND c.is_deleted=0))`
  - `FilterPage` 增加「未分类」标签，选中后 query 加 `uncategorized=1`
  - `TransactionList` 读取 `route.query.uncategorized` 透传
- 环形图「其他」合并项**不可下钻**（无单一分类可筛），点击无响应；排行列表中「未分类」行走上面的 `uncategorized` 参数下钻
- 团队账本：分类占比默认全成员合并；下钻后可在 FilterPage 手动加成员筛选（天然可用，不额外开发）

### 空态与配色

- 范围内无数据：对应区块显示轻量空态（「本期暂无支出」等），页面结构保留
- **配色**：分类无 color 字段，环形图用固定 12 色板按排行分配；实现时按 dataviz 技能提供的校验色板（明暗双适配）替换占位色值。趋势线语义色固定：收入绿、支出红；净资产线主蓝
- 金额展示统一 `toFixed(2)` + 千分位（沿用现有格式化），内部计算不动

## 6. 错误处理与边界

| 场景 | 处理 |
|------|------|
| 范围内无流水 | 各区块轻量空态文案，页面结构保留 |
| 无当前账本 / `getUserDb()` 为 null | `useReports` 返回空数据集，页面显示空态，不抛错不白屏 |
| 账本切换 | `watch(currentLedgerId)` 自动重查；切换瞬间保留旧数据渲染防闪烁 |
| 数据一致性 | 全部查询过滤 `is_deleted=0`；已删分类归「未分类」；转账排除出趋势与净资产流动 |
| 时区 | 边界与归桶统一由 JS 算，SQL 不碰时区 |
| 金额精度 | REAL 求和浮点误差只在展示层 `toFixed(2)` 消化，内部计算不改 |
| 性能 | 只拉聚合桶行（月≤31/年≤12）+ baseline 一条聚合，毫秒级；不搬全量流水 |

## 7. 测试方案

遵循项目「测试优先」约定，mock `@/db/userDb`（现有惯例）。

| 目标 | 覆盖 |
|------|------|
| `reports.ts` 服务单测（核心） | overview 收支/结余/环比（含 prev=0）；trend 本地归桶、无数据补 0、**排除转账**、日/月粒度；breakdown Top-N+其他合并、未分类兜底、支出/收入分离；netAsset baseline+逐桶累加+新增账户期初+**负债期初取负** |
| `utils/chart.ts` 纯函数单测 | 折线点坐标、环形弧线 path、tooltip 命中索引 |
| 图表组件 | `@vue/test-utils` 冒烟渲染（数据→SVG 元素），各 2-3 例 |
| FilterPage「未分类」扩展 | 补充 query 读取 + 透传用例 |

**不改动、不删除任何现有测试。**

## 8. 本次不改动

- 后端（Go/PostgreSQL/Redis）零改动
- 数据库 schema 零变更（无迁移）
- 不引入任何新依赖（无图表库）
- 不动 `RecordPage`、`TransactionList` 现有逻辑（仅 TransactionList/FilterPage/fetchAll 增加「未分类」透传约 20 行）
