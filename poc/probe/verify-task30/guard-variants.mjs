/**
 * 判据 A 的变体矩阵：源码级断言 `★★★ 导出侧兜底必须复用 describeLogsMetaFallback()`
 * 在 `tests/unit/content/panel-diag-wiring.test.ts` 里，用**拼接后的两个正则**守。
 *
 * 这一轮要回答两件事：
 *   (i)  它杀不杀 RV1（把兜底改成 ok:true/err:null 字面量）—— 见 rv.mjs RV1'；
 *   (ii) 它会不会**假绿**。假绿 = 变异体其实已经坏了（导出侧兜底不再"可信用"），
 *        但它没红。反过来，**假红** = 写法合法（语义没变）却因为它正则太死而红。
 *
 * 每条变体独立备份/还原，并记录它**在语义上该不该被守**（expected）与**实际**（actual）。
 * 用法：node poc/probe/verify-task30/guard-variants.mjs
 */
import { backup, restore, mutate, runTests, sha } from './rv-lib.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './rv-lib.mjs';

const PANEL = 'src/content/panel/panel.ts';
const GUARDFILE = 'tests/unit/content/panel-diag-wiring.test.ts';
const ALL = [PANEL, GUARDFILE];

const ORIG = `logsMeta: diagData?.logsMeta ?? {
                    ...describeLogsMetaFallback(),
                    limit: DIAG_LIMIT,
                    instanceId: instanceId(),
                    readAt: now.getTime(),
                  },`;

const IND = '                    '; // 20 spaces

/** 每个变体：name / 新文本 / 语义上该不该红 / 理由 */
const VARIANTS = [
  {
    name: 'V0 原样（对照）',
    text: ORIG,
    expectRed: false,
    why: '基线，必须绿',
  },
  {
    name: 'V1 改缩进与换行（语义不变）',
    text: `logsMeta:
                    diagData?.logsMeta ??
                    {
                      ...describeLogsMetaFallback(),
                      limit: DIAG_LIMIT,
                      instanceId: instanceId(),
                      readAt: now.getTime(),
                    },`,
    expectRed: false,
    why: '合法重排版；`[^}]*` 应跨得过多行',
  },
  {
    name: 'V2 展开不带对象包裹（语义变了：多余字段丢失）',
    text: `logsMeta: {
                    ...(diagData?.logsMeta ?? describeLogsMetaFallback()),
                    limit: DIAG_LIMIT,
                    instanceId: instanceId(),
                    readAt: now.getTime(),
                  },`,
    expectRed: true,
    why: '读起来等价，但**动作类覆盖被抹掉**是行为变化；正则要求 `?\\.logsMeta ?? {` 直接不匹配 ⇒ 会红。判定：红是**正确**的（写法变了、行为也变了）',
  },
  {
    name: 'V3 别处（不在 exportJson 块内）再写一份 ok: 字面量',
    text: ORIG,
    also: {
      rel: PANEL,
      from: '            refresh: () => {',
      to: "            __otherOk: { ok: false },\n            refresh: () => {",
    },
    expectRed: false,
    why: '块外自有合法的 ok: 字面量；切片只取 exportJson 块 ⇒ 不应波及。**这是它"切片"设计的边界，必须绿**',
  },
  {
    name: 'V4 真危险写法：兜底里同时写 ok: 覆盖观测类（@ts-expect-error 让它能编译）',
    text: `logsMeta: diagData?.logsMeta ?? {
                    ...describeLogsMetaFallback(),
                    // @ts-expect-error 实验：故意用真值覆盖观测类
                    ok: true,
                    limit: DIAG_LIMIT,
                    instanceId: instanceId(),
                    readAt: now.getTime(),
                  },`,
    expectRed: true,
    why: '`\\b(?:ok|err)\\s*:` 应命中 ⇒ 真红。**这是"两侧同源"被破坏的唯一真实途径**，必须红',
  },
  // V4 文本会把还原用的 mutate 打断吗？不会：还原走 backup 复制
];

const results = [];

function strip(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 把守卫的两个正则直接搬过来，离线判一遍（跑 vitest 之前先知道"理论上应该是红还是绿"） */
function offline(codeOnly) {
  const re1 = /logsMeta:\s*diagData\?\.logsMeta\s*\?\?\s*\{[^}]*\.\.\.describeLogsMetaFallback\(\)/;
  const re2 = /\b(?:ok|err)\s*:/;
  return { reuse: re1.test(codeOnly), literal: re2.test(codeOnly) };
}

for (const v of VARIANTS) {
  console.log(`\n=== ${v.name} ===`);
  const snap = backup(ALL);
  let mutated = null;
  let run = { failed: 0, passed: 0, failures: [], noTests: true };
  try {
    // 把整段 ORIG 换成变体文本：先找到 ORIG 的起止，直接整段替换
    const { readFileSync } = await import('node:fs');
    const p = join(ROOT, PANEL);
    const src = readFileSync(p, 'utf8');
    const count = src.split(ORIG).length - 1;
    if (count !== 1) throw new Error(`ORIG 出现 ${String(count)} 次，拒绝变异`);
    let next = src.replace(ORIG, v.text);
    if (v.also) {
      const c2 = next.split(v.also.from).length - 1;
      if (c2 !== 1) throw new Error(`also.from 出现 ${String(c2)} 次`);
      next = next.replace(v.also.from, v.also.to);
    }
    writeFileSync(p, next, 'utf8');
    mutated = { occurrences: count };
    // 离线：把 exportJson 块切出来按守卫的两个正则判
    const start = next.indexOf('exportJson:');
    let depth = 0;
    let i = next.indexOf('{', start);
    const open = i;
    for (; i < next.length; i += 1) {
      if (next[i] === '{') depth += 1;
      else if (next[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const off = offline(strip(next.slice(open, i + 1)));
    console.log(`[offline] reuse=${String(off.reuse)} literal=${String(off.literal)} ⇒ 断言层面预期${off.reuse && !off.literal ? '绿' : '红'}`);
    run = runTests([GUARDFILE]);
  } catch (e) {
    mutated = { error: String(e.message ?? e) };
    console.log(`[abort] ${mutated.error}`);
  } finally {
    const after = restore(ALL);
    const same = ALL.every((r) => after[r] === snap[r]);
    console.log(`[restore] 逐字节一致=${String(same)}`);
    const actual = run.failed > 0;
    const verdict = actual === v.expectRed ? '✅ 符合预期' : '❌ 不符合预期';
    console.log(`[结果] 该红=${String(v.expectRed)} 实际红=${String(actual)} ${verdict}`);
    for (const f of run.failures) console.log(`   × ${f.name}\n     ${f.msg}`);
    results.push({ name: v.name, expectRed: v.expectRed, actual, verdict, why: v.why, mutated, failures: run.failures });
  }
}

writeFileSync(join(ROOT, 'poc/probe/verify-task30/guard-variants-result.json'), JSON.stringify(results, null, 2), 'utf8');
console.log('\n[written] guard-variants-result.json');
