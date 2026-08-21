# 后端 CI/CD 自动部署指南

> 适用对象：没有运维经验也能照着操作。整套流程已经配好（`.github/workflows/deploy-backend.yml` + `docker-compose.yml` 的 `image` 行），本文只讲**你还需要手动做的**和**日常怎么用**。

## 0. 这套流程做了什么

把后端代码 push 到 `main` 分支（且改动涉及 `backend/` 目录）后，GitHub 会自动：

```text
push 到 main
   │
   ▼
① 跑测试 (go test)
   │
   ▼
② 打包成 Docker 镜像，推到 GHCR（ghcr.io/tuzkimo/wee-count-api）
   │
   ▼
③ SSH 登录服务器 → 拉新镜像 → 重启后端容器
   │
   ▼
线上后端自动更新，数据库迁移也随启动自动执行
```

**你平时唯一要做的，就是正常 `git push`，剩下的全自动。**

下面第 1 节的准备只做一次。

---

## 1. 一次性准备（只做一次）

一共 4 步，每步都标了「在哪台机器上操作」。

### 1.1 生成 GitHub 访问令牌（PAT）—— 在 GitHub 网页

目的：让服务器能拉取你的私有镜像。

1. 打开 GitHub → 右上角头像 → **Settings**
2. 左侧菜单拉到最下面 → **Developer settings**
3. **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**
4. Note 随便填（如 `wee-count-server`），Expiration 选 **90 days** 或 **No expiration**
5. 权限只勾一个：**`read:packages`**
6. 点 Generate，**立刻复制保存**这串 token（`ghp_` 开头，只显示这一次）

### 1.2 服务器登录 GHCR —— 在服务器

SSH 登录服务器后执行：

```bash
docker login ghcr.io -u tuzkimo
# 提示 Password: 时粘贴 1.1 的 token（粘贴时屏幕不显示任何字符，这是正常的）
```

看到 `Login Succeeded` 即成功。

### 1.3 配置 SSH 密钥 —— 在服务器

目的：让 GitHub Actions 能 SSH 连上你的服务器执行部署命令。

SSH 登录服务器后，一次性执行下面命令：生成密钥对，并把公钥加到服务器自己的「允许登录」列表：

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/wee-count-deploy -N ''
cat ~/.ssh/wee-count-deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

> 说明：公钥留在服务器上，表示「允许持有对应私钥的人登录」；私钥你复制一份填到 GitHub 给 Actions 用。因为公钥本来就要放进服务器，直接在服务器上生成最省事，本地电脑完全不参与。

然后查看私钥内容（马上要填到 GitHub）：

```bash
cat ~/.ssh/wee-count-deploy
```

把输出**从头到尾完整复制**（包括 `-----BEGIN OPENSSH PRIVATE KEY-----` 和 `-----END ...-----` 这两行）。

### 1.4 配置 GitHub Secrets —— 在 GitHub 网页

1. 打开你的仓库 → **Settings** → **Secrets and variables** → **Actions**
2. 点 **New repository secret**，依次添加下面 3 个：

| Name | 填什么 |
|------|--------|
| `DEPLOY_HOST` | 服务器公网 IP 或域名，**只要主机名**，不要端口、不要 `user@` |
| `DEPLOY_USER` | SSH 登录用户名，如 `tuzkimo` |
| `DEPLOY_SSH_KEY` | 1.3 复制的私钥全文 |

### 1.5 服务器准备部署目录 —— 在服务器

```bash
cd /home/tuzkimo/wee-count
git pull                 # 拉取最新的 docker-compose.yml（含 image 行）
cd backend
ls -la                   # 确认能看到 docker-compose.yml 和 .env
```

`.env` 不进版本控制，需要手动建：复制 `backend/.env.example` 为 `backend/.env`，填入实际值（`POSTGRES_PASSWORD`、`REDIS_PASSWORD`、`JWT_SECRET` 必须改成强密码/随机串）。详细说明见 README「后端部署」章节。

---

## 2. 日常使用

### 2.1 上线一次后端

改完代码后，正常提交并推送：

```bash
git add backend
git commit -m "feat: 某某改动"
git push origin main
```

只要改动涉及 `backend/` 目录，部署就自动开始，**无需任何额外操作**。

### 2.2 查看部署结果

1. GitHub 仓库 → **Actions** 标签页
2. 找到 `deploy-backend` 那次运行
3. 三个 job 依次变绿 ✓（test → build-push → deploy）即成功；红色 ✗ 说明失败，点进去看日志

### 2.3 验证线上已更新

```bash
curl http://<服务器IP>:8080/api/v1/auth/register
```

返回 4xx（如 `400` 缺少请求体）说明 API 正常在跑。

---

## 3. 出问题怎么办

### 3.1 定位失败在哪一步

- **test 失败**：代码没过测试，看日志改代码重新 push
- **build-push 失败**：打包镜像失败，看日志
- **deploy 失败**：SSH 连不上或服务器命令报错。检查：`DEPLOY_HOST`/`DEPLOY_USER` 填对没、`DEPLOY_SSH_KEY` 是否完整、端口是不是 `29876`、公钥放对没

### 3.2 回滚到上一个版本

最简单的方式：把那次改动 `git revert` 掉再 push，自动部署回旧版。

也可以在服务器手动回滚到某次构建（每次构建还额外打了 sha 标签，可在 Actions 的 build-push 日志里找到）：

```bash
cd /home/tuzkimo/wee-count/backend
docker pull ghcr.io/tuzkimo/wee-count-api:<那次的sha>
# 然后临时把 docker-compose.yml 的 image 行改成该 sha，docker compose up -d
```

### 3.3 改了 docker-compose.yml 本身

CI 只自动更新后端程序（镜像），**不会**同步 compose 文件。改了 `docker-compose.yml`（如加服务、改环境变量）后，需手动在服务器同步：

```bash
cd /home/tuzkimo/wee-count && git pull
docker compose up -d
```
