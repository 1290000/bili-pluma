/**
 * task-29 探针专用 vitest config。
 *
 * 三处坑（task-27 踩过）：
 * 1. `root` 必须指向**本目录**，否则相对 `include` 会解析到仓根
 * 2. `URL(p, import.meta.url)` 的基是**文件**不是目录 → `../../../` 是三层
 * 3. `cache: false` 必须开，否则 RV 变异后可能读到旧模块
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./.vite-cache', import.meta.url)),
  resolve: {
    alias: [
      { find: /^@design\/(.*)$/, replacement: at('../../../src/design/$1') },
      { find: /^@shared\/(.*)$/, replacement: at('../../../src/shared/$1') },
      { find: /^@core\/(.*)$/, replacement: at('../../../src/core/$1') },
      { find: /^@platform\/(.*)$/, replacement: at('../../../src/platform/$1') },
      { find: /^@content\/(.*)$/, replacement: at('../../../src/content/$1') },
      { find: /^@background\/(.*)$/, replacement: at('../../../src/background/$1') },
      { find: /^@\/(.*)$/, replacement: at('../../../src/$1') },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['*.test.ts'],
    cache: false,
  },
});
