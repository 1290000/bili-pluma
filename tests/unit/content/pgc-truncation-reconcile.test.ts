/**
 * PGC 截断判据三份实现的对账测试（O4 · 2026-10-30）
 *
 * ## 为什么需要这个文件
 *
 * 「这条流算不算截断」这个判据在代码里有**三份实现**：
 *
 * | 实现 | 位置 |
 * | --- | --- |
 * | `isTruncatedVideoInfo` | `src/content/isolated/pgc-cache-inject.ts:147`（ISOLATED 侧，带 `expectedMs` 第二参照） |
 * | `pgcVideoInfoTruncated` | `src/content/main-world.js:345` |
 * | `pgcPlayviewIsTruncated` | `src/content/main-world.js:2787` |
 *
 * 主世界是裸 JS、没法 import TS，所以三份**必须各写一遍**（这是既有约束）。
 * 但此前**没有任何脚本或测试在比对它们的结论** —— 只有共享的容差常量被锁住。
 *
 * ## 这个文件测什么
 *
 * 用同一批输入分别喂三份实现，**记录它们的结论是否一致**。
 *
 * ⚠️ 这里**不假设"应该一致"**。三份的职责确实有差异（见下），
 * 所以测试分两类：
 *   1. **必须一致**的输入（差异与职责无关的场景，如多段 durl 求和）
 *   2. **已知会不一致**的输入（主世界没有 `expectedMs` 第二参照），
 *      写明理由并钉住当前结论 —— 将来若有人补齐参照，这里会红，提醒同步更新
 */

import { describe, expect, it } from 'vitest';

import { isVideoInfoTruncated } from '@/src/content/isolated/pgc-cache-inject';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';

import { assertTestExports, spliceTestExports } from './helpers/main-world-exports';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');
const EXPOSED = ['pgcVideoInfoTruncated', 'pgcPlayviewIsTruncated'] as const;
const SPLICED = spliceTestExports(SOURCE, EXPOSED);

/**
 * 主世界两份判据的具名类型。
 *
 * 用具体签名而不是 `Record<string, fn>` —— 后者索引签名返回 `| undefined`，
 * 每个调用点都要收窄一次。这里把 `assertTestExports` 的运行时保证
 * 用类型**显式**表达出来。
 */
interface MainWorldPredicates {
  pgcVideoInfoTruncated: (vi: unknown) => boolean;
  pgcPlayviewIsTruncated: (vi: unknown) => boolean;
}

/** 主世界两份判据 */
function mainWorldPredicates(): MainWorldPredicates {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://www.bilibili.com/bangumi/play/ep1',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown> & { eval: (s: string) => void };
  win.eval(SPLICED);
  assertTestExports(win, EXPOSED);
  return win.__PLUMA_TEST__ as unknown as MainWorldPredicates;
}

describe('PGC 截断判据对账（O4）', () => {
  describe('ISOLATED 侧基线行为', () => {
    it('完整流（duration ≥ timelength）→ 不截断', () => {
      expect(isVideoInfoTruncated({ timelength: 600000, dash: { duration: 600 } })).toBe(false);
    });

    it('试看流（dash 120s vs timelength 600s）→ 截断', () => {
      expect(isVideoInfoTruncated({ timelength: 600000, dash: { duration: 120 } })).toBe(true);
    });

    it('多段 durl 必须全部相加（不是只看第一段）', () => {
      /**
       * 2026-10-29 verifier 抓到的反例：
       * `{timelength:600000, durl:[300000,300000]}` 是完整流，
       * 只看 `durl[0]` 会误判成截断。
       */
      expect(
        isVideoInfoTruncated({
          timelength: 600000,
          durl: [{ length: 300000 }, { length: 300000 }],
        }),
      ).toBe(false);
    });

    it('容差 5000ms 边界', () => {
      // timelength 600000 - slack 5000 = 595000 是最低及格线
      expect(isVideoInfoTruncated({ timelength: 600000, dash: { duration: 595 } })).toBe(false);
      expect(isVideoInfoTruncated({ timelength: 600000, dash: { duration: 594 } })).toBe(true);
    });
  });

  describe('第二参照 expectedMs（主世界两份没有它）', () => {
    /**
     * ## 这是三份唯一**实质性**的差异
     *
     * ISOLATED 侧用 `refMs = max(timelength, expectedMs)`。
     * 主世界的 `pgcVideoInfoTruncated` / `pgcPlayviewIsTruncated` **只读 `timelength`**。
     *
     * 后果：接口响应缺 `timelength` 时：
     *   - ISOLATED 有 expectedMs → 能判出截断
     *   - 主世界两份 → `timelength` 为 0 → 直接 `return false`（放行，判成不截断）
     *
     * 两边结论**相反**。这不是 bug 还是设计取舍，取决于主世界能不能拿到 SSR 参照 ——
     * 主世界里 `pgcVideoInfoTruncated` 的调用点拿到的就是页面 `__playinfo__`，
     * 理论上能拿到参照，但当前实现没有接。
     */
    it('缺 timelength 但有 expectedMs → 能判出截断（主世界做不到）', () => {
      expect(isVideoInfoTruncated({ dash: { duration: 120 } }, 600000)).toBe(true);
    });

    it('缺 timelength 且无 expectedMs → 放行（判成不截断）', () => {
      expect(isVideoInfoTruncated({ dash: { duration: 120 } })).toBe(false);
    });

    it('expectedMs 只做兜底：timelength 更大时以 timelength 为准', () => {
      // timelength 600s，expectedMs 只给 100s —— 不能被小的那个带偏
      expect(isVideoInfoTruncated({ timelength: 600000, dash: { duration: 500 } }, 100000)).toBe(
        true,
      );
    });
  });

  describe('无时长信息时一律放行（三份的共同约定）', () => {
    it.each([
      ['空对象', {}],
      ['null', null],
      ['非对象', 42],
      ['只有 timelength 没有流', { timelength: 600000 }],
    ])('%s → 不截断', (_label, input) => {
      expect(isVideoInfoTruncated(input)).toBe(false);
    });
  });

  describe('三份实现在共同场景下结论一致', () => {
    /**
     * 这些输入的差异**与职责无关**，三份必须给出相同结论。
     * 任一条不一致都说明判据已经漂移。
     *
     * ⚠️ **dash 形态不在这个清单里** —— `pgcPlayviewIsTruncated` 没有 dash 分支
     * （见下面「实测发现的真实缺陷」那组）。修好之后应把 dash 场景加回来。
     */
    const SHARED_CASES: Array<[string, unknown]> = [
      ['多段 durl 完整', { timelength: 600000, durl: [{ length: 300000 }, { length: 300000 }] }],
      ['多段 durl 截断', { timelength: 600000, durl: [{ length: 180000 }] }],
      ['无时长信息', { timelength: 0 }],
    ];

    it.each(SHARED_CASES)('%s：ISOLATED 与主世界两份结论相同', (_label, input) => {
      const mw = mainWorldPredicates();
      const isolated = isVideoInfoTruncated(input);
      const videoInfo = mw.pgcVideoInfoTruncated(input);
      const playview = mw.pgcPlayviewIsTruncated(input);

      expect(videoInfo, 'pgcVideoInfoTruncated 与 ISOLATED 不一致').toBe(isolated);
      expect(playview, 'pgcPlayviewIsTruncated 与 ISOLATED 不一致').toBe(isolated);
    });
  });

  describe('⚠️ 实测发现的真实缺陷：playview 判据完全不看 dash', () => {
    /**
     * ## 2026-10-30 对账测试抓到的
     *
     * | 实现 | durl | durls | **dash** |
     * | --- | --- | --- | --- |
     * | `isTruncatedVideoInfo`（ISOLATED） | ✅ 全段求和 | ✅ 首组求和 | ✅ |
     * | `pgcVideoInfoTruncated`（主世界 :345） | ✅ | ✅ | ✅（:362-365） |
     * | **`pgcPlayviewIsTruncated`（主世界 :2787）** | ✅ | ✅ | ❌ **没有这个分支** |
     *
     * 后果：playview 响应若是 **dash 形态**（`fnval=4048` 之后的主形态），
     * `pgcPlayviewIsTruncated` 走完 durl/durls 两个分支都命中不了，
     * 最后 `return false` —— **永远判不出截断**。
     *
     * 而 `pgcSwapPlayviewBody` 正是靠它决定"要不要换流"（:2898）。
     * 判不出截断 → 走"画质可能更高"那条更保守的路径，
     * 所以不会立刻坏，但**会员试看集如果走了这条分支就会被漏掉**。
     *
     * 这三条测试**钉住当前（有缺陷的）行为**，不是期望行为。
     * 修好之后它们会红，那时改成期望值。
     */
    it('dash 形态的试看流：ISOLATED 判截断，playview 判不出', () => {
      const input = { timelength: 600000, dash: { duration: 120 } };
      const mw = mainWorldPredicates();

      expect(isVideoInfoTruncated(input)).toBe(true);
      expect(mw.pgcPlayviewIsTruncated(input)).toBe(false); // ← 缺陷
    });

    it('dash 形态的容差边界外：同样判不出', () => {
      const input = { timelength: 600000, dash: { duration: 594 } };
      const mw = mainWorldPredicates();

      expect(isVideoInfoTruncated(input)).toBe(true);
      expect(mw.pgcPlayviewIsTruncated(input)).toBe(false); // ← 缺陷
    });

    it('对照：durl 形态下三份一致（说明缺陷只在 dash 分支）', () => {
      const input = { timelength: 600000, durl: [{ length: 180000 }] };
      const mw = mainWorldPredicates();

      expect(isVideoInfoTruncated(input)).toBe(true);
      expect(mw.pgcPlayviewIsTruncated(input)).toBe(true);
    });
  });

  describe('已知差异：只有 ISOLATED 有 expectedMs 第二参照', () => {
    it('缺 timelength 时，ISOLATED 能判截断而主世界放行 —— 当前预期如此', () => {
      const mw = mainWorldPredicates();
      const input = { dash: { duration: 120 } };

      // ISOLATED 有参照 → 判得出截断
      expect(isVideoInfoTruncated(input, 600000)).toBe(true);
      // 主世界两份只读 timelength（为 0）→ 直接放行
      expect(mw.pgcVideoInfoTruncated(input)).toBe(false);
      expect(mw.pgcPlayviewIsTruncated(input)).toBe(false);
    });

    /**
     * ⚠️ **这条测试断言的是"当前存在差异"，不是"差异是对的"。**
     *
     * 若将来给主世界补上 `expectedMs` 参照，这条会红 —— 那时把它改成
     * "三者一致"的断言，并把上述 describe 合并。
     */
    it('主世界两份都缺 expectedMs 参数（签名上就没有）', () => {
      const mw = mainWorldPredicates();
      expect(mw.pgcVideoInfoTruncated.length).toBe(1);
      expect(mw.pgcPlayviewIsTruncated.length).toBe(1);
    });
  });
});
