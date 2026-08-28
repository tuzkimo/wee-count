# Android APK 自动发布设计

日期：2026-08-28
状态：已批准

## 背景与目标

后端已通过 `deploy-backend.yml`（push master → 测试 → GHCR → SSH 部署）实现自动部署。本设计为前端 Android 安装包补齐同等能力：推 tag 自动编译 release 签名 APK 并发布到 GitHub Release，形成与开源项目一致的「版本号 + 安装包下载」Release 页。

## 已确认的决策

| 决策点 | 结论 |
| --- | --- |
| 发布触发 | 打 tag（`v*`）才发布，不随 push 自动发版 |
| APK 形态 | 仅 arm64-v8a 单包 |
| 分发渠道 | 仅 GitHub Release（私有仓库，下载需协作者权限，已知并接受） |
| CI 签名 | keystore base64 + 密码存 GitHub Secrets，构建时还原 |
| 实现方式 | 手写 workflow 直接调 Tauri CLI，不用 tauri-action |

## 现状要点

- Tauri 2.0，版本号唯一来源为 `src-tauri/tauri.conf.json` 的 `version`（当前 0.10.1）；`versionCode`/`versionName` 由 Tauri CLI 从它生成进 `tauri.properties`，改版本号只需改一处。
- Android 工程已生成并入库（`src-tauri/gen/android`，含 gradle wrapper）。
- 本地签名材料：`src-tauri/gen/android/wee-count.jks` 与 `src-tauri/gen/android/app/key.properties`（均在 gitignore 中）；`app/build.gradle.kts` 从 `key.properties` 读 `storeFile/storePassword/keyAlias/keyPassword`，文件不存在时跳过 release 签名配置。
- 仓库目前无任何 tag。

## Workflow 设计（新建 `.github/workflows/release-android.yml`）

### 触发与全局配置

- 触发：`on: push: tags: ['v*']`
- `concurrency: group: release-android, cancel-in-progress: false`，防并发发布
- `permissions: contents: write`（创建 Release 所需）
- 不修改 `deploy-backend.yml`，两个 workflow 互不影响

### 前置守门（fail-fast）

1. **Secrets 完整性校验**：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 任一为空则立即失败并提示缺失项。
2. **版本一致性校验**：tag 名去掉 `v` 前缀必须等于 `tauri.conf.json` 的 `version`，否则失败。防止版本号忘 bump 或 tag 打错。

### 构建（单 job，ubuntu-latest）

按序执行：

1. `npm run test`（vitest）
2. JDK 17（temurin）
3. Android SDK：runner 预装（`ANDROID_HOME` 已就绪），用 sdkmanager 补装 NDK 并导出 `NDK_HOME`（NDK/JDK/Node 具体版本在实现计划中固定为 Tauri 2 当前要求）
4. Rust stable + `rustup target add aarch64-linux-android`，配 `Swatinem/rust-cache`（按 `Cargo.lock` 缓存；首次约 15-20 分钟，之后显著加快）
5. Node + `npm ci`（setup-node 开 npm 缓存）
6. 签名材料还原：
   - `ANDROID_KEYSTORE_BASE64` 解码写入 `src-tauri/gen/android/app/wee-count.jks`
   - 在同目录生成 `key.properties`（`storeFile=wee-count.jks` + 其余三个值），gradle 原生读取，**不修改任何本地构建脚本**；CI 内布局与本地不同但自洽（jks 与 key.properties 同放 `app/` 下，`storeFile` 以 `app/` 目录为基准解析）
7. 构建：`npx tauri android build --apk --target aarch64`（`beforeBuildCommand` 会自动执行 `npm run build`，含 vue-tsc 类型检查）
8. 产物重命名：`gen/android/app/build/outputs/apk/aarch64/release/*.apk` → `WeeCount_v{版本号}_arm64.apk`

### 发布

`softprops/action-gh-release@v2`：

- `tag_name` 取 `github.ref_name`，Release 标题即 tag 名（如 `v0.10.1`）
- `generate_release_notes: true`，自动汇总上一个 tag 以来的 commit
- `files` 挂重命名后的 APK
- 同一 tag 重推时更新已有 Release 并覆盖产物

### 错误处理

- 版本不一致 / 缺 Secrets → 前置步骤失败，不进入构建
- 构建或测试失败 → Release 不会创建（发布是最后一步），不存在「发一半」的状态
- 敏感信息（密码、jks）不打印进日志；runner 一次性，无需事后清理

## 一次性准备（用户手动执行，涉及密钥）

```bash
gh secret set ANDROID_KEYSTORE_BASE64 < <(base64 -w0 src-tauri/gen/android/wee-count.jks)
gh secret set ANDROID_KEYSTORE_PASSWORD   # storePassword
gh secret set ANDROID_KEY_ALIAS
gh secret set ANDROID_KEY_PASSWORD        # keyPassword
```

## 日常发版操作

改 `tauri.conf.json` 版本号 → commit → `git tag v{版本} && git push origin v{版本}`。

## 配套文档

仿照《后端CI-CD自动部署指南.md》新增《Android自动发布指南.md》：Secrets 准备、首次发版演练、常见失败排查（版本不一致、Secrets 缺失、NDK 版本）。

## 测试与验证

- workflow 语法与步骤正确性：实现后先以真实 tag `v0.10.1`（与当前版本号一致）做首次发版演练验证全链路
- 产物验证：下载 Release 中的 APK 在 Android 真机安装，确认签名有效、可覆盖升级现有本地安装（与本地 jks 签名一致）
- 回归确认：不触碰 `deploy-backend.yml`、`app/build.gradle.kts` 及其他无关文件

## 明确不做（YAGNI）

- 不做多架构分包、AAB、桌面平台产物
- 不做 changelog 手工撰写与版本号自动 bump 工具链（release-please 等）
- 不做 APK 上传自有服务器分发
