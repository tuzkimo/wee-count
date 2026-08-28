# Android 自动发布指南

前置规格：`docs/superpowers/specs/2026-08-28-android-release-ci-design.md`
Workflow：`.github/workflows/release-android.yml`（推 `v*` tag 触发）

## 一次性准备（仅需做一次）

签名材料通过 GitHub Secrets 提供，在仓库根目录执行以下命令（需 gh CLI 已登录）。

keystore 转 base64（二选一，按所用 shell）：

```powershell
# PowerShell（不落临时文件，直接管道）
[Convert]::ToBase64String([IO.File]::ReadAllBytes("src-tauri\gen\android\wee-count.jks")) | gh secret set ANDROID_KEYSTORE_BASE64
```

```bash
# Git Bash / macOS / Linux（临时文件用完即删，不留档）
base64 -w0 src-tauri/gen/android/wee-count.jks > keystore.tmp.b64
gh secret set ANDROID_KEYSTORE_BASE64 < keystore.tmp.b64
rm keystore.tmp.b64
```

> PowerShell 里 `<` 是保留字不可用，`>` 重定向会改写编码，不要用重定向方式处理这一步。

其余三条（密码与 alias，与 shell 无关）：

```bash
gh secret set ANDROID_KEYSTORE_PASSWORD   # storePassword，与 app/key.properties 中一致
gh secret set ANDROID_KEY_ALIAS           # keyAlias
gh secret set ANDROID_KEY_PASSWORD        # keyPassword

# 确认
gh secret list
```

> **给值方式**：`gh secret set` 只接受 Secret 名一个位置参数，值不能直接跟在名字后面，
> 否则报 `accepts at most 1 arg(s), received 2`（gh 2.93.0 实测）。三种给值方式：
> ① 裸命令回车，在 `? Paste your secret:` 提示符粘贴值（推荐，不进 shell 历史）；
> ② `--body "值"`（明文会被 PowerShell/PSReadLine 历史记录存盘，不推荐）；
> ③ 管道 `"值" | gh secret set 名字`。
> 另：参数值里的 `/` 等符号在 PowerShell 中不分割参数，与该报错无关。

预期 `gh secret list` 出现 4 个 `ANDROID_KEY*` Secret。

注意：
- 密码值以 `src-tauri/gen/android/app/key.properties`（本地文件，不入库）为准。
- keystore 一旦泄露无法换发（Android 证书不可重签），不要把 base64 文件提交或外传。

## 日常发版流程

```bash
# 1. bump 版本号：只改 src-tauri/tauri.conf.json 的 "version"（package.json 版本如需同步一并改）
# 2. commit
git commit -am "chore: 版本号 x.y.z → x.y.(z+1)"

# 3. 打 tag 并推送
git tag vx.y.z
git push origin vx.y.z
```

推送后 CI 自动执行：Secrets 校验 → 版本一致性校验（tag 必须 == tauri.conf.json 版本）→
npm test → arm64 release 构建 → 发布 GitHub Release。

观察进度：

```bash
gh run watch   # 或到仓库 Actions 页看 release-android run
```

完成后 Release 页出现 `vx.y.z`，产物 `WeeCount_vx.y.z_arm64.apk`，release notes 自动汇总上个 tag 以来的 commit。

## 首次演练检查单

1. 确认 4 个 Secrets 已设置（`gh secret list`）。
2. 打 tag `v0.10.1`（与当前 tauri.conf.json 版本一致）并推送。
3. `gh run watch` 等待完成，首次构建约 15-25 分钟（Rust 全量编译），后续有缓存更快。
4. Release 页确认产物存在、文件名正确。
5. 下载 APK 到 Android 真机安装；若设备已装本地构建的 0.10.1，验证可直接覆盖升级（证明 CI 签名与本地 jks 签名同源）。

## 常见失败排查

| 现象 | 原因与处理 |
| --- | --- |
| run 秒失败，报「缺少 Secret: …」 | 对应 Secret 未设置，回「一次性准备」补齐 |
| run 秒失败，报「tag … 与 tauri.conf.json 版本 … 不一致」 | 先 bump 版本号再打 tag，或删掉错误 tag 重打正确的 |
| 构建 APK 步骤报签名错误 | 检查 4 个 Secret 的值与本地 `key.properties` 是否完全一致（注意不要带换行/空格） |
| NDK 报版本不存在 | `env.NDK_VERSION` 写错，到 https://github.com/android/ndk/releases 核对后修正 workflow |
| gradle 下载缓慢 | wrapper 走腾讯镜像（见 `gradle-wrapper.properties`），海外 runner 偶发慢；必要时把 `distributionUrl` 换成 `https://services.gradle.org/...` |
| 找不到 release APK 产物 | 看「构建 arm64 release APK」步骤日志确认构建类型；确认命令带了 `--apk --target aarch64` |

## 已知限制

- 仓库为私有，Release 页下载需有协作者权限的 GitHub 账号登录。
- 仅出 arm64-v8a 单包；需要其他架构时在 workflow 构建命令的 `--target` 里追加（如 `aarch64,armv7`）并扩展产物收集步骤。
- 重复推送同一 tag 会更新已有 Release 并覆盖同名产物。
