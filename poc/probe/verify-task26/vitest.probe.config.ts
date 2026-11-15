// verifier 专用：跑本目录下的探针测试（不在 vitest.config.ts 的 include 内）
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // root 指向**本目录**：include 才能用相对本目录的 glob。
  // 别名用绝对路径，所以 src/ 仍解析到仓库根。
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: [
      { find: '@shared', replacement: at('../../../src/shared') },
      { find: '@core', replacement: at('../../../src/core') },
      { find: '@platform', replacement: at('../../../src/platform') },
      { find: /^@\/(.*)$/, replacement: at('../../../$1') },
    ],
  },
  test: {
    include: ['*.test.ts'],
    environment: 'node',
    globals: false,
    fileParallelism: false,
    // 关缓存：变异后同一模块必须重新 transform，否则 RV 可能读到旧代码（假红/假绿）
    cache: false,
  },
});
