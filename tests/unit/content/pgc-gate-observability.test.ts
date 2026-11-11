/**
 * 「门控必须可观测」的测试（Lead 2026-11-11 判据）。
 *
 * ## ⚠️ 2026-11-11 变更：第零道 PGC 门控已**删除**，本文件缩小了范围
 *
 * 原文钉的是「新增的第零道 PGC 门控 `if (rewriteGate !== true) return;` 必须可观测」。
 * 但用户后来裁决**那道门控不该存在**（task-15）：
 * 判据是「谁提供了这份流，就由谁负责门控」——注入内容来自 `sessionStorage`，
 * ISOLATED 取流成功后才写，所以门控责任在 ISOLATED，主世界不该再加一道。
 * 见 ADR 0020 §92-107 与 `main-world.js:1186` 的删除说明。
 *
 * **所以 4 条"门控存在/命名/计数/顺序"的用例已删除** ——
 * 它们测的是一个**按裁决不该存在**的东西。verifier 提醒过：
 * **不要为了保留它们把门控加回来**；测试跟着裁决走，不是裁决跟着测试走。
 *
 * ## 仍然有效的部分（不要删）
 *
 * 其余门控（`skip-proxy-off` / `skip-disabled` / `skip-inactive`）**仍然存在**，
 * 「lastStage 必须能发出去、ISOLATED 必须读 `lastStage` 而不是 `stage`、
 * 每个赋值都必须是字面量」这些判据**一个字没变**。
 *
 * ## 判据
 *
 * **任何门控都必须有一个可观测的出口。** 本文件钉住这条链路的三个环节：
 *
 * 1. `main-world.js` 的 `pgcPost` 把 `lastStage` **一起发出去**
 * 2. `content.ts` 从消息里读 **`lastStage`**（不是 `stage` —— 那是事件类别）
 * 3. 值最终进 `pgcReloadTrace.mainWorldStage`，而 `pgcReloadTrace` 是
 *    `page/snapshot:ok` 的 `pgcReload` 字段（bsk / 自动化能读到）
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN_SRC = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');
const CONTENT_SRC = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

describe('环节 1：主世界必须把 lastStage 发出去', () => {
  /**
   * 反向验证：把 `pgcPost` 里的 `lastStage: pgcTrace.lastStage,` 删掉 → 本条变红。
   * 删掉后 ISOLATED 侧收不到阶段值，新门控重新变成不可观测。
   */
  it('pgcPost 的载荷里带 lastStage: pgcTrace.lastStage', () => {
    expect(MAIN_SRC).toContain('lastStage: pgcTrace.lastStage,');
  });
});

describe('环节 2：ISOLATED 必须读 lastStage（不是 stage）', () => {
  /**
   * 反向验证（已实测）：把 `read(d as {lastStage?})` 改成读 `stage` → 本条变红。
   *
   * 取错成 `stage` 的后果：所有跳过都读成 `'skip'`（事件类别），
   * 分不出是哪一道门控拦的 —— 等于没观测。
   */
  it('content.ts 消费的是 lastStage 字段', () => {
    expect(CONTENT_SRC).toContain('.lastStage');
    expect(CONTENT_SRC).toMatch(/pgcReloadTrace\.mainWorldStage = lastStage;/);
  });

  /**
   * 反向验证：删掉 `pgc` 分支里的 `return;` → 本条变红。
   *
   * 不 return 的后果：`pgc` 消息会落到下面的 `ssr-playinfo` 分支，
   * 被当成基线载荷解析，污染 `PageState`（可能出现假基线）。
   */
  it('⚠️ pgc 分支必须有 return（否则污染 PageState）', () => {
    const at = CONTENT_SRC.indexOf("if (d.type === 'pgc') {");
    expect(at).toBeGreaterThan(-1);
    const block = CONTENT_SRC.slice(at, at + 700);
    expect(block).toContain('return;');
  });

  it('mainWorldStage 在 pgcReloadTrace 里有定义且初值为空串', () => {
    expect(CONTENT_SRC).toMatch(/mainWorldStage:\s*''/);
  });

  /**
   * 反向验证：把 `pgcReload: pgcReloadTrace` 从快照出口删掉 → 本条变红。
   * 没有它，前两个环节的努力都读不到（这正是 2026-10-29 踩过的"埋点写了但读不到"）。
   */
  it('pgcReloadTrace 通过 page/snapshot 桥送出（至少两处：正常 + 降级）', () => {
    const hits = CONTENT_SRC.split('pgcReload: pgcReloadTrace').length - 1;
    expect(hits).toBeGreaterThanOrEqual(2);
  });
});

describe('可观测性判据：每个 lastStage 值都能被归类', () => {
  /**
   * `lastStage` 的**赋值**取值域必须有限且封闭（都是字面量），
   * 否则"对照表排查"这个用法就不成立了。
   *
   * ⚠️ 只匹配 `pgcTrace.lastStage = ...` 这种**赋值**；
   * `pgcPost` 载荷里的 `lastStage: pgcTrace.lastStage` 是**读取**，不在此列
   * （那个用 `=` 而非 `:` 区分，正则已限定 `=`）。
   *
   * 反向验证：新增一个 `pgcTrace.lastStage = someVariable;` → 本条变红。
   */
  it('lastStage 的所有赋值都是字符串字面量', () => {
    /**
     * ⚠️ **必须先剥掉注释再匹配**。
     *
     * 本文件里有多处注释写着 `` `pgcTrace.lastStage = 'skip-no-rewrite-gate'` ``
     * （说明文档用），不剥会把这些散文也当成代码，正则跨行匹配到一大段中文。
     * 这是一个真实的踩坑：第一版没剥，报错信息里出现了
     * `'\'skip-no-rewrite-gate\'` 并 +1\n * …` 这种明显不是代码的片段。
     */
    const code = MAIN_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const assignRe = /pgcTrace\.lastStage = ([^;]+);/g;
    const values: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = assignRe.exec(code)) !== null) {
      /**
       * ⚠️ `m[1]` 是 `string | undefined`（`noUncheckedIndexedAccess`）——
       * 直接 `.trim()` 会报 TS2532。但据此写 `m[1] ?? ''` 会**掩盖**正则漏捕的情况：
       * 空串仍会被 push 进去，然后在下面的断言里以"不是字面量"的形态报出来，
       * **报错信息会指向错误的地方**。
       *
       * 所以显式断言：捕获组拿不到就是**测试自身写错了**，不是被测代码的问题。
       */
      const cap = m[1];
      if (cap === undefined) throw new Error('正则捕获组未命中 —— 检查 assignRe 的定义');
      values.push(cap.trim());
    }

    expect(values.length).toBeGreaterThanOrEqual(7);
    for (const v of values) {
      expect(v, `lastStage 赋值必须是字面量，实际是 ${v}`).toMatch(/^'[a-z-]+'$/);
    }
  });

  it('已知的门控阶段值齐全（改动时这里会提醒同步注释）', () => {
    /**
     * ⚠️ **`'skip-no-rewrite-gate'` 已从本清单移除**（2026-11-11，task-15）。
     *
     * 它对应的那道门控（`main-world.js` 第零道 PGC 门控）**按用户裁决已删除** ——
     * 判据是「谁提供了这份流，就由谁负责门控」：注入内容来自 `sessionStorage`，
     * ISOLATED 取流成功后才写，所以门控责任在 ISOLATED，主世界不该再加一道。
     * 见 ADR 0020 §92-107 与 `main-world.js:1186` 的删除说明。
     *
     * **不要为了保留它把门控加回来** —— 测试跟着裁决走，不是裁决跟着测试走。
     */
    const expected = [
      "'boot'",
      "'skip-proxy-off'",
      "'skip-disabled'",
      "'skip-inactive'",
      "'patched'",
    ];
    for (const v of expected) {
      expect(MAIN_SRC, `缺少 ${v}`).toContain(`pgcTrace.lastStage = ${v};`);
    }
  });
});
