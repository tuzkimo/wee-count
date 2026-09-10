// src/services/backup/__tests__/webcrypto.ts
import { webcrypto } from "node:crypto";
import { vi } from "vitest";

/** 用 Node webcrypto 替换全局 crypto（happy-dom 无 subtle），afterEach 需 vi.unstubAllGlobals() */
export function stubWebCrypto(): void {
  vi.stubGlobal("crypto", webcrypto);
}
