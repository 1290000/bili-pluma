/**
 * 静态穷举守卫：`logsMeta` 的**链式二次访问**一律红（task-30 缺陷 2）。
 *
 * ## 为什么需要这条（它守的东西跑用例守不住）
 *
 * task-28 的崩溃是 `TypeError … reading 'ok'` @ `diagnosticsPane`，
 * 修法是**收敛成一次绑定**：`const meta = data.logsMeta ?? describeLogsMetaFallback();`
 * 之后函数里只读 `meta`。
 *
 * 但"只读 `meta`"是个**约定**，行为用例守不住它：
 * 有人明天再写一行 `data.logsMeta.count`，只要那个分支当时没人走到，
 * 所有用例照样绿 —— 直到生产环境里它崩一次。
 *
 * 所以这条是**穷举式**的：不依赖我想到哪个输入形状，扫源码，
 * 任何 `xxx.logsMeta.` / `xxx.logsMeta[` 都红。
 *
 * ## 这条守卫原本住在 `poc/probe/verify-task28/`
 *
 * `vitest.config.ts` 的 `include` 是 `tests/**` —— 放在 `poc/` 下的探针**永远不会被
 * `node scripts/verify.mjs` 扫到**。也就是说：verify 21 项全绿**并不能证明**
 * "没人又把 `data.logsMeta.X` 写回去"。搬进 `tests/` 才算真正守住。
 *
 * ## 放行的两种形状（都是"取"，不是"解引用"）
 *
 * - `logsMeta: LogsMeta` / `logsMeta?: LogsMeta` —— 类型声明
 * - `data.logsMeta ?? FALLBACK()` —— 绑定点本身
 *
 * ⚠️ 这条守卫**必须附 RV**：在 `panel.ts` 里插一行 `const x = data.logsMeta.count;`
 * 必须真红；删掉后必须绿。否则它就是个恒绿的摆设（今天已经踩过一次这种）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** 仓库根：vitest 的 root 就是仓库根（`vitest.config.ts` 没改 root） */
const ROOT = process.cwd();

const FILES = ['src/content/panel/diagnostics.ts', 'src/content/panel/panel.ts'] as const;

/**
 * 剥注释，**保留行号**（用空格替换，长度不变），这样报错行号能直接对上源文件。
 *
 * 必须状态机逐字符扫：**单条"斜杠星号到星号斜杠"的懒匹配正则会跨块吞** ——
 * 它遇到字符串里出现的那个"星号斜杠"就会提前收尾，把后面的真代码一起当成注释吃掉。
 * task-12 就因此差点误报"我改了逻辑"。
 * （这里**不能**把那个正则写成字面量：它自己就会提前闭合本注释块。）
 */
function stripCommentsKeepLines(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        mode = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      out += c === '\n' ? '\n' : ' ';
      if (c === '\n') mode = 'code';
      i += 1;
      continue;
    }
    if (c === '*' && n === '/') {
      mode = 'code';
      out += '  ';
      i += 2;
      continue;
    }
    out += c === '\n' ? '\n' : ' ';
    i += 1;
  }
  return out;
}

/** 找出所有"解引用 `logsMeta`"的位置（去掉放行的两种形状） */
function chainAccesses(code: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  for (const m of code.matchAll(/logsMeta\s*[.?[]/g)) {
    const idx = m.index ?? 0;
    const after = code.slice(idx, idx + 40);
    /** 类型声明：`logsMeta?: LogsMeta` / `logsMeta: LogsMeta` —— 不是解引用 */
    if (/^logsMeta\??\s*:/.test(after)) continue;
    /** 绑定点：`logsMeta ?? …` —— 这是"取"，解引用的是绑定后的变量 */
    if (/^logsMeta\s*\?\?/.test(after)) continue;
    /** `logsMeta?.[i]` 这种可选链**解引用**照样要拦（`?` 后被 `\??` 吃掉时上面两条不匹配） */
    const line = code.slice(0, idx).split('\n').length;
    hits.push({ line, text: (code.split('\n')[line - 1] ?? '').trim() });
  }
  return hits;
}

describe('★★★ 静态穷举 · `data.logsMeta.X` 链式访问（task-28 收敛后的不变量）', () => {
  it('诊断渲染与导出两条链路里都不允许二次解引用 `logsMeta`', () => {
    const violations: string[] = [];
    for (const rel of FILES) {
      const code = stripCommentsKeepLines(readFileSync(join(ROOT, rel), 'utf8'));
      expect(code.length, `${rel} 读成了空文件，路径坏了`).toBeGreaterThan(200);
      for (const hit of chainAccesses(code)) {
        violations.push(`${rel}:${String(hit.line)}  ${hit.text}`);
      }
    }
    expect(
      violations,
      `禁止 logsMeta 的链式二次访问 —— 必须先收敛成 meta 变量：\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('剥注释函数本身是可信的（拿一段带假阳性的代码自检）', () => {
    /**
     * 这条守的是**守卫自己的检测能力**：如果 `stripCommentsKeepLines` 或
     * `chainAccesses` 坏了（比如正则写错），上一条会**恒绿**。
     * 这里喂一段已知含违规 + 已知放行的代码，断言它抓得到也放得对。
     *
     * 这就是 `panel-diagnostics-export.test.ts` 里"主动构造一份带泄漏的 payload
     * 证明扫描器能抓到"的同一种思路 —— 没有第二条，第一条可能永远绿。
     */
    const sample = [
      'const meta = data.logsMeta ?? FALLBACK();',
      'const bad = data.logsMeta.count;',
      '/** data.logsMeta.ok 在注释里，不算 */',
      '// data.logsMeta.err 在行注释里，也不算',
      'type T = { logsMeta?: LogsMeta };',
    ].join('\n');
    const hits = chainAccesses(stripCommentsKeepLines(sample));
    expect(hits.length, '自检没抓到已知违规，守卫本身坏了').toBe(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.text).toContain('data.logsMeta.count');
  });
});
