import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': at('./src/shared'),
      '@core': at('./src/core'),
      '@platform': at('./src/platform'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // 某些 Windows / 受限环境下，并行 worker 写临时文件会 EPERM，
    // 表现是部分测试文件被静默跳过（只跑了一半却显示通过）。串行跑，慢一点但结果可信。
    fileParallelism: false,
  },
});
