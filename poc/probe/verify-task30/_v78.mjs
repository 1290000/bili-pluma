import { backup, restore, runTests, ROOT } from './rv-lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PANEL = 'src/content/panel/panel.ts';
const GUARD = 'tests/unit/content/panel-diag-wiring.test.ts';
const ALL = [PANEL, GUARD];

// 唯一能破两侧同源、又保住"复用"正则的样子：复用改写类 + 在展开之前/之后塞字面 ok:
// 关键是字面量断言 `\b(?:ok|err)\s*:` 会在块内任意位置命中 ⇒ 只要想塞 ok: 就红。
// 反过来：想绕过它只有把 ok: 写成字符串/计算属性等非 `ok:` 形态 —— 那也写不出覆盖。
const cases = [
  {
    name: 'V7 复用保持 + 用计算属性名覆盖观测类（[`ok`]: true）',
    fn: (s) =>
      s.replace(
        'logsMeta: diagData?.logsMeta ?? {\n                    ...describeLogsMetaFallback(),',
        'logsMeta: diagData?.logsMeta ?? {\n                    ...describeLogsMetaFallback(),\n                    [`ok`]: true,',
      ),
    expected: '若绿 ⇒ 危险写法绕过字面量断言（计算属性不含 `ok:` 字面量）',
  },
  {
    name: 'V8 复用保持 + 局部变量谎报（const bad = { ...F(), ok: true }; ...bad）',
    fn: (s) =>
      s.replace(
        'logsMeta: diagData?.logsMeta ?? {\n                    ...describeLogsMetaFallback(),',
        'logsMeta: (() => {\n                      const ok = true;\n                      return diagData?.logsMeta ?? { ...describeLogsMetaFallback(), ...{ ok } };\n                    })(),\n                    __dead: {...describeLogsMetaFallback(),',
      ),
    expected: '任一结果都要记录：这条用来找断言的边界',
  },
];

for (const c of cases) {
  console.log(`\n=== ${c.name} ===`);
  const snap = backup(ALL);
  let run = { failed: 0, passed: 0, failures: [], noTests: true };
  let info = null;
  try {
    const p = join(ROOT, PANEL);
    const src = readFileSync(p, 'utf8');
    const next = c.fn(src);
    if (next === src) throw new Error('patch 没改到东西');
    writeFileSync(p, next, 'utf8');
    info = 'mutated';
    run = runTests([GUARD]);
  } catch (e) {
    info = `ERR ${String(e.message ?? e)}`;
  } finally {
    const after = restore(ALL);
    const same = ALL.every((r) => after[r] === snap[r]);
    console.log(`[mutated] ${String(info)} restore_ok=${String(same)}`);
    console.log(`[result] failed=${String(run.failed)} passed=${String(run.passed)}`);
    for (const f of run.failures) console.log(`   x ${f.msg}`);
    console.log(`[预期] ${c.expected}`);
  }
}
