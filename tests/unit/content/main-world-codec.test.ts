// @vitest-environment jsdom
/**
 * 编码族 / 档次 / 活跃轨判断的直接测试（阶段 4 · S4.2）
 *
 * ## 这个文件取代了 `main-world-logic.test.ts`
 *
 * 旧文件用**复刻**方式测：把 `main-world.js` 里的函数手工抄一份到测试里，
 * 然后在注释里写「改源码时必须同步改这里」——那是一条**靠人记住**的约束。
 *
 * 2026-10-30 实测确认它**已经漂移**：
 *
 * ```
 * 复刻版 pickActive：按 lastUpdate 时间戳挑、忽略 0、全空返回 '?'
 * 真实现 pickActive：list[list.length - 1]   ← 取最后一条
 * ```
 *
 * 两者语义完全不同。也就是说那一组测试**在测一个不存在的实现**，
 * 而它一直是绿的 —— 这正是「复刻第二份实现」最坏的形态。
 *
 * 现在用测试侧拼接取出**真源码**里的函数直接测（`helpers/main-world-exports.ts`），
 * 改 0 行被测代码。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';

import { assertTestExports, spliceTestExports } from './helpers/main-world-exports';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');

const EXPOSED = ['codecFamily', 'hevcProfile', 'audioFamily', 'pickActive'] as const;
const SPLICED = spliceTestExports(SOURCE, EXPOSED);

interface Page {
  __PLUMA_TEST__: Record<string, (...args: unknown[]) => unknown>;
}

function fn(page: Page, name: string): (...args: unknown[]) => unknown {
  const f = page.__PLUMA_TEST__[name];
  if (typeof f !== 'function') {
    throw new Error(`出口里没有 ${name} —— assertTestExports 本应拦住这种情况`);
  }
  return f;
}

function boot(): Page {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown> & { eval: (s: string) => void };
  win.eval(SPLICED);
  assertTestExports(win, EXPOSED);
  return win as unknown as Page;
}

let page: Page;
beforeEach(() => {
  page = boot();
});

describe('codecFamily（真源码）', () => {
  it.each([
    ['hev1.1.6.L153.90', 'HEVC(hev1)'],
    ['hvc1.2.4.L153.90', 'HEVC(hvc1)'],
    ['av01.0.09M.08', 'AV1'],
    ['avc1.640032', 'H.264'],
    ['vp09.00.10.08', 'VP9'],
  ])('%s → %s', (codec, expected) => {
    expect(fn(page, 'codecFamily')(codec)).toBe(expected);
  });

  it('未知编码归到 other', () => {
    expect(fn(page, 'codecFamily')('weird-codec')).toBe('other');
  });

  it('空 / ? 归到 unknown', () => {
    expect(fn(page, 'codecFamily')('')).toBe('unknown');
    expect(fn(page, 'codecFamily')('?')).toBe('unknown');
  });

  it('hvc1 不等于杜比视界（只是 HEVC 的一种 tag）', () => {
    expect(fn(page, 'codecFamily')('hvc1.2.4.L153.90')).not.toContain('杜比');
  });
});

describe('hevcProfile（真源码）', () => {
  it('从 hvc1 提取档次', () => {
    expect(fn(page, 'hevcProfile')('hvc1.2.4.L153.90')).toBe('2.4.L153.90');
  });

  it('从 hev1 提取档次（不是 hvev1）', () => {
    expect(fn(page, 'hevcProfile')('hev1.1.6.L153.90')).toBe('1.6.L153.90');
  });

  it('非 HEVC 返回 ?', () => {
    expect(fn(page, 'hevcProfile')('avc1.640032')).toBe('?');
    expect(fn(page, 'hevcProfile')('')).toBe('?');
  });

  it('L153 与 L156 是两个不同档次', () => {
    expect(fn(page, 'hevcProfile')('hvc1.2.4.L153.90')).not.toBe(
      fn(page, 'hevcProfile')('hvc1.2.4.L156.90'),
    );
  });
});

describe('audioFamily（真源码）', () => {
  it.each([
    ['fLaC', 'FLAC'],
    ['ec-3', 'Dolby(EC-3)'],
    ['ac-3', 'Dolby(EC-3)'],
    ['alac', 'ALAC'],
    ['opus', 'Opus'],
  ])('%s → %s', (codec, expected) => {
    expect(fn(page, 'audioFamily')(codec)).toBe(expected);
  });

  it('AAC 各级能区分', () => {
    expect(fn(page, 'audioFamily')('mp4a.40.5')).toBe('HE-AAC');
    expect(fn(page, 'audioFamily')('mp4a.40.2')).toBe('AAC-LC');
  });

  it('mp4a.40.29 不被误判成 HE-AAC（$|\\. 收尾）', () => {
    expect(fn(page, 'audioFamily')('mp4a.40.29')).not.toBe('HE-AAC');
  });

  it('未知返回 other', () => {
    expect(fn(page, 'audioFamily')('nope')).toBe('other');
  });
});

describe('pickActive（真源码 —— 旧复刻版在这一组上已经漂移）', () => {
  /**
   * ## 真实现是 `list[list.length - 1]`
   *
   * 旧复刻版写的是"按 lastUpdate 时间戳挑最近写入的"，
   * 两者在当前代码下**结论不同**：
   *   - 列表 `[{codec:'a', lastUpdate:3000}, {codec:'b', lastUpdate:1000}]`
   *   - 真实现 → `'b'`（取最后一条）
   *   - 旧复刻 → `'a'`（时间戳最大）
   *
   * 所以下面这组用例**断言的是真实现的行为**，与旧文件相反。
   */
  it('取列表最后一条（不是时间戳最大那条）', () => {
    const list = [
      { codec: 'mp4a.40.2', lastUpdate: 3000 },
      { codec: 'flac', lastUpdate: 1000 },
    ];
    expect(fn(page, 'pickActive')(list)).toEqual({ codec: 'flac', lastUpdate: 1000 });
  });

  it('与 lastUpdate 无关（0 也照取）', () => {
    const list = [
      { codec: 'a', lastUpdate: 0 },
      { codec: 'b', lastUpdate: 0 },
    ];
    expect(fn(page, 'pickActive')(list)).toEqual({ codec: 'b', lastUpdate: 0 });
  });

  it('返回**整个条目**（调用方自己取 .codec —— 见 activeCodec）', () => {
    /**
     * 旧复刻版返回的是 `codec` 字符串，真实现返回条目对象。
     * 这是漂移的又一处证据：两者接口都不同。
     */
    const entry = { codec: 'x', lastUpdate: 1 };
    expect(fn(page, 'pickActive')([entry])).toEqual(entry);
  });

  it('空列表 / null 返回 null（不是 ?）', () => {
    expect(fn(page, 'pickActive')([])).toBeNull();
    expect(fn(page, 'pickActive')(null)).toBeNull();
  });

  it('单元素返回它自己', () => {
    expect(fn(page, 'pickActive')([{ codec: 'x', lastUpdate: 1 }])).toEqual({
      codec: 'x',
      lastUpdate: 1,
    });
  });
});
