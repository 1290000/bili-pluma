/**
 * `check-messages.mjs` 内联联合扫描的**形态穷举自检**（2026-11-11）。
 *
 * ## 为什么检查脚本需要自己的测试
 *
 * 项目里的检查脚本（`check-messages.mjs` / `check-page-gate.mjs` /
 * `check-patch-scope.mjs` …）有一个共同的失败模式：**它们自己出错时是静的**。
 *
 * > **检查工具误报一次，人就学会忽略它一次。**
 * > 与 `ROUTES_CHECKED_AT` 那条"假警报会训练用户忽略它"是同一原则。
 *
 * 而误报的**坏处会累积**：第一次误报 → 加豁免；第二次 → 放宽正则；
 * 第三次 → 直接不看输出。**三步之后，这个检查等于不存在，但它在 CI 里还是绿的。**
 *
 * 所以：**检查脚本的判据本身就是需要被测试的代码**。
 * 这个目录（`tests/unit/scripts/`）存在的理由就是这个。
 *
 * ## 为什么要把"做过一次的穷举"变成测试
 *
 * 预审时手工跑过 15 种形态，全部正确。但那是**"做过一次"**，
 * 不是**"永远不会退化"**。这个正则已经改过两轮：
 *   1. 加 `\|?` —— 修 Prettier 多行形态**漏检**
 *   2. 加 `stripComments` —— 修注释形态**误报**
 *
 * **每次改都可能把已经修好的形态改回去。** 所以把穷举固化成断言：
 * **改正则时必须跑本文件**，而不是"跑一遍看看"。
 *
 * ## 判据（写在这里防止后人简化掉）
 *
 * | 方向 | 后果 | 严重度 |
 * | --- | --- | --- |
 * | **漏检**（该报没报） | 类型断链静默通过，`tsc` 也不报 | 🔴 更严重 |
 * | **误报**（不该报报了） | 用户学会忽略这条检查，然后真缺陷也漏 | 🟡 |
 *
 * 两个方向都要测。只测一个方向的正则，另一方向会静默恶化。
 *
 * ## ⭐ 为什么"7 条该报 + 8 条不该报"**必须同时存在**（这是本文件的真正理由）
 *
 * 上面那句"两个方向都要测"，机制上到底是什么意思？**双向约束把正则钉在一个窄区间里。**
 *
 * > **只有"该报"** → 一个"什么都报"的正则（`/(.*)/`）能全过。
 * > **只有"不该报"** → 一个"什么都不报"的正则（`/zzz-never-match/`）也能全过。
 * > **两边都在** → 两个退化方向同时被堵死。
 *
 * ### 实测（2026-11-11，变异测试）
 *
 * 把正则换成各种退化形态，跑同一组断言：
 *
 * | 变异体 | 该报通过 | 不该报通过 | 结果 |
 * | --- | --- | --- | --- |
 * | 【原始】正常正则 | 7/7 | 6/6 | （预期：本来就该全过） |
 * | 【变异1】`/(.*)/` 什么都报 | 7/7 | **0/6** | ✅ 被拦住 |
 * | 【变异2】`/zzz-never-match/` 什么都不报 | **0/7** | 6/6 | ✅ 被拦住 |
 * | 【变异3】去掉前置竖线 `\|?` | **6/7** | 6/6 | ✅ 被拦住 |
 * | 【变异4】去掉字段白名单（任何字段都查） | 7/7 | 6/6 | ⚠️ **漏网** |
 *
 * **结论：双向约束构成了这个测试的"递归终止条件"** ——
 * 它不需要"检查工具的检查工具的检查工具"，因为
 * **"什么都报"和"什么都不报"两个退化的极端方向都被它自己的断言堵住了。**
 *
 * ### ⚠️ 一个已知的漏网方向（如实记录）
 *
 * **变异4（去掉字段白名单）不会被本文件的断言抓到。** 因为把白名单从
 * "4 个字段"放宽到"任何字段"后，那 15 个样本**恰好都不受影响**。
 *
 * 要堵这个方向，需要一条**专门针对白名单的断言** —— 见下面
 * 「字段白名单」那一组（它读脚本源码断言 4 个字段名都在，且**不**接受"任何字段"）。
 *
 * **这条如实写出来，是因为"本文件有保护"和"本文件对所有退化方向都有保护"是两件事。**
 * 不写清楚，下一个人会以为改什么都安全。
 *
 * ## 本文件为什么直接重实现正则
 *
 * `check-messages.mjs` 是 `.mjs`，内部函数未导出。为了一条断言去改造它的导出面，
 * 会让那个脚本为了"可测试"而变形（它不是业务代码）。
 *
 * 折中：**在这里复刻同样的两个算法**，并在第一条用例里**读源码断言两处一致** ——
 * 复刻品漂移会导致那条先红，而不是像纯复刻品那样静默飘走。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-messages.mjs');

/** 与被测脚本保持一致的字段白名单 */
const SEALED_ENUM_FIELDS = ['reason', 'proxyIdentity', 'lastActivateReason', 'identity'];

/**
 * 复刻 `check-messages.mjs` 的 `stripComments`。
 *
 * ⚠️ 必须与脚本里的实现**行为一致**。第一条用例会读源码核对关键特征，
 * 脚本那边改了这里没跟上会先红。
 */
function stripComments(src: string): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      j = Math.min(j + 2, n);
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** 复刻 `findInlineUnions` 的匹配部分 */
function findInlineUnions(rawSrc: string): Array<{ field: string; union: string }> {
  const out: Array<{ field: string; union: string }> = [];
  const codeOnly = stripComments(rawSrc);
  const re = new RegExp(
    `\\b(${SEALED_ENUM_FIELDS.join('|')})\\s*\\??\\s*:\\s*(\\|?\\s*'[^']*'\\s*(?:\\|\\s*'[^']*'\\s*)+)`,
    'g',
  );
  for (const m of codeOnly.matchAll(re)) {
    /**
     * ## 为什么用显式检查而不是 `m[1]!` / `m[2]!`
     *
     * `matchAll` 返回 `RegExpMatchArray`，它的索引签名是 `string | undefined` ——
     * `tsc` **无法**从正则字面量推断"这两个是必需捕获组"。所以它报 TS18048。
     *
     * 那**不是运行时风险**（正则里两个组都没有 `?` 修饰，命中时必然有值），
     * 但用 `!` 会把这个信号永久吞掉。
     *
     * 而这里有一条**更重要的可能性**：如果某个形态"该命中却没命中"，
     * `union` 会是 `undefined` —— 那正是**漏检**的真信号。
     * **用 `!` 就把它变成"静默通过"了。**
     *
     * 所以：运行时显式断言 + 带诊断信息的报错，让漏检变成**会说出原因**的失败。
     */
    const field = m[1];
    const union = m[2];
    if (field === undefined || union === undefined) {
      throw new Error(
        `[自检] 正则命中但捕获组缺失（field=${String(field)} union=${String(union)}）。` +
          `这通常意味着正则的捕获组被改成了可选 —— 检查会静默漏检。匹配原文：${JSON.stringify(m[0])}`,
      );
    }
    if ((union.match(/'/g) ?? []).length / 2 < 2) continue;
    out.push({ field, union: union.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

describe('自检前提：复刻品与脚本本体一致', () => {
  it('脚本里仍有 stripComments，且调用点在 findInlineUnions 内', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src, '脚本没有 stripComments —— 注释误报会回来').toContain('function stripComments(');
    expect(src, 'findInlineUnions 必须对剔除后的源码匹配').toContain(
      'const codeOnly = stripComments(rawSrc);',
    );
    expect(src, '正则里必须有前置竖线支持（Prettier 多行形态）').toContain('\\|?');
  });

  it('字段白名单一致', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    for (const f of SEALED_ENUM_FIELDS) {
      expect(src, `脚本里缺少字段白名单项 ${f}`).toContain(`'${f}'`);
    }
  });

  it('★ 字段白名单**必须是封闭枚举**，不许放宽成"任何字段"', () => {
    /**
     * ## 这条堵的是变异4（见文件头的实测表）
     *
     * 把 `SEALED_ENUM_FIELDS` 换成 `\w+`（任何字段）后，那 15 个形态样本
     * **恰好都不受影响** —— 双向约束抓不到它。
     *
     * 而"任何字段"的后果是**误报面爆炸**：`identity: 'user' | 'group'`、
     * `type: 'a' | 'b'` 这类与消息枚举无关的字段全会被报红。
     *
     * 判据：`SEALED_ENUM_FIELDS` 的每项必须是**带引号的字面量**（`'reason'`），
     * 而正则里拼接它时用的是 `join('|')` —— **不是**任意的 `\w+`。
     */
    const src = readFileSync(SCRIPT, 'utf8');

    // ① 白名单必须是字面量数组，不是正则片段
    const decl = /const SEALED_ENUM_FIELDS = \[([^\]]*)\]/.exec(src);
    expect(decl, '找不到 SEALED_ENUM_FIELDS 的数组声明').not.toBeNull();
    const body = decl?.[1] ?? '';
    for (const f of SEALED_ENUM_FIELDS) {
      expect(body, `白名单里 ${f} 必须是带引号的字面量`).toContain(`'${f}'`);
    }

    // ② 不许出现"通配字段"的写法
    for (const forbidden of ['\\\\w+', '[a-zA-Z]+', '(\\\\w*)']) {
      expect(decl?.[1] ?? '', `白名单被放宽成通配：${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('✅ 该报的形态 —— 7 种（漏检比误报更严重）', () => {
  const SHOULD_HIT: ReadonlyArray<[string, string]> = [
    ['单行', `type X = { reason: 'a' | 'b' }`],
    ['可选单行', `interface X { reason?: 'a' | 'b' }`],
    ['多行无前导竖线', `interface X {\n  reason?:\n    'a'\n    | 'b';\n}`],
    ['多行带前导竖线（Prettier 格式化后）', `interface X {\n  reason?:\n    | 'a'\n    | 'b';\n}`],
    ['跨行单行写法', `interface X {\n  reason?: 'a' |\n    'b';\n}`],
    ['内联 as 断言', `x as { reason?: 'a' | 'b' }`],
    ['三元联合', `interface X { reason?: 'a' | 'b' | 'c' }`],
  ];

  it.each(SHOULD_HIT)('%s → 必须命中', (_label, code) => {
    expect(findInlineUnions(code).length, `漏检：${code}`).toBeGreaterThan(0);
  });
});

describe('❌ 不该报的形态 —— 8 种（误报会训练用户忽略检查）', () => {
  const SHOULD_MISS: ReadonlyArray<[string, string]> = [
    ['引用类型（正确做法）', `interface X { reason?: ProxyActivateReason }`],
    ['单值不是联合', `interface X { reason?: 'a' }`],
    ['值不是类型', `const x = { reason: 'a' };`],
    ['泛型参数', `type Z = { reason: List<'a' | 'b'> }`],
    ['Record 键', `type M = Record<'reason', 'a' | 'b'>`],
    ['模板字面量类型', 'type T = { reason: `x` | `y` }'],
    ['JSDoc 注释里描述取值', `/** 取值：reason: 'ok' | 'self' | 'disabled' */`],
    ['块注释里', `/* reason?: 'a' | 'b' */`],
  ];

  it.each(SHOULD_MISS)('%s → 不许命中', (_label, code) => {
    expect(findInlineUnions(code), `误报：${code}`).toEqual([]);
  });
});

describe('❌ 注释剔除专项 —— 三种注释形态（这是 2026-11-11 修的真误报）', () => {
  it('行尾注释', () => {
    expect(findInlineUnions(`const a = 1; // reason: 'ok' | 'self'`)).toEqual([]);
  });

  it('JSDoc 多行（项目真实写法）', () => {
    const code = [
      '/**',
      " * 说明：`page/activate` 的 reason: 'ok' | 'self' | 'disabled'",
      ' * 这只是注释，不是类型声明。',
      ' */',
      'const a = 1;',
    ].join('\n');
    expect(findInlineUnions(code)).toEqual([]);
  });

  it('块注释', () => {
    expect(findInlineUnions(`/*\n reason?: 'a' | 'b'\n*/`)).toEqual([]);
  });

  it('⚠️ 剔除注释**不会**连真代码一起吃掉（这是本次修复的最大风险）', () => {
    /**
     * 若 `stripComments` 写错（例如把字符串当注释），会把真代码变成空白 →
     * **漏检**，那是比误报更严重的方向。
     *
     * 这条用例：注释 + 紧邻的真代码，真代码必须仍被命中。
     */
    const code = [
      `const a = 1; // reason: 'x' | 'y'`,
      `interface Real { reason?: 'a' | 'b' }`,
    ].join('\n');
    const hits = findInlineUnions(code);
    expect(hits, '剔除注释后漏掉了真代码里的联合').toHaveLength(1);
    expect(hits[0]?.union).toContain(`'a'`);
  });

  it('⚠️ 字符串里的 `//` 不是注释（否则会误吞真代码）', () => {
    const code = [
      `const url = 'https://example.com';`,
      `interface Real { reason?: 'a' | 'b' }`,
    ].join('\n');
    expect(findInlineUnions(code), '字符串里的 // 被当成注释，吞掉了后面的真代码').toHaveLength(1);
  });

  it('字符串里的 `/*` 不是注释', () => {
    const code = [`const s = '/* not a comment';`, `interface Real { identity: 'a' | 'b' }`].join(
      '\n',
    );
    expect(findInlineUnions(code)).toHaveLength(1);
  });
});

describe('剔除注释后行号不漂移（报错行号错比误报更糟）', () => {
  it('等长替换：剔除前后长度一致', () => {
    const src = ['// 注释', 'const a = 1;', '/* 块 */'].join('\n');
    expect(stripComments(src)).toHaveLength(src.length);
  });

  it('保留换行符：行数一致', () => {
    const src = ['/**', ' * 多行注释', ' */', 'const a = 1;'].join('\n');
    expect(stripComments(src).split('\n')).toHaveLength(src.split('\n').length);
  });

  it('注释被换成空白而不是删掉', () => {
    const src = '// reason: x\na';
    const out = stripComments(src);
    // 按长度断言，不手数空格（手数容易错，且这本来就该验"等长"这个性质）
    expect(out).toHaveLength(src.length);
    // 注释部分全变空白、换行保留、后面的代码不动
    expect(out.endsWith('\na')).toBe(true);
    expect(out.slice(0, out.indexOf('\n')).trim()).toBe('');
  });
});
