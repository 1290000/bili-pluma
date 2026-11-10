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
    // ── fileParallelism：2026-11-10 由 false 改为 true（原为串行）─────────────
    //
    // ## 当初为什么串行
    // 担心某些 Windows / 受限环境下**并行 worker（vitest 自己）写临时文件会 EPERM**，
    // 表现是部分测试文件被静默跳过 —— 只跑了一半却显示通过。宁可慢，也要结果可信。
    //
    // ## 为什么现在可以并行（依据，不是"更快"）
    // 1. **测试代码侧无写操作**：`tests/**/*.ts` 里 `writeFile / mkdir / rmSync / unlink /
    //    copyFile / renameSync / appendFile / createWriteStream` **零命中**；`node:fs` 的
    //    引用只有 `readFile` 与 `readFileSync` 两个只读 API。
    // 2. **实测结果与串行逐字一致**：串行基线 78 files / 1381 tests；并行同样 78 / 1381，
    //    且**并行连跑 3 次三次都一致**（2026-11-10 实测）。耗时 95s → 13.5s。
    // 3. **兜底断言（关键）**：`scripts/verify.mjs` 的 `assertTestTotals()` 每次运行都会断言
    //    「磁盘上 `tests/**/*.test.ts` 的个数 == vitest 报告的文件数」且「用例数 > 0」。
    //    所以**即使将来 worker 真的静默跳过了文件，verify 也会变红，不会悄悄放过**。
    //    这条把"现在的结论"变成"每次都重新验证的断言"，是本次敢开并行的真正依据。
    //
    // ## 将来如果又出现静默跳过
    // 症状：`verify` 报「⚠️ 静默跳过：磁盘上有 N 个测试文件，vitest 只报了 M 个」。
    // 处置：**把这一行改回 `false`**（会慢回约 95s，但可信），并排查是哪个用例引入了
    // 写临时文件的操作。**不要**为了让 verify 变绿去放宽 `assertTestTotals()`。
    fileParallelism: true,
  },
});
