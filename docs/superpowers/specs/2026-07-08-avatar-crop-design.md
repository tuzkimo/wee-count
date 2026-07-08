# 头像裁剪与上传体验优化 设计

## 背景

头像上传已统一为 data URL 存 `avatar_url`（本地/在线同路，在线经 `auth.updateProfile` 同步）。当前问题：

1. 仅做 1MB 大小限制，用户选大图即被拒，体验差。
2. 头像非正方形时按 emoji 方式整串渲染，变形。
3. 上传按钮样式为方框按钮，不美观。

## 目标

- 用户可选任意图片，在固定正方形视窗内平移 + 缩放裁出头像。
- 自动压缩到应用所需像素（256×256），输出 data URL 存库，体积可控。
- 优化头像上传入口样式为「圆形预览 + 相机徽标」。

## 非目标

- 旋转、多比例、撤销重做。
- pinch 双指缩放（滑块已够，后续可加）。
- 图片本地持久化缓存。

## 架构

新增 `src/components/AvatarCropper.vue`（弹层组件）。`ProfilePage` 选完文件后打开它，裁剪确认后产出 data URL 回传。纯 canvas 实现，不加依赖。

```
ProfilePage 选文件
  → 打开 AvatarCropper（props: file）
  → 用户拖动平移 + 滑块缩放（1–3×）
  → 确认 → canvas 采样 256×256 → toDataURL('image/jpeg', 0.85)
  → emit('confirm', dataUrl)
  → ProfilePage 调 auth.updateProfile({ avatar_url: dataUrl })
```

## 组件：AvatarCropper

**Props:** `file: File`
**Emits:** `confirm(dataUrl: string)`, `cancel()`

### 几何与交互

- 视窗固定正方形（CSS `overflow-hidden`，约 280px，记为 `V`）。
- 图片 `cover` 适配：`baseScale = max(V / imgW, V / imgH)`。
- 用户缩放因子 `userScale ∈ [1, 3]`，总缩放 `total = baseScale × userScale`。
- 拖动改 `x / y`（图片左上角在视窗坐标系内的位置），约束：
  - `x ∈ [V - imgW × total, 0]`
  - `y ∈ [V - imgH × total, 0]`
  - 保证图片始终覆盖视窗、不露边。
- 缩放滑块改变 `userScale`，缩放后仍以视窗中心为锚点保持覆盖（重新 clamp x/y）。

### 输出采样

源采样边长 `sSize = V / total`，源起点：

```
sx = -x / total
sy = -y / total
```

输出 canvas 256×256：

```
ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, 256, 256)
dataUrl = canvas.toDataURL('image/jpeg', 0.85)
```

JPEG 质量 0.85：头像无透明需求，输出约 10–30KB，进 DB 无压力（配合 006 迁移 `avatar_url TEXT`）。

### 边界情况

- 图片 `naturalWidth/Height < 256`：直接 `cover` 放大采样，不报错。
- 图片 decode 失败：emit `cancel` 并由 ProfilePage 提示「图片无法读取」。

## 纯函数：computeCrop

抽离裁剪数学为纯函数，供组件与测试共用：

```typescript
// src/utils/crop.ts
export interface CropInput {
  imgW: number;      // natural width
  imgH: number;
  viewport: number;  // V
  userScale: number; // [1,3]
  x: number;         // 图片左上角在视窗坐标系
  y: number;
}
export interface CropOutput {
  sx: number; sy: number; sSize: number;
}
export function computeCrop(input: CropInput): CropOutput
```

组件调用它得到采样参数，避免几何逻辑埋在模板/事件里。

## ProfilePage 改动

- 选文件后不再立即转 data URL，改为打开 `AvatarCropper`。
- `onConfirm(dataUrl)` → `selectedEmoji.value = dataUrl; auth.updateProfile({ avatar_url: dataUrl })`。
- `onCancel()` → 不改动头像。
- 保留 emoji 选择分支（与裁剪互补）。

### 上传入口样式

替换原方框按钮为：

- 圆形头像预览（显示当前 `selectedEmoji`，data URL 渲染为 `<img>`，emoji 渲染为文字，无则占位首字母）。
- 右下角相机徽标（lucide `Camera`）。
- 点整圆触发选图；下方保留「或选择 emoji」提示与 emoji 网格。

## 错误处理

- 选图后 decode 失败：ProfilePage 提示「图片无法读取」，不打开裁剪。
- 裁剪组件内缩放/拖动均为本地状态，无网络/DB 错误路径。

## 测试

- `computeCrop`：最小单测锁定裁剪数学（正方形图、宽图、高图、缩放后中心锚点），是逻辑核心。
- `AvatarCropper`：纯 DOM/指针交互，单测价值低，YAGNI。
- 不新增后端测试（无后端改动）。

## 验证

```bash
npx vitest run src/utils/__tests__/crop.test.ts
npx vue-tsc --noEmit
npm run build
```

手动：选大图 → 裁剪缩放 → 确认 → 头像更新为正方形压缩图；在线模式 sync 后其他设备可见。
