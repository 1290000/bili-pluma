/**
 * 只跑判据 A 那条源码级守卫（`tests/unit/content/panel-diag-wiring.test.ts` 里
 * `★★★ 导出侧兜底必须复用 describeLogsMetaFallback()`），用于验证它杀不杀 RV1、会不会假绿。
 */
import { execSync } from 'node:child_process';

const out = execSync(
  'node node_modules/vitest/vitest.mjs run tests/unit/content/panel-diag-wiring.test.ts -t "导出侧兜底必须复用"',
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
console.log(out);
