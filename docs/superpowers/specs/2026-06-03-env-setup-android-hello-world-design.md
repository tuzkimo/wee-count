# 环境搭建 & Android 真机 Hello World

## 目标

从零搭建 Tauri 2.0 + Vue 3 开发环境，在 Windows 上编译并推到 Android 真机运行 Hello World。

## 前提

- Windows 11（当前机器）
- 无 Android SDK/NDK、无 Rust、无 Tauri 经验
- 真机调试（有 Android 手机，可 USB 连接）
- 原始开发方案中 Svelte 5 → 改为 Vue 3（运行时体积更小、上手成本更低）

## 步骤

### 1. 基础工具链安装

| 工具 | 版本要求 | 安装方式 |
|------|---------|---------|
| Node.js | >= 18 | `winget install OpenJS.NodeJS.LTS` 或官网 msi |
| Rust | stable | `winget install Rustlang.Rustup` 然后 `rustup default stable` |
| JDK 17 | Eclipse Temurin 17 | `winget install EclipseAdoptium.Temurin.17.JDK` |
| Android Studio | 最新稳定版 | 官网下载，Custom 安装，勾选 Android SDK Platform-Tools |

### 2. 环境变量

```
JAVA_HOME = C:\Program Files\Eclipse Adoptium\jdk-17.0.14.7-hotspot\
ANDROID_HOME = %LOCALAPPDATA%\Android\Sdk
NDK_HOME  = %ANDROID_HOME%\ndk\<版本号>  # 装完 NDK 后从目录名确定，Tauri 通常自动推导
```

### 3. Android SDK 配置

- 打开 Android Studio → SDK Manager → SDK Tools 标签页
- 勾选 NDK (Side by side)，Apply 安装
- NDK 版本号由安装后的目录名确定，例如 `27.0.12077973`

### 4. 项目脚手架

```bash
npm create tauri-app@latest wee-count -- --template vue-ts
```

生成结构：`src/`（Vue 3 + TypeScript），`src-tauri/`（Rust 壳）

### 5. 桌面端验证

```bash
cd wee-count
npm install
cargo tauri dev
```

先确认桌面端正常运行。

### 6. Android Target 配置

```bash
rustup target add aarch64-linux-android
cd src-tauri
cargo tauri android init
cargo tauri android dev
```

`tauri android init` 自动检测 SDK/NDK 路径，生成 `src-tauri/gen/android/` Gradle 工程。`tauri android dev` 编译 Rust → so，打包 APK，通过 ADB 推送到设备。

### 7. 真机连接

- 手机：设置 → 关于手机 → 连点版本号 7 次 → 开发者模式
- 设置 → 开发者选项 → 开启 USB 调试 + USB 安装
- USB 连电脑，手机确认授权
- `adb devices` 验证设备已列出

### 8. 最后一步

```bash
cargo tauri android dev
```

应用应出现在手机上。

## 风险点

- **NDK 版本**：Tauri 2.0 要求 NDK 26+，SDK Manager 安装即可
- **首次构建慢**：Gradle + Rust crate + Android SDK 下载，可能 20-30 分钟
- **WebView 兼容**：Android 10+ 的 System WebView >= Chromium 90，满足要求
- **构建报错时**：先确认 `JAVA_HOME` 和 `ANDROID_HOME` 已正确设置，NDK 已安装

## 验收标准

- 桌面端 `cargo tauri dev` 正常打开窗口，显示 Vue 页面
- 手机端 `cargo tauri android dev` 正常安装并启动，显示同一页面
