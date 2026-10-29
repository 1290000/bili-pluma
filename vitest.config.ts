import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@shared', replacement: at('./src/shared') },
      { find: '@core', replacement: at('./src/core') },
      { find: '@platform', replacement: at('./src/platform') },
      /**
       * `@/...` 是 tsconfig 里的仓库根别名（`@/*` → `./*`），WXT 构建时自带。
       *
       * 2026-10-29 加：`tests/unit/platform/background-play-page.test.ts` 需要
       * import `entrypoints/background.ts`，而那个文件用 `@/src/...` 引自己人。
       * 不加这条，整个模块图加载失败（`Failed to load url @/src/background/login-window`），
       * 一个用例都跑不起来。
       *
       * ⚠️ 必须用**数组**形式 + 正则，且放在最后：
       *   对象形式的 `'@/'` 会被当成**前缀**，`@/src/x` 替换成 `D:\...\Pluma\/src/x`
       *   （多一个路径分隔符），解析出来是不存在的路径。
       *   正则 `/^@\/(.*)$/` 一次吃掉整段，不拼多余的斜杠。
       */
      { find: /^@\/(.*)$/, replacement: at('./$1') },
    ],
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
