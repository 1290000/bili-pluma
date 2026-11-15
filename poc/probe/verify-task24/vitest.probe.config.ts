import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** verifier 专用：只跑 poc/probe/verify-task24 下的场景模拟，不碰产品测试集合 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@shared', replacement: at('./src/shared') },
      { find: '@core', replacement: at('./src/core') },
      { find: '@platform', replacement: at('./src/platform') },
      { find: /^@\/(.*)$/, replacement: at('./$1') },
    ],
  },
  test: {
    include: ['poc/probe/verify-task24/**/*.test.ts'],
    environment: 'node',
    globals: false,
    fileParallelism: false,
  },
});
