# WeeCount 后端 — 部署与操作指南

> 适用版本：Phase 3 完成后。面向无后端基础的用户，按步骤操作即可。

---

## 目录

1. [你需要什么](#1-你需要什么)
2. [安装 Docker](#2-安装-docker)
3. [配置环境变量](#3-配置环境变量)
4. [启动后端服务](#4-启动后端服务)
5. [验证服务是否正常](#5-验证服务是否正常)
6. [连接前端使用](#6-连接前端使用)
7. [完整操作流程](#7-完整操作流程)
8. [常用命令速查](#8-常用命令速查)
9. [常见问题排查](#9-常见问题排查)
10. [部署到外网（可选）](#10-部署到外网可选)

---

## 1. 你需要什么

- 一台电脑（Windows / macOS / Linux 均可），能联网
- 仅运行后端服务需要 **Docker Desktop**，不需要安装 Go 环境
- 如果要修改后端代码才需要 Go 1.22+

---

## 2. 安装 Docker

Docker 负责运行 PostgreSQL 数据库和 Redis 缓存，以及后端 API 服务。

### Windows 用户

1. 访问 https://www.docker.com/products/docker-desktop/
2. 下载 **Docker Desktop for Windows**，双击安装
3. 安装完成后重启电脑
4. 启动 Docker Desktop，任务栏出现鲸鱼图标即为运行中

> **注意**：如果电脑开启了 WSL（Windows Subsystem for Linux），Docker 会自动使用 WSL 2。没开启也可以直接运行。

### macOS 用户

```bash
brew install --cask docker
# 或直接下载：https://www.docker.com/products/docker-desktop/
```

安装后从"应用程序"启动 Docker Desktop。

### Linux 用户

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install docker.io docker-compose-v2 -y
sudo systemctl enable docker --now

# 把自己加入 docker 组，免 sudo
sudo usermod -aG docker $USER
# 重新登录生效
```

### 验证安装

打开终端（命令提示符/PowerShell/终端），输入：

```bash
docker --version
# 预期输出类似：Docker version 28.x.x

docker compose version
# 预期输出类似：Docker Compose version v2.x.x
```

两项都有输出即为成功。

---

## 3. 配置环境变量

### 3.1 进入后端目录

```bash
cd backend
```

### 3.2 创建 .env 文件

`.env` 文件存储数据库密码、加密密钥等敏感信息。项目已有 `.env.example` 模板，直接复制即可：

```bash
cp .env.example .env
```

### 3.3 修改密码

用记事本（或任意编辑器）打开 `backend\.env` 文件，会看到：

```
# 数据库
POSTGRES_USER=wee
POSTGRES_PASSWORD=change-me          # ← 改掉这里的密码
POSTGRES_DB=wee-count
DATABASE_URL=postgres://wee:change-me@postgres:5432/wee-count?sslmode=disable
                                                 # ↑ 和上面改的密码一致

# Redis
REDIS_URL=redis:6379

# JWT
JWT_SECRET=change-me-in-production   # ← 改成一段随机字符串，越长越好
```

**必须修改的三处：**

| 变量 | 说明 | 如何生成 |
|------|------|----------|
| `POSTGRES_PASSWORD` | 数据库密码 | 自己想一个复杂密码，如 `MyP@ssw0rd2026!` |
| `DATABASE_URL` | 数据库连接地址 | 把其中的 `change-me` 替换为上面设置的密码 |
| `JWT_SECRET` | 登录凭证加密密钥 | 随机敲一堆字符，如 `hK9#mP2$vL7@xQ5!nW8^` |

改完后的例子：

```
POSTGRES_USER=wee
POSTGRES_PASSWORD=MyP@ssw0rd2026!
POSTGRES_DB=wee-count
DATABASE_URL=postgres://wee:MyP@ssw0rd2026!@postgres:5432/wee-count?sslmode=disable
REDIS_URL=redis:6379
JWT_SECRET=hK9#mP2$vL7@xQ5!nW8^jF3&bR6@cT1
```

> **安全提醒**：不要用示例中的密码和密钥，自己编一个。后续如果泄露了，改掉 `.env` 重启服务即可。

---

## 4. 启动后端服务

### 4.1 一键启动全部服务

```bash
cd backend
docker compose up -d
```

含义：`-d` 表示后台运行。Docker 会自动下载并启动三个服务：

| 服务 | 用途 | 端口 |
|------|------|------|
| `api` | Go 后端 API（WeeCount 核心） | 8080 |
| `postgres` | PostgreSQL 数据库（存储用户、账本、交易） | 5432 |
| `redis` | Redis 缓存（存储团队邀请码） | 6379 |

首次运行会：
1. 下载 Go、PostgreSQL、Redis 镜像（约 2-5 分钟，取决于网速）
2. 编译后端代码
3. 自动创建数据库表结构

**看到所有服务 `healthy` 或 `up` 即可。**

### 4.2 查看运行状态

```bash
docker compose ps
```

预期输出（三个服务 STATUS 都是 `healthy` 或 `Up`）：

```
NAME                   STATUS
backend-api-1          Up
backend-postgres-1     Up (healthy)
backend-redis-1        Up (healthy)
```

### 4.3 查看日志

```bash
# 查看所有服务日志
docker compose logs

# 只看 API 服务的日志（加 -f 实时追踪）
docker compose logs -f api

# 查看最近 20 行
docker compose logs --tail=20 api
```

按 `Ctrl+C` 退出日志追踪。

### 4.4 停止服务

```bash
# 停止但保留数据
docker compose stop

# 再次启动
docker compose up -d

# 停止并删除所有容器（数据库数据保留在 pgdata 卷中）
docker compose down
```

---

## 5. 验证服务是否正常

### 5.1 检查 API 是否响应

```bash
curl http://localhost:8080/api/v1/auth/register
```

预期返回 `405 Method Not Allowed` 或其他 JSON 错误（因为访问方式不对，但说明服务在运行）。

在浏览器打开 `http://localhost:8080/api/v1/auth/register` 也能看到返回的 JSON。

> **Windows 提示**：如果系统没有 `curl`，可以用 PowerShell 自带的：
> ```powershell
> Invoke-WebRequest -Uri http://localhost:8080/api/v1/auth/register
> ```
> 或者直接打开浏览器访问。

### 5.2 测试注册（完整功能验证）

打开命令行，用 curl 测试完整注册流程：

**1) 注册一个用户**

```bash
curl -s -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"alice@test.com\",\"password\":\"pass123\",\"nickname\":\"Alice\"}"
```

> **Windows PowerShell 用户**：PowerShell 的 `curl` 是别名，语法不同。用这个代替：
> ```powershell
> $body = '{"email":"alice@test.com","password":"pass123","nickname":"Alice"}'
> Invoke-RestMethod -Uri http://localhost:8080/api/v1/auth/register -Method Post -Body $body -ContentType "application/json"
> ```

成功后返回类似（201 Created）：

```json
{
  "user": {
    "id": "a1b2c3d4-...",
    "nickname": "Alice",
    "email": "alice@test.com",
    "created_at": "2026-06-16T12:00:00Z",
    "updated_at": "2026-06-16T12:00:00Z"
  },
  "access_token": "eyJhbGciOi...",
  "refresh_token": "eyJhbGciOi..."
}
```

**2) 登录**

```bash
curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"alice@test.com\",\"password\":\"pass123\"}"
```

成功后返回 200，包含新的 `access_token` 和 `refresh_token`。

**3) 使用 access_token 调用受保护的 API**

```bash
# 把下面 YOUR_ACCESS_TOKEN 替换为上一步返回的 access_token
curl -s http://localhost:8080/api/v1/me \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

成功后返回用户信息和账本列表：

```json
{
  "user": { "id": "...", "nickname": "Alice", "email": "alice@test.com", ... },
  "ledgers": [ { "id": "...", "name": "Alice的账本", "type": "personal", ... } ],
  "teams": []
}
```

---

## 6. 连接前端使用

后端 API 默认在 `http://localhost:8080`。前端已经配好了开发环境 API 地址。

### 6.1 启动前端开发服务器

```bash
# 在项目根目录（不是 backend 目录）
npm run dev
```

前端会在 `http://localhost:1420` 启动。

### 6.2 前端 API 地址配置

前端通过 `src/services/api.ts` 中的环境变量决定连接哪个后端：

```typescript
const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080/api/v1"
```

| 场景 | VITE_API_URL | 说明 |
|------|-------------|------|
| 开发调试 | 不设置（默认） | 自动连接 `localhost:8080` |
| 指定其他后端 | 设置为你的服务器地址 | 如 `http://192.168.1.100:8080/api/v1` |

开发时不需要额外配置，直接 `npm run dev` 即可。

### 6.3 前端注册、登录、同步

启动后在手机上或浏览器中打开 `http://localhost:1420`：

1. 点击底部"我的"
2. 点击"注册"，填写昵称、邮箱、密码
3. 注册成功自动跳回"我的"页面，显示用户信息
4. 记一笔账，3 秒后自动同步到后端
5. 点击"同步"按钮可以手动触发同步

> **说明**：未登录时，App 行为与之前完全一致，所有数据存在本地 SQLite。登录后才能使用同步和团队功能。

---

## 7. 完整操作流程

### 7.1 团队协同（创建团队 → 邀请成员 → 成员加入）

**前提：两个人都已注册并登录。**

#### 创建团队

1. 打开 App → "我的" → 已登录状态下点击"创建团队"
2. 输入团队名称（如"史密斯家庭"）→ 点击"创建团队"
3. 创建成功后自动返回"我的"页面

#### 生成邀请码

邀请功能目前通过 API 调用（后续版本会加上 UI）。创建团队的人（即团队 owner）运行：

```bash
# 先登录获取 access_token，然后用创建团队时返回的 team_id
# 注意：需要先把 ACCESS_TOKEN 和 TEAM_ID 替换为实际值
curl -s -X POST http://localhost:8080/api/v1/teams/YOUR_TEAM_ID/invite \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

返回：

```json
{
  "invite_code": "482915",
  "expires_in": 86400
}
```

把 `482915` 这 6 位数字发给要邀请的成员。

> 注意：创建团队时的 POST /teams 返回体里会带有 team 数据的 id 记在一个 `team` 里的 `id`中使用。invite_code 有效期 24 小时。

#### 成员加入团队

收到邀请码的人：
1. 打开 App → "我的" → 已登录状态下点击"加入团队"
2. 输入 6 位邀请码 → 点击"加入团队"
3. 加入成功后自动触发同步，团队账本会出现在"我的"页面

### 7.2 数据同步机制

**同步是自动的，不需要手动操作。**

- 你在本地的每次记账、修改、删除，3 秒后自动推送到服务器
- 打开 App、登录后也会自动同步
- 多人同时同步时使用**最后写入胜出（LWW）**策略：修改时间更新的一方保留
- 在"我的"页面可以点击同步状态条手动触发同步

---

## 8. 常用命令速查

| 操作 | 命令 | 在哪里执行 |
|------|------|-----------|
| 启动所有服务 | `docker compose up -d` | `backend/` 目录 |
| 停止所有服务 | `docker compose stop` | `backend/` 目录 |
| 删除容器（保留数据） | `docker compose down` | `backend/` 目录 |
| 查看运行状态 | `docker compose ps` | `backend/` 目录 |
| 查看日志 | `docker compose logs -f api` | `backend/` 目录 |
| 重启 API 服务 | `docker compose restart api` | `backend/` 目录 |
| 进入数据库命令行 | `docker compose exec postgres psql -U wee -d wee-count` | `backend/` 目录 |
| 启动前端 | `npm run dev` | 项目根目录 |
| 运行后端测试 | `cd backend && go test ./...` | `backend/` 目录 |
| 运行前端测试 | `npm run test` | 项目根目录 |

### 数据库常用查询

```bash
# 进入数据库命令行
docker compose exec postgres psql -U wee -d wee-count

# 进去后可以执行：
\d users          # 查看 users 表结构
SELECT * FROM users;     # 查看所有用户
SELECT * FROM ledgers;   # 查看所有账本
\dt               # 列出所有表
\q                # 退出
```

---

## 9. 常见问题排查

### 问题：docker compose up 报错 "port is already allocated"

**原因**：电脑上已有其他程序占用了 8080 / 5432 / 6379 端口（最常见的是已安装的 PostgreSQL 或 Redis）。

**解决**：

```bash
# Windows：查看谁占用了 5432 端口
netstat -ano | findstr :5432

# macOS/Linux：
lsof -i :5432
```

找到占用的程序后关掉它，或者在 `docker-compose.yml` 中修改端口映射：
```yaml
ports:
  - "8081:8080"   # 把本机 8080 改为 8081
```

### 问题：docker compose up 后 api 服务反复重启

**原因**：后端启动失败（通常是数据库连接不上或迁移失败）。

**排查步骤**：
```bash
# 1. 查看 API 日志
docker compose logs api

# 2. 检查 postgres 是否健康
docker compose ps postgres

# 3. 常见错误：
#    - "missing required environment variables" → .env 文件没配或放在错误位置
#    - "dial tcp: lookup postgres" → 确认 docker-compose.yml 中 service 名为 postgres
#    - "password authentication failed" → DATABASE_URL 中的密码与 POSTGRES_PASSWORD 不一致
```

### 问题：注册时返回 "email already registered"

**原因**：该邮箱已被注册。

**解决**：换一个邮箱注册，或用已有账号登录。

### 问题：调用 /api/v1/me 返回 401

**原因**：access_token 过期（15 分钟有效期）。

**解决**：前端会自动用 refresh_token 刷新（30 天有效期）。如果是用 curl 测试，重新登录获取新 token 即可。

### 问题：docker compose down 后数据库数据还在吗

**在**。数据库数据存储在 Docker 卷（volume）`backend_pgdata` 中，`docker compose down` 不会删除。

```bash
# 查看卷
docker volume ls | grep pgdata

# 如果要彻底删除数据（注意：不可恢复！）
docker compose down -v
```

### 问题：在 Windows 上 docker 连接不上 localhost

**原因**：Windows 上 Docker 可能通过 WSL 桥接网络。

**解决**：
- Docker Desktop: 设置 → Resources → WSL Integration → 启用当前发行版
- 或者用 `http://host.docker.internal:8080` 代替 `http://localhost:8080`（在容器内访问宿主机时）
- 宿主机访问容器用 `localhost` 即可

### 问题：想改密码（数据库/JWT）

改 `.env` 后重新创建服务：

```bash
docker compose down          # 停止
# 编辑 .env 文件
docker compose up -d         # 重新启动
```

注意：如果只改 JWT_SECRET，不影响已有数据。如果改了数据库密码，需要同时更新 `DATABASE_URL`。

### 问题：团队邀请码过期了

邀请码 24 小时有效。过期后让团队 owner 重新生成一个新的即可。

---

## 10. 部署到外网（可选）

如果你想把后端部署到云服务器，让其他人通过公网访问（而不仅限于 `localhost`）：

### 10.1 部署到云服务器

1. 买一台轻量云服务器（阿里云/腾讯云 2 核 4G 即可，约 ¥50/月），装 Ubuntu 22.04
2. SSH 登录后安装 Docker：
   ```bash
   sudo apt update && sudo apt install docker.io docker-compose-v2 -y
   sudo usermod -aG docker $USER
   # 退出重新登录
   ```
3. 把项目代码上传到服务器（或用 git clone）
4. 在服务器上编辑 `backend/.env`，**务必修改默认密码和 JWT_SECRET**
5. `cd backend && docker compose up -d`
6. 在云服务器防火墙/安全组中开放 **8080 端口**
7. 访问 `http://你的服务器IP:8080/api/v1/auth/register` 验证

### 10.2 前端对接外网后端

创建前端环境变量文件 `.env.production`（在项目根目录）：

```
VITE_API_URL=http://你的服务器IP:8080/api/v1
```

然后构建前端：

```bash
npm run build
```

构建产物在 `dist/` 目录，部署到静态托管服务即可。

> **安全建议**：生产环境务必使用 HTTPS。可以用 nginx 反向代理 + Let's Encrypt 免费证书，或直接用 Cloudflare Tunnel。

---

## 附录：架构速览

```
┌─────────────────┐      HTTPS/REST       ┌─────────────────────┐
│  Vue 3 前端      │ ◄───────────────────► │  Go API (chi)       │
│  (移动端/桌面)    │    /api/v1/*         │  端口 8080          │
│  本地 SQLite     │                       │                     │
└─────────────────┘                       ├─────────────────────┤
                                           │  PostgreSQL :5432   │
                                           │  ┌───────────────┐  │
                                           │  │ users          │  │
                                           │  │ teams          │  │
                                           │  │ ledgers        │  │
                                           │  │ accounts       │  │
                                           │  │ transactions   │  │
                                           │  │ categories     │  │
                                           │  │ tags           │  │
                                           │  └───────────────┘  │
                                           ├─────────────────────┤
                                           │  Redis :6379        │
                                           │  ┌───────────────┐  │
                                           │  │ 邀请码缓存     │  │
                                           │  └───────────────┘  │
                                           └─────────────────────┘
```

**API 路由一览：**

| 方法 | 路径 | 是否需要登录 | 用途 |
|------|------|:----------:|------|
| POST | `/api/v1/auth/register` | 否 | 注册 |
| POST | `/api/v1/auth/login` | 否 | 登录 |
| POST | `/api/v1/auth/refresh` | 否 | 刷新 access_token |
| GET | `/api/v1/me` | 是 | 获取用户信息和账本列表 |
| POST | `/api/v1/sync` | 是 | 双向同步 |
| POST | `/api/v1/teams` | 是 | 创建团队 |
| POST | `/api/v1/teams/{id}/invite` | 是 | 生成邀请码（仅 team owner） |
| POST | `/api/v1/teams/join` | 是 | 通过邀请码加入团队 |

---

如果遇到本指南未覆盖的问题，请查看 `docker compose logs api` 的输出，带着错误日志来问。
