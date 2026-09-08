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
