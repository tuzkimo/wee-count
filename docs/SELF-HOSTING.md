# 自托管部署指南

WeeCount 后端是**可选**组件：不部署时 App 完全本地运行；部署后可在多设备、家庭成员之间同步。

架构：一个 Docker Compose 拉起三个服务——`api`（Go）+ `postgres`（PostgreSQL 16）+ `redis`（Redis 7）。数据库迁移随 API 启动自动执行，无需手动操作。

## 前置要求

- 一台服务器（1C1G 起步足够）
- 已安装 Docker + Docker Compose（或 Podman）
- 开放入站端口 `8080`（API）。PostgreSQL/Redis 仅容器内通信并绑定 `127.0.0.1`，**不要**对公网开放

## 方式一：免克隆最小部署（推荐）

无需克隆源码，直接使用公开镜像 `ghcr.io/tuzkimo/wee-count-api:latest`。

1. 在服务器上建一个目录（如 `wee-count`），保存以下内容为 `compose.yml`：

```yaml
services:
  api:
    image: ghcr.io/tuzkimo/wee-count-api:latest
    ports: ["8080:8080"]
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-wee}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-wee-count}?sslmode=disable
      REDIS_URL: redis:6379
      REDIS_PASSWORD: ${REDIS_PASSWORD}
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET must be set}
      CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:-http://tauri.localhost}
      # 服务位于可信反向代理（Caddy 等）之后时设为 true；直连暴露 8080 时保持 false（默认）。
      TRUST_PROXY: ${TRUST_PROXY:-false}
      AI_API_KEY: ${AI_API_KEY:-}
      AI_BASE_URL: ${AI_BASE_URL:-https://api.deepseek.com/v1}
      AI_MODEL: ${AI_MODEL:-deepseek-chat}
      AI_MAX_TOKENS: ${AI_MAX_TOKENS:-1024}
      AI_TIMEOUT: ${AI_TIMEOUT:-60s}
      AI_RATE_LIMIT: ${AI_RATE_LIMIT:-20}
      AI_DAILY_LIMIT: ${AI_DAILY_LIMIT:-200}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-wee}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}
      POSTGRES_DB: ${POSTGRES_DB:-wee-count}
    ports: ["127.0.0.1:5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-wee} -d ${POSTGRES_DB:-wee-count}"]
      interval: 3s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--requirepass", "${REDIS_PASSWORD:?REDIS_PASSWORD must be set}"]
    ports: ["127.0.0.1:6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

2. 同目录创建 `.env`（**务必改掉三个必填值**）：

```env
POSTGRES_PASSWORD=<改成强密码>
REDIS_PASSWORD=<改成强密码>
JWT_SECRET=<改成随机长字符串>
```

3. 启动并验证：

```bash
docker compose up -d
# 返回 4xx（缺少请求体）即说明 API 已正常监听
curl -i -X POST http://<服务器IP>:8080/api/v1/auth/register
```

## 方式二：源码构建

```bash
git clone https://github.com/tuzkimo/wee-count.git
cd wee-count/backend
# 同样创建 .env（见下方变量表）
docker compose up -d --build
```

仓库自带 `backend/docker-compose.yml`，`api` 服务带 `build: .`，会在本地构建镜像。

## 环境变量

`DATABASE_URL` / `REDIS_URL` 不需要手填——compose 用容器服务名拼好默认值透传给 API。

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `POSTGRES_PASSWORD` | 是 | — | PostgreSQL 密码 |
| `REDIS_PASSWORD` | 是 | — | Redis 密码 |
| `JWT_SECRET` | 是 | — | JWT 签名密钥，随机长字符串 |
| `POSTGRES_USER` | 否 | `wee` | PostgreSQL 用户 |
| `POSTGRES_DB` | 否 | `wee-count` | 数据库名 |
| `CORS_ALLOWED_ORIGINS` | 否 | `http://tauri.localhost` | 允许的来源，逗号分隔，需含 scheme |
| `TRUST_PROXY` | 否 | `false` | 是否信任反代转发的 `X-Forwarded-For` |
| `PORT` | 否 | `8080` | API 监听端口（一般不动） |

> **限流信任模型**：登录/注册/入组按 IP 限流 10 次/分钟。`TRUST_PROXY=false`（默认）时取 socket peer 地址，客户端无法伪造；仅当 API 位于可信反向代理之后时设 `true`，否则攻击者可伪造 `X-Forwarded-For` 绕过限流。

## 启用 AI（可选）

AI 是**可选**功能。不配置 `AI_API_KEY` 时：后端照常启动（其余变量全都不用管），`GET /api/v1/ai/status` 返回 `{"enabled":false,...}`。客户端那一侧的**聊天功能**（AI 入口 tab、隐私说明卡、隐私开关）属于 **M3**、目前**尚未实现**；注意 `src/services/ai/` 下**已经有**代码，但那是 M1 交付的**本地查询层**（把 AI 给的查询 DSL 编译成 SQL 在本地 SQLite 上跑），**不走后端 AI 接口**、与本节的变量无关。M3 落地后，App 在 `enabled:false` 时不显示 AI 入口。启用只需要一个供应商的 key。

变量表（全部可选，非法值一律回落默认值，不会让服务起不来）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `AI_API_KEY` | 空（= 禁用） | **唯一开关**。留空即整个 AI 功能禁用，其余 `AI_*` 全部无效 |
| `AI_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容接口地址，末尾斜杠会被规范化掉 |
| `AI_MODEL` | `deepseek-chat` | 模型名，填该供应商的模型 ID |
| `AI_MAX_TOKENS` | `1024` | 单次回复的 token 上限 |
| `AI_TIMEOUT` | `60s` | 上游调用超时（Go duration 格式：`30s`、`2m`） |
| `AI_RATE_LIMIT` | `20` | 每用户每分钟请求数上限 |
| `AI_DAILY_LIMIT` | `200` | 每用户每日请求数上限 |

只支持 **OpenAI 兼容协议**，换供应商只需改 `AI_BASE_URL`（+ `AI_MODEL`）：

| 供应商 | `AI_BASE_URL` |
|--------|---------------|
| DeepSeek（默认） | `https://api.deepseek.com/v1` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi | `https://api.moonshot.cn/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |

方式二（源码构建）的 `backend/docker-compose.yml` **已经透传**这 7 个变量，且全部是 `${VAR:-}` 空默认——把值写进同目录的 `.env` 即可，不配也能起来。方式一（免克隆）请在自己的 `compose.yml` 的 `api` 服务 `environment` 下补上同样几行：

```yaml
      AI_API_KEY: ${AI_API_KEY:-}
      AI_BASE_URL: ${AI_BASE_URL:-https://api.deepseek.com/v1}
      AI_MODEL: ${AI_MODEL:-deepseek-chat}
      AI_MAX_TOKENS: ${AI_MAX_TOKENS:-1024}
      AI_TIMEOUT: ${AI_TIMEOUT:-60s}
      AI_RATE_LIMIT: ${AI_RATE_LIMIT:-20}
      AI_DAILY_LIMIT: ${AI_DAILY_LIMIT:-200}
```

> 不要写成 `${AI_API_KEY:?}` 那种"必须设置"的形式：那会让**所有没配 AI 的实例起不来**，而 AI 是可选的。

Key 只存在于服务器进程内存里，由服务端注入到上游请求头。**客户端拿不到它，`/ai/status` 也不返回它**。

### 数据边界（请如实告知使用者）

- **账目数据不经过服务器。** 服务端只是个**无状态代理**：注入 key、把这一轮对话所需的请求转发给供应商，**不读也不存任何账目数据**。AI 回答要用的统计数字（汇总值，以及最多 20 条明细的日期/金额/分类名/账户名/备注截断）是**客户端在本地算好后放进对话里**的（M3 实现），服务端不主动查数据。
- **只发当前这次请求需要的内容**（清单由 M3 的客户端组装，服务端只转发、不增删）：用户输入原文；分类/账户/标签/成员的名称；本轮工具返回的汇总数字。完整流水、账户余额、初始余额、信用额度、其他账本数据、备份密码、任何凭据都不发。
- 用户问的每一句话都会发往 `AI_BASE_URL` 指向的供应商，请在隐私说明里告知使用者。M3 落地后，App 会在首次开启 AI 前展示一张说明卡，卡片里的供应商域名取自 `/api/v1/ai/status` 的 `host` 字段（由 `AI_BASE_URL` 解析而来，**不含 key**）；取不到 `host` 时 App 不得允许开启（规格 §7.3）。该字段现在就已经可用。
- 启用是**两层开关**：服务端 `AI_API_KEY` 非空只是"能力可用"；M3 会在 App「我的 → 隐私」里再提供一个**默认关闭**的独立开关（意愿层），用户看过说明卡并同意后才真正发送。
- 服务端日志**只记**：`user_id`、耗时、`finish_reason`、token 用量（prompt/completion）与错误码（`handler/ai.go:60-61/66-68`），加上成功路径上的上游状态码 `upstream=200`（`service/ai.go:202-204`）；请求体解析失败时会记下该 `user_id` 与 Go 的 decode 报错原文（`handler/ai.go:46`）——那是 `json` 包的位置/类型报错，**不含消息内容**。**不记**：对话内容、工具结果、任何账目数字。上游返回的原始错误体既不下发给客户端、也不写进日志（`service/ai.go:190-195`）。

### 配额：多实例时按实例各算一份

分钟级限流与日配额都由 `httprate` 实现，计数器在**进程内存**里（滑动窗口），不是共享存储：

- 单实例自托管：就是配置的 `AI_RATE_LIMIT` / `AI_DAILY_LIMIT`，够用。
- **多实例部署时每个实例各有一份配额。** 例如 3 个副本 + `AI_DAILY_LIMIT=200`，实际日上限约 **3 × 200 = 600/日**；分钟级同样按实例各算一份。**不要把它当成全局配额来估算成本。**
- 日配额的**边界不由你的请求决定，也不是自然日 0 点**：`httprate` 在创建限流器（= 进程启动）时就定死了窗口相位（`limiter.go:43-44`），窗口是 `t.Add(-offset).Truncate(24h).Add(offset)`（`limiter.go:161-163`，按 UTC）——**所有用户共用同一条边界**，与"某个用户第一次请求的时刻"无关；进程启动那一刻正好是一个边界，下一个边界是"启动 + 24h"。多实例启动时刻不同 ⇒ 边界也不同。
- 它是"滑动窗口"的近似：跨过边界后，上一个窗口的计数仍按剩余比例计入（`limiter.go:176`），所以额度是**逐渐恢复**的，不是到点瞬间清零。
- **`/ai/status` 不吃日配额**：日配额只包 `/ai/chat`，status 只走鉴权 + 分钟级限流（`router.go:100-111`）——它是本地响应、不发上游，而客户端要拿它决定是否展示隐私卡；若让它吃日配额，一个轮询 bug 就能在零 AI 调用的情况下把当天额度耗光。
- **被分钟级限流拒掉的请求不计入日配额**：httprate 只给**放行**的请求计数（`limiter.go:102-110`，超限直接 return），而分钟级在外层（`router.go:100-105`）⇒ 被它拒掉的请求根本到不了日配额那一层。反过来（日配额在外层）会让"连点重试"在**一次 AI 都没调用**的情况下耗光当天额度。
- **分钟级限流按用户、两个端点共用一个桶**：`/ai/status` 与 `/ai/chat` **合计**每分钟不超过 `AI_RATE_LIMIT` 次——探状态不是免费的，它同样占该用户的每分钟额度（打满后**打哪个端点**都是 429 `ai_rate_limited`）。日配额只约束 `/ai/chat`，探状态不吃日配额。之所以共用一个桶（同一个 limiter 实例，`router.go:94-95` 创建、`:100-110` 挂载），是因为给两个端点各建一个桶会让 `/ai/*` 的每分钟总量**静默翻倍**。
- 前置反代做负载均衡时，同一用户在不同实例间漂移会使计数更分散。
- 需要跨实例的精确配额，请部署为单实例，或改用 Redis 实现（v1 未提供，见设计文档 §6.3）。

### 故障对照

M3 落地后，客户端会按响应体里的 `error` 值映射中文文案（服务端现在就已经返回这些错误码）；排障时请把状态码和 `error` 一起看：

> **⚠️ `error` 值分三类，客户端映射时必须区分**（否则会落到未定义分支）：
> 1. **契约错误码**（下表带 `ai_` 前缀的那些）：规格 §6.6 定义，客户端有对应中文文案。
> 2. **限流中间件码**：`ai_rate_limited` / `ai_quota_exceeded` —— 它们和契约码**同样带前缀**，
>    由 `router.go` 的限流处理器产出（同一个 `{"error":"<code>"}` 形状），客户端按码处理。
> 3. **无前缀的直述消息**：`invalid request body`、`request body too large`、`unauthorized` ——
>    这些**不是错误码**，是**面向开发者的直述文本**（规格 §6.6 没有为它们定义码，本轮也不新增）。
>    **客户端不得把它们当码查表**（查不到）；带 `ai_` 前缀的一律按码表映射，其余一律走兜底文案
>    （如「请求失败，请重试」）。判据就一条：**看有没有 `ai_` 前缀**。

| 现象 | HTTP | 响应 `error` | 处理 |
|------|------|--------------|------|
| `AI_API_KEY` 未配置 | 503 | `ai_disabled` | 填 key 后重启（M3 的 App 端文案为「AI 功能未启用」） |
| key 无效 / 无权限（上游 401、403） | 502 | `ai_upstream_auth` | 检查 key 与 `AI_BASE_URL` 是否配套 |
| 上游自己限流（上游 429） | 429 | `ai_rate_limited` | 等上游恢复或换更高档位 |
| 本实例每分钟配额用尽 | 429 | `ai_rate_limited` | 调大 `AI_RATE_LIMIT` |
| 本实例每日配额用尽 | 429 | `ai_quota_exceeded` | 调大 `AI_DAILY_LIMIT`；多实例记得按实例数折算 |
| 上游 5xx，或调用超时 | 504 | `ai_upstream_timeout` | 调大 `AI_TIMEOUT`，或查看供应商状态页 |
| 网络不可达 / DNS 解析失败 | 502 | `ai_unreachable` | 检查容器出网与 `AI_BASE_URL` 域名 |
| 上游其它 4xx（模型名写错等） | 502 | `ai_upstream_error` | 检查 `AI_MODEL` |
| 单次请求体超过 256KB | 413 | `request body too large` | 正常使用不会触发；会话历史异常长时才可能。**这不是错误码**，是直述消息（见上注） |
| 请求体非法 JSON，或 `messages` 为空 | 400 | `invalid request body` | 通常是客户端组装 bug（M3 的请求体形状见规格 §6.1）。**这不是错误码**，是直述消息（见上注） |
| 无 / 非法 access token | 401 | `unauthorized` | 走既有 refresh 单飞；失败则提示重新登录。**这不是错误码**，是直述消息 |

## App 对接

App「我的」页 → 在线同步 → 填入 API 地址：

```
http://<服务器IP>:8080/api/v1

# 前置 HTTPS 反代时：
https://<你的域名>/api/v1
```

## HTTPS（生产建议）

前置 nginx/Caddy 反向代理 + Let's Encrypt，或 Cloudflare Tunnel。此时：

- `CORS_ALLOWED_ORIGINS` 保持 `http://tauri.localhost` 不变——CORS 校验的是 App webview 来源，与后端域名无关
- `TRUST_PROXY=true`（限流取真实客户端 IP）

## 升级

**方式一（免克隆/镜像）**：

```bash
docker compose pull api
docker compose up -d
```

**方式二（源码构建）**：

```bash
git pull
docker compose up -d --build
```

数据库迁移随新版本启动自动执行。

## 备份

记账数据是资产级数据，建议每日定时备份：

```bash
# 备份（cron 建议）
docker compose exec postgres pg_dump -U wee wee-count > wee-count-$(date +%F).sql

# 恢复
cat wee-count-2026-09-08.sql | docker compose exec -T postgres psql -U wee wee-count
```

以上命令假设 `.env` 使用默认的 `POSTGRES_USER=wee`、`POSTGRES_DB=wee-count`；若你改过这两个值，请对应替换命令中的 `-U wee` 与库名。
