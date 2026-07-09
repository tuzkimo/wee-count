<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
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
// 视窗 280 → 输出 256，两步降采样意图在此显式
const OUTPUT_SIZE = 256;
const JPEG_QUALITY = 0.85;

const imgEl = ref<HTMLImageElement | null>(null);
let alive = true;
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
      if (!alive) return;
      imgEl.value = image;
      imgSrc.value = url;
      imgW.value = image.naturalWidth;
      imgH.value = image.naturalHeight;
      // 居中
      x.value = (V - displayedW.value) / 2;
      y.value = (V - displayedH.value) / 2;
    };
    image.onerror = () => {
      if (!alive) return;
      emit("error");
    };
    image.src = url;
  } catch {
    if (alive) emit("error");
  }
});

// 缩放以视窗中心为锚点：保持中心对应的源点不变
watch(userScale, (nv, ov) => {
  if (!imgW.value) return;
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
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
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
  ctx.drawImage(imgEl.value, sx, sy, sSize, sSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  emit("confirm", canvas.toDataURL("image/jpeg", JPEG_QUALITY));
}

onUnmounted(() => { alive = false; });
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
              maxWidth: 'none',
              maxHeight: 'none',
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
            aria-label="缩放"
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
