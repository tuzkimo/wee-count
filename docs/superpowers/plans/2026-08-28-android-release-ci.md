# Android APK 自动发布 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 推送 `v*` tag 时 GitHub Actions 自动编译 arm64 签名 release APK 并发布到 GitHub Release。

**架构：** 新增一个独立 workflow `release-android.yml`（与现有 `deploy-backend.yml` 并存、互不影响），前置 fail-fast 校验（Secrets 完整性、tag 与 `tauri.conf.json` 版本一致性），单 job 顺序执行测试 → 构建 → 发布，发布为最后一步，失败即无 Release。规格见 `docs/superpowers/specs/2026-08-28-android-release-ci-design.md`。

**技术栈：** GitHub Actions（ubuntu-latest）、Tauri 2 CLI（`@tauri-apps/cli` ^2，本地 `npm ci` 后经 npx 调用）、Temurin JDK 17、Android SDK（runner 预装）+ NDK 27.2.12479018、Rust stable（target `aarch64-linux-android`）、`softprops/action-gh-release@v2`。

**已核实的仓库事实（实现者无需再查）：**

- 版本号唯一来源：`src-tauri/tauri.conf.json` 的 `version`（当前 `0.10.1`）；`versionCode`/`versionName` 由 Tauri CLI 生成进 `gen/android/app/tauri.properties`。
- `gen/android/app/tauri.properties`、`tauri.build.gradle.kts`、`proguard-tauri.pro` 是 Tauri CLI 每次构建自动重建的生成文件（见 `gen/android/app/.gitignore`），CI checkout 后无需手工生成。
- 签名读取链：`gen/android/app/build.gradle.kts` 读同目录 `key.properties`（键：`storeFile/storePassword/keyAlias/keyPassword`），`storeFile` 相对 `app/` 目录解析；文件不存在时静默跳过 release 签名配置（这就是要做 Secrets 前置校验的原因）。
- 本地 keystore：`src-tauri/gen/android/wee-count.jks`（gitignored，不读内容——密码不进任何日志）。
- `package.json`：`test` = `vitest run`（CI 安全）、`tauri` = `tauri`、`build` = `vue-tsc --noEmit && vite build`（由 `beforeBuildCommand` 在 tauri build 中自动执行）。
- gradle wrapper 8.14.3，`distributionUrl` 指向腾讯镜像（海外 runner 可达）。
- 仓库无任何 tag；远端 `git@github.com:tuzkimo/wee-count.git`，私有。

**测试策略说明：** 本功能是 CI 配置，仓库无 workflow 单元测试框架。验证分两级：本地 YAML 语法校验（任务 1），真实 tag 演练（任务 3，端到端集成验证）。AGENTS.md 的「功能需附单元测试」约束针对可测代码，CI YAML 以语法校验 + 演练替代，此决策已在规格中确认。

**红线检查点（执行时必须停下来问用户）：** 任务 3 中的 `git push`（推 tag）与首次公开发布（创建 Release）；4 条 `gh secret set` 命令必须由用户本人执行。

---

### 任务 1：创建 release-android workflow

**文件：**
- 创建：`.github/workflows/release-android.yml`

- [ ] **步骤 1：创建 workflow 文件**

写入 `.github/workflows/release-android.yml`，完整内容：

```yaml
name: release-android

on:
  push:
    tags: ['v*']

concurrency:
  group: release-android
  cancel-in-progress: false

permissions:
  contents: write

jobs:
  build-release:
    runs-on: ubuntu-latest
    env:
      NDK_VERSION: 27.2.12479018
    steps:
      - uses: actions/checkout@v4

      - name: 校验签名 Secrets 完整性
        env:
          ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: |
          missing=0
          for v in ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
            if [ -z "${!v}" ]; then
              echo "::error::缺少 Secret: ${v}，请到仓库 Settings > Secrets and variables > Actions 添加"
              missing=1
            fi
          done
          exit $missing

      - name: 校验 tag 与 tauri.conf.json 版本一致
        run: |
          TAURI_VERSION=$(jq -r .version src-tauri/tauri.conf.json)
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          if [ "$TAURI_VERSION" != "$TAG_VERSION" ]; then
            echo "::error::tag ${GITHUB_REF_NAME} 与 tauri.conf.json 版本 ${TAURI_VERSION} 不一致，请先 bump 版本号或改用正确 tag"
            exit 1
          fi

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17

      - name: 安装 Android NDK
        run: |
          sdkmanager --install "ndk;${NDK_VERSION}" > /dev/null
          echo "NDK_HOME=${ANDROID_HOME}/ndk/${NDK_VERSION}" >> "$GITHUB_ENV"

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-linux-android

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: 安装前端依赖
        run: npm ci

      - name: 前端单元测试
        run: npm run test

      - name: 还原签名材料
        env:
          ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: |
          echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > src-tauri/gen/android/app/wee-count.jks
          cat > src-tauri/gen/android/app/key.properties <<EOF
          storeFile=wee-count.jks
          storePassword=${ANDROID_KEYSTORE_PASSWORD}
          keyAlias=${ANDROID_KEY_ALIAS}
          keyPassword=${ANDROID_KEY_PASSWORD}
          EOF

      - name: 构建 arm64 release APK
        run: npx tauri android build --apk --target aarch64

      - name: 收集产物
        run: |
          mkdir -p release-apk
          APK=$(find src-tauri/gen/android/app/build/outputs/apk -name '*release*.apk' | head -n 1)
          if [ -z "$APK" ]; then
            echo "::error::未找到 release APK 产物"
            exit 1
          fi
          cp "$APK" "release-apk/WeeCount_${GITHUB_REF_NAME}_arm64.apk"

      - name: 发布 GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: release-apk/*.apk
          generate_release_notes: true
```

设计意图（实现者需理解，不要「优化」掉）：
- 签名材料还原到 `gen/android/app/` 下（`wee-count.jks` + `key.properties` 同目录，`storeFile=wee-count.jks`），与本地布局不同但自洽，**不修改任何本地构建脚本**。
- heredoc 内容与 `EOF` 在 YAML 块标量中共享同一缩进，YAML 剥离公共缩进后 `EOF` 顶格、变量展开生效，这是故意的写法。
- 产物定位用 `find ... '*release*.apk'` 而非硬编码路径，对 Tauri 版本变化更稳健；文件名带 tag 名（如 `WeeCount_v0.10.1_arm64.apk`）。
- Release 生成是最后一步，之前任何失败都不会产生 Release。

- [ ] **步骤 2：YAML 语法校验**

运行（npx 临时安装 yaml-lint，不落全局依赖）：

```bash
npx --yes yaml-lint .github/workflows/release-android.yml
```

预期：`1 file lint free`（或等价通过信息）。报错则修缩进后重跑。

- [ ] **步骤 3：对照检查无其他文件改动**

运行：`git status --short`
预期：仅新增 `.github/workflows/release-android.yml`。若出现其他文件，检查是否误改，还原它们。

- [ ] **步骤 4：Commit**

```bash
git add .github/workflows/release-android.yml
git commit -m "chore(ci): 新增 Android APK tag 触发自动构建发布 workflow"
```

### 任务 2：编写 Android 自动发布指南

**文件：**
- 创建：`docs/Android自动发布指南.md`

- [ ] **步骤 1：编写指南**

写入 `docs/Android自动发布指南.md`，完整内容：

```markdown
# Android 自动发布指南

前置规格：`docs/superpowers/specs/2026-08-28-android-release-ci-design.md`
Workflow：`.github/workflows/release-android.yml`（推 `v*` tag 触发）

## 一次性准备（仅需做一次）

签名材料通过 GitHub Secrets 提供，在仓库根目录执行以下命令（需 gh CLI 已登录）：

```bash
# 1. keystore 转 base64 后存入 Secrets（临时文件用完即删，不留档）
base64 -w0 src-tauri/gen/android/wee-count.jks > keystore.tmp.b64
gh secret set ANDROID_KEYSTORE_BASE64 < keystore.tmp.b64
rm keystore.tmp.b64

# 2. 密码与 alias（执行后按提示粘贴对应值，回车结束）
gh secret set ANDROID_KEYSTORE_PASSWORD   # storePassword，与 app/key.properties 中一致
gh secret set ANDROID_KEY_ALIAS           # keyAlias
gh secret set ANDROID_KEY_PASSWORD        # keyPassword

# 3. 确认
gh secret list
```

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
5. 下载 APK 到 Android 真机安装；若设备已装本地构建的 0.10.1，验证可直接覆盖升级（证明 CI 签名与本地 jks 同源）。

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
```

- [ ] **步骤 2：Commit**

```bash
git add docs/Android自动发布指南.md
git commit -m "docs: 新增 Android 自动发布指南"
```

### 任务 3：首次发版演练（端到端验证）

**文件：** 无代码改动。本任务验证任务 1/2 的交付物。

- [ ] **步骤 1：请用户设置 Secrets（⚠️ 用户本人执行）**

请用户按指南「一次性准备」执行 4 条 `gh secret set`。执行者不得索要或记录密码明文。

验证：`gh secret list` 输出包含 4 个 `ANDROID_KEY*`。

- [ ] **步骤 2：确认待发 commit 已包含 workflow**

运行：`git log --oneline -3` 与 `git ls-files .github/workflows/release-android.yml`
预期：workflow 已在 master 上（tag 将打在包含它的 commit 上，否则不触发）。

- [ ] **步骤 3：打 tag（⚠️ git push 属红线，需用户确认后执行）**

```bash
git tag v0.10.1
git push origin v0.10.1
```

- [ ] **步骤 4：观察 CI**

```bash
gh run watch
```

预期：release-android 全部步骤绿；「校验 tag 与版本一致」通过；「前端单元测试」通过；总时长 15-25 分钟。失败则按指南排查表定位，修复后删 tag 重打（删除远端 tag 需用户确认）。

- [ ] **步骤 5：验证 Release**

```bash
gh release view v0.10.1 --json name,tagName,assets --jq '{name, tagName, assets: [.assets[].name]}'
```

预期：`assets` 包含 `WeeCount_v0.10.1_arm64.apk`，release notes 非空。

- [ ] **步骤 6：真机验证（用户执行）**

用户从 Release 页下载 APK，在 Android 真机安装；若设备已装本地构建版本，验证可覆盖升级且数据保留。验证通过后本计划完成。

- [ ] **步骤 7：收尾确认**

```bash
git status --short
```

预期：干净。规格中「不触碰 deploy-backend.yml、app/build.gradle.kts 及其他无关文件」成立（`git diff cd0687f..HEAD --stat` 仅新增 workflow 与指南两个文件加规格/计划文档）。

---

## 自检记录

- **规格覆盖度：** 触发与全局配置/前置守门/构建流程/发布/错误处理 → 任务 1；一次性准备 + 配套文档 → 任务 2、3；测试与验证 → 任务 1 步骤 2、任务 3 全部；回归确认 → 任务 3 步骤 7。无遗漏。
- **占位符扫描：** 无「待定/TODO/类似任务 N」；所有步骤含实际内容或命令。
- **类型/命名一致性：** Secret 名 4 处（校验步骤、还原步骤、指南、排查表）均为 `ANDROID_KEYSTORE_BASE64/ANDROID_KEYSTORE_PASSWORD/ANDROID_KEY_ALIAS/ANDROID_KEY_PASSWORD`；产物名 `WeeCount_{GITHUB_REF_NAME}_arm64.apk` 与指南、验证命令一致；NDK_VERSION 仅在 job env 定义、两步引用。
