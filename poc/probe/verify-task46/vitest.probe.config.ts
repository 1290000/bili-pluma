import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: at('../../..'),
  resolve: {
    alias: [
      { find: '@shared', replacement: at('../../../src/shared') },
      { find: '@core', replacement: at('../../../src/core') },
      { find: '@platform', replacement: at('../../../src/platform') },
      { find: /^@\/(.*)$/, replacement: at('../../../$1') },
    ],
  },
  test: {
    include: ['poc/probe/verify-task46/**/*.test.ts'],
    environment: 'node',
    globals: false,
    fileParallelism: false,
  },
});
