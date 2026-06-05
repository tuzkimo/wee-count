# CLAUDE.md

## 项目概述

一起记账（WeeCount）— 离线优先、家庭/团队协同的资产级记账 App，移动端（Android）优先。
- 前端：Vue 3 + TypeScript + Vite
- 客户端壳：Tauri 2.0（桌面端仅用于开发调试，Android 为正式目标平台）
- 本地存储：SQLite（`@tauri-apps/plugin-sql`）
- 后端：Go + PostgreSQL + Redis

## 开发命令

```bash
# 前端
npm run dev              # 启动 Vite 开发服务器 (端口 1420)
npm run build            # vue-tsc 类型检查 + Vite 构建

# Tauri 桌面端（开发调试用）
npm run tauri dev        # 启动桌面开发模式

# Tauri Android 端
npm run tauri android dev  # 编译 + 推送到已连接的 Android 设备
npm run tauri android build  # 构建发布包 (.apk)

# 验证
npm run test             # 前端单元测试（vitest）
npm run test:watch       # 前端测试（监听模式）
cargo check              # Rust 类型检查（不编译，快）
cargo clippy             # Rust lint
cargo test               # Rust 单元测试
```

## 技术约束

- 不重构无关代码，不要修改未被明确要求的文件。
- 测试优先：非 bugfix 类功能实现需附带单元测试，不可删改已有测试。
- TypeScript 严格模式，禁止 `any`。
- 每次 commit 必须同步更新 README.md，确保 README.md 反映真实项目状态。
