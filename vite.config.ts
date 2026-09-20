/// <reference types="vitest" />
import { fileURLToPath, URL } from "url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "happy-dom",
    // 全局超时余量。默认 5s 在"机器负载不可控"时不够：一批**重用例**会假红，
    // 最近 4 次全量 `npm run test` 里有 3 次被它们拖红。
    // 触发时的观测值（全量跑 + 机器被并发重负载占满；单独跑远低于此）：
    //   src/__tests__/main.coldStart.e2e.test.ts                5336ms / 5374ms（单独跑 3387ms）
    //   src/services/ai/__tests__/sqlSmoke.test.ts 万级组合用例  5178ms / 5453ms（单独跑 1578ms）
    // 本机 A/B（8C/16T 跑满 100%，15 个并发 `vue-tsc --noEmit` 当背景负载，同一份代码）：
    //   `--testTimeout=5000` 跑全量 3/3 次红：coldStart 两个用例 5138 / 5082 / 5041 / 5318ms，
    //   main.bootstrap 的启动顺序用例 5064 / 5068ms；默认 20s 下同负载 87 文件 899 用例全绿。
    // 超限只有几个百分点、用例一直在正常推进 ⇒ 判断是**余量不足**，不是死循环/挂死。
    // 修的是"CI 机器负载不可控"这一类问题，所以用全局超时，而不是只给某几个用例单独加。
    testTimeout: 20000,
  },
}));
