# 头像裁剪与上传体验优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给头像上传加上固定正方形视窗的平移+缩放裁剪、自动压缩到 256×256 JPEG data URL，并把上传入口样式改为圆形预览+相机徽标。

**Architecture:** 抽离裁剪数学为纯函数 `computeCrop`（可单测）；新增弹层组件 `AvatarCropper.vue` 用 canvas 采样输出 data URL；`ProfilePage` 选完文件打开裁剪器，确认后调 `auth.updateProfile`。纯前端，无新依赖，不加后端改动。

**Tech Stack:** Vue 3 + TypeScript + Tailwind + canvas API + vitest

---

## File Structure

- Create: `src/utils/crop.ts` — 纯函数 `computeCrop`，算源采样参数
- Create: `src/utils/__tests__/crop.test.ts` — `computeCrop` 单测
- Create: `src/components/AvatarCropper.vue` — 裁剪弹层（canvas 输出 data URL）
- Modify: `src/views/ProfilePage.vue` — 选文件→开裁剪器；上传入口改为圆形预览+相机徽标；移除 1MB 限制与 `fileToDataUrl`

---

## Task 1: computeCrop 纯函数 + 单测

**Files:**
- Create: `src/utils/crop.ts`
- Create: `src/utils/__tests__/crop.test.ts`

- [ ] **Step 1: 写失败测试**

`src/utils/__tests__/crop.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeCrop } from "@/utils/crop";

describe("computeCrop", () => {
  const V = 200;

  it("正方形图 userScale=1 居中：采样整张图", () => {
    // 400×400 图，baseScale=0.5，居中 x=y=0
    const out = computeCrop({ imgW: 400, imgH: 400, viewport: V, userScale: 1, x: 0, y: 0 });
    expect(out.sx).toBe(0);
    expect(out.sy).toBe(0);
    expect(out.sSize).toBe(400);
  });

  it("宽图居中：取中部正方形", () => {
    // 800×200，baseScale=1，居中 x=-300, y=0
    const out = computeCrop({ imgW: 800, imgH: 200, viewport: V, userScale: 1, x: -300, y: 0 });
    expect(out.sx).toBe(300);
    expect(out.sy).toBe(0);
    expect(out.sSize).toBe(200);
  });

  it("高图居中：取中部正方形", () => {
    // 200×800，baseScale=1，居中 x=0, y=-300
    const out = computeCrop({ imgW: 200, imgH: 800, viewport: V, userScale: 1, x: 0, y: -300 });
    expect(out.sx).toBe(0);
    expect(out.sy).toBe(300);
    expect(out.sSize).toBe(200);
  });

  it("userScale=2 放大：采样更小的中心区域", () => {
    // 400×400，baseScale=0.5，total=1，居中 x=-100, y=-100
    const out = computeCrop({ imgW: 400, imgH: 400, viewport: V, userScale: 2, x: -100, y: -100 });
    expect(out.sx).toBe(100);
    expect(out.sy).toBe(100);
    expect(out.sSize).toBe(200);
  });

  it("偏移视窗左上角：sx/sy 反映图片右下区域", () => {
    // 800×200，baseScale=1，x=-600（图片左上贴视窗左上，显示最左），y=0
    const out = computeCrop({ imgW: 800, imgH: 200, viewport: V, userScale: 1, x: -600, y: 0 });
    expect(out.sx).toBe(600);
    expect(out.sy).toBe(0);
    expect(out.sSize).toBe(200);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/__tests__/crop.test.ts`
Expected: FAIL — `computeCrop` 未定义（模块不存在）

- [ ] **Step 3: 实现 computeCrop**

`src/utils/crop.ts`:

```typescript
export interface CropInput {
  imgW: number; // 图片 natural width
  imgH: number; // 图片 natural height
  viewport: number; // 视窗边长 V
  userScale: number; // 用户缩放因子 [1,3]
  x: number; // 图片左上角在视窗坐标系中的位置
  y: number;
}

export interface CropOutput {
  sx: number; // 源采样起点 x
  sy: number; // 源采样起点 y
  sSize: number; // 源采样边长
}

/**
 * 由视窗几何反推源图采样参数。
 * total = baseScale * userScale；baseScale = max(V/imgW, V/imgH) 保证 cover。
 * 视窗点 (0,0) 对应图片显示点 (-x,-y)，对应源点 (-x/total, -y/total)。
 * 视窗边长 V 在源空间即 V/total。
 */
export function computeCrop(input: CropInput): CropOutput {
  const baseScale = Math.max(input.viewport / input.imgW, input.viewport / input.imgH);
  const total = baseScale * input.userScale;
  return {
    sx: -input.x / total,
    sy: -input.y / total,
    sSize: input.viewport / total,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/utils/__tests__/crop.test.ts`
Expected: PASS（5 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add src/utils/crop.ts src/utils/__tests__/crop.test.ts
git commit -m "feat: computeCrop pure util for avatar sampling"
```

---

## Task 2: AvatarCropper 组件

**Files:**
- Create: `src/components/AvatarCropper.vue`

- [ ] **Step 1: 实现组件**

`src/components/AvatarCropper.vue`:

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { computeCrop } from "@/utils/crop";

const props = defineProps<{
  file: File;
}>();

const emit = defineEmits<{
  confirm: [dataUrl: string];
  cancel: [];
  error: [];
}>();

// 视窗固定正方形边长
const V = 280;

const imgEl = ref<HTMLImageElement | null>(null);
const imgSrc = ref("");
const imgW = ref(0);
const imgH = ref(0);
const userScale = ref(1);
const x = ref(0);
const y = ref(0);

const baseScale = computed(() =>
  imgW.value && imgH.value ? Math.max(V / imgW.value, V / imgH.value) : 1
);
const total = computed(() => baseScale.value * userScale.value);
const displayedW = computed(() => imgW.value * total.value);
const displayedH = computed(() => imgH.value * total.value);

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

onMounted(async () => {
  try {
    const url = await fileToDataUrl(props.file);
    const image = new Image();
    image.onload = () => {
      imgEl.value = image;
      imgSrc.value = url;
      imgW.value = image.naturalWidth;
      imgH.value = image.naturalHeight;
      // 居中
      x.value = (V - displayedW.value) / 2;
      y.value = (V - displayedH.value) / 2;
    };
    image.onerror = () => emit("error");
    image.src = url;
  } catch {
    emit("error");
  }
});

// 缩放以视窗中心为锚点：保持中心对应的源点不变
watch(userScale, (nv, ov) => {
  if (!imgEl.value || ov == null || !(baseScale.value * ov > 0)) return;
  const totalOld = baseScale.value * ov;
  const totalNew = baseScale.value * nv;
  const cxS = (V / 2 - x.value) / totalOld;
  const cyS = (V / 2 - y.value) / totalOld;
  x.value = clamp(V / 2 - cxS * totalNew, V - displayedW.value, 0);
  y.value = clamp(V / 2 - cyS * totalNew, V - displayedH.value, 0);
});

// 拖动平移
let dragging = false;
let startX = 0;
let startY = 0;
let startImgX = 0;
let startImgY = 0;

function onPointerDown(e: PointerEvent) {
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  startImgX = x.value;
  startImgY = y.value;
  (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!dragging) return;
  x.value = clamp(startImgX + (e.clientX - startX), V - displayedW.value, 0);
  y.value = clamp(startImgY + (e.clientY - startY), V - displayedH.value, 0);
}

function onPointerUp() {
  dragging = false;
}

function onConfirm() {
  if (!imgEl.value) return;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { sx, sy, sSize } = computeCrop({
    imgW: imgW.value,
    imgH: imgH.value,
    viewport: V,
    userScale: userScale.value,
    x: x.value,
    y: y.value,
  });
  ctx.drawImage(imgEl.value, sx, sy, sSize, sSize, 0, 0, 256, 256);
  emit("confirm", canvas.toDataURL("image/jpeg", 0.85));
}
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      @click.self="emit('cancel')"
    >
      <div class="w-full max-w-sm rounded-2xl bg-surface p-4 shadow-xl">
        <h3 class="mb-3 text-center text-base font-semibold text-text">裁剪头像</h3>
        <div
          class="relative mx-auto touch-none select-none overflow-hidden rounded-xl bg-gray-100"
          :style="{ width: V + 'px', height: V + 'px' }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <img
            v-if="imgSrc"
            :src="imgSrc"
            :style="{
              width: displayedW + 'px',
              height: displayedH + 'px',
              transform: `translate(${x}px, ${y}px)`,
              position: 'absolute',
              left: 0,
              top: 0,
            }"
            draggable="false"
            class="pointer-events-none"
            alt="裁剪预览"
          />
        </div>
        <div class="mt-4 flex items-center gap-3">
          <span class="text-xs text-text-secondary">缩放</span>
          <input
            v-model.number="userScale"
            type="range"
            min="1"
            max="3"
            step="0.01"
            class="flex-1"
          />
          <span class="w-10 text-right text-xs text-text-secondary">{{ Math.round(userScale * 100) }}%</span>
        </div>
        <div class="mt-5 flex gap-3">
          <button
            class="flex-1 rounded-xl bg-gray-100 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-200"
            @click="emit('cancel')"
          >
            取消
          </button>
          <button
            class="flex-1 rounded-xl bg-primary py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-dark"
            @click="onConfirm"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 2: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "AvatarCropper.vue"`
Expected: 无错

- [ ] **Step 3: Commit**

```bash
git add src/components/AvatarCropper.vue
git commit -m "feat: AvatarCropper — fixed-square viewport, pan/zoom, canvas output"
```

---

## Task 3: ProfilePage 集成 + 上传入口样式

**Files:**
- Modify: `src/views/ProfilePage.vue`

- [ ] **Step 1: 改 script — 引入裁剪器，替换 onFileChange/fileToDataUrl**

把 `src/views/ProfilePage.vue` 的 `<script setup lang="ts">` 整块替换为：

```typescript
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { Camera } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import AvatarCropper from "@/components/AvatarCropper.vue";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

const currentAvatar = computed(() =>
  auth.onlineUser?.avatar_url || auth.currentLocalUser?.avatar_url || ""
);

const nickname = ref(auth.currentLocalUser?.nickname || "");
const selectedEmoji = ref(currentAvatar.value);

const fileInput = ref<HTMLInputElement | null>(null);
const cropperFile = ref<File | null>(null);
const uploading = ref(false);

function triggerUpload() {
  fileInput.value?.click();
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  cropperFile.value = file;
}

async function onCropperConfirm(dataUrl: string) {
  cropperFile.value = null;
  uploading.value = true;
  try {
    selectedEmoji.value = dataUrl;
    await auth.updateProfile({ avatar_url: dataUrl });
  } catch (err) {
    console.error("Update avatar failed:", err);
  } finally {
    uploading.value = false;
  }
}

function onCropperCancel() {
  cropperFile.value = null;
}

function onCropperError() {
  cropperFile.value = null;
  alert("图片无法读取，请换一张");
}

// emoji 头像选项
const avatarOptions = ["😀", "🐱", "🐶", "🦊", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦄", "🐌", "🐛", "🦋"];

const saving = ref(false);
const saved = ref(false);

async function handleSave(): Promise<void> {
  saving.value = true;
  saved.value = false;
  try {
    await auth.updateProfile({
      nickname: nickname.value.trim() || undefined,
      avatar_url: selectedEmoji.value || null,
    });
    router.back();
  } catch (e) {
    console.error("Save profile failed:", e);
  } finally {
    saving.value = false;
  }
}

const hasChanges = computed(() =>
  nickname.value.trim() !== (auth.currentLocalUser?.nickname || "") ||
  selectedEmoji.value !== currentAvatar.value
);
```

- [ ] **Step 2: 改 template — 圆形预览+相机徽标，挂载裁剪器**

把 template 中 `<!-- 头像 -->` 那段（从 `<label class="mb-2 block text-sm font-medium text-text">头像</label>` 到 emoji 网格 `</div>` 之前的整个「头像+上传按钮+input+提示」块，即原 92–110 行）替换为：

```html
      <!-- 头像 -->
      <label class="mb-2 block text-sm font-medium text-text">头像</label>
      <div class="mb-3 flex flex-col items-center">
        <button
          type="button"
          :disabled="uploading"
          class="group relative h-24 w-24 overflow-hidden rounded-full bg-gray-100 ring-2 ring-gray-200 transition hover:ring-primary disabled:opacity-50"
          @click="triggerUpload"
        >
          <img
            v-if="selectedEmoji.startsWith('data:')"
            :src="selectedEmoji"
            class="h-full w-full object-cover"
            alt="头像"
          />
          <span
            v-else-if="selectedEmoji"
            class="flex h-full w-full items-center justify-center text-4xl"
          >{{ selectedEmoji }}</span>
          <span
            v-else
            class="flex h-full w-full items-center justify-center text-3xl text-text-secondary"
          >{{ (nickname || "我").charAt(0) }}</span>
          <span
            class="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white shadow"
          >
            <Camera :size="16" />
          </span>
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          class="hidden"
          @change="onFileChange"
        />
        <p class="mt-2 text-xs text-text-secondary">点击更换头像，或选择下方 emoji</p>
      </div>
```

在「保存按钮」`</button>` 之后、最外层 `</div>` 之前，挂载裁剪器：

```html
      <AvatarCropper
        v-if="cropperFile"
        :file="cropperFile"
        @confirm="onCropperConfirm"
        @cancel="onCropperCancel"
        @error="onCropperError"
      />
```

emoji 网格块（`<div class="mb-6 flex flex-wrap gap-2">…</div>`）保持不变。

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "ProfilePage.vue"`
Expected: 无错

- [ ] **Step 4: 跑全量测试确认无回归**

Run: `npx vitest run`
Expected: 全绿（含 Task 1 的 crop.test.ts）

- [ ] **Step 5: 构建**

Run: `npm run build`
Expected: vue-tsc 通过 + Vite 构建成功

- [ ] **Step 6: 手动验证**

`npm run dev` → 个人信息页 → 点圆形头像选大图 → 裁剪器弹出 → 拖动平移、滑块缩放 → 确认 → 头像变正方形压缩图 → emoji 仍可选切换 → 保存。本地模式头像即时更新；在线模式保存后经 sync 同步。

- [ ] **Step 7: Commit**

```bash
git add src/views/ProfilePage.vue
git commit -m "feat: ProfilePage — cropper integration + circular avatar upload UI"
```

---

## 最终验证

```bash
npx vitest run        # 前端单测全绿
npm run build         # vue-tsc + Vite
```

确认清单：
1. `computeCrop` 单测覆盖正方形/宽/高图、缩放、偏移五种几何
2. 裁剪器：拖动平移不露边、滑块缩放以中心为锚、确认输出 256×256 JPEG data URL
3. 上传入口为圆形预览+相机徽标，点击触发选图
4. 图片 decode 失败提示「图片无法读取」
5. emoji 选择仍可用，与裁剪互补
6. 本地/在线模式头像更新均生效
