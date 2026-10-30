// @vitest-environment jsdom
/**
 * `main-world.js` 纯函数直接测试（阶段 4 · S4.1）
 *
 * ## 为什么需要这个文件（和 `main-world-progress.test.ts` 的区别）
 *
 * 那个文件走**整条 XHR hook 链**驱动，覆盖的是"端到端行为"。
 * 但对**单个判断函数的边界**（比如 `matchPath` 的三重判定、`catch` 分支）
 * 很难只靠链路构造出来。
 *
 * 这里用测试侧拼接（`helpers/main-world-exports.ts`）把 IIFE 内的纯函数取出来直接调，
 * **改 0 行被测代码**。
 *
 * ## ⚠️ 假通过防线
 *
 * 每次 eval 之后都调 `assertTestExports()`。拼接失效时它会 **throw**，
 * 不会让断言拿到 `undefined` 后安静通过。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';

import { assertTestExports, spliceTestExports } from './helpers/main-world-exports';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');
const SPLICED = spliceTestExports(SOURCE);

interface Page {
  __PLUMA_TEST__: Record<string, (...args: unknown[]) => unknown>;
}

/**
 * 取出口函数。
 *
 * `assertTestExports()` 已经保证这些名字都是 function —— 但 TS 看不到那层保证
 * （`Record` 索引签名返回 `| undefined`），这里显式收窄。
 * **运行时保障来自 assertTestExports，不是靠这里的 `!` 掩盖缺失。**
 */
function fn(page: Page, name: string): (...args: unknown[]) => unknown {
  const f = page.__PLUMA_TEST__[name];
  if (typeof f !== 'function') {
    throw new Error(`出口里没有 ${name} —— assertTestExports 本应拦住这种情况`);
  }
  return f;
}

/** 建页面 + eval 拼接源码 + 强制自检 */
function boot(url = 'https://www.bilibili.com/video/BV1xx411c7mD'): Page {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url,
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown> & {
    eval: (s: string) => void;
  };
  win.eval(SPLICED);
  // 失败即 throw，绝不让测试带着 undefined 继续跑
  assertTestExports(win);
  return win as unknown as Page;
}

describe('matchPath（S4.1 直接覆盖）', () => {
  const PATCH_PATHS = ['/x/v2/view', '/pgc/player/web/playurl'];

  let page: Page;
  beforeEach(() => {
    page = boot();
  });

  describe('三重判定：协议 / 主机 / 路径', () => {
    it('三项都对 → true', () => {
      expect(fn(page, 'matchPath')('https://api.bilibili.com/x/v2/view', PATCH_PATHS)).toBe(true);
    });

    it('协议不是 https → false（http 不放行）', () => {
      expect(fn(page, 'matchPath')('http://api.bilibili.com/x/v2/view', PATCH_PATHS)).toBe(false);
    });

    it('主机不在 PATCH_HOSTS → false', () => {
      expect(fn(page, 'matchPath')('https://evil.example.com/x/v2/view', PATCH_PATHS)).toBe(false);
    });

    it('路径不在清单里 → false', () => {
      expect(fn(page, 'matchPath')('https://api.bilibili.com/x/other', PATCH_PATHS)).toBe(false);
    });

    it('备选域名 api.biliapi.net 必须放行（2026-10-29 真机事故）', () => {
      /**
       * 播放器对同一次画质切换会**同时**向两个域名发请求并采用备选那条的结果。
       * 只写主域名 → 备选那条不改写 → 播放器判「无权限」→ 点 4K 菜单变了画面没变。
       */
      expect(fn(page, 'matchPath')('https://api.biliapi.net/x/v2/view', PATCH_PATHS)).toBe(true);
    });
  });

  describe('路径必须精确匹配（不是前缀）', () => {
    it('/x/v2/viewXxx 不匹配 /x/v2/view', () => {
      expect(fn(page, 'matchPath')('https://api.bilibili.com/x/v2/viewXxx', PATCH_PATHS)).toBe(
        false,
      );
    });

    it('query 不影响匹配（比的是 pathname）', () => {
      expect(
        fn(page, 'matchPath')('https://api.bilibili.com/x/v2/view?aid=1&cid=2', PATCH_PATHS),
      ).toBe(true);
    });
  });

  describe('异常一律返回 false（不抛）', () => {
    it('畸形 URL → false', () => {
      expect(() => fn(page, 'matchPath')('http://[::bad', PATCH_PATHS)).not.toThrow();
      expect(fn(page, 'matchPath')('http://[::bad', PATCH_PATHS)).toBe(false);
    });

    it('空清单 → false', () => {
      expect(fn(page, 'matchPath')('https://api.bilibili.com/x/v2/view', [])).toBe(false);
    });

    it('null / undefined 输入 → false，不抛', () => {
      expect(fn(page, 'matchPath')(null, PATCH_PATHS)).toBe(false);
      expect(fn(page, 'matchPath')(undefined, PATCH_PATHS)).toBe(false);
    });
  });
});

describe('applyProgressToJson（S4.1 直接覆盖，补链路测不到的边界）', () => {
  let page: Page;
  beforeEach(() => {
    page = boot();
  });

  const PROG = { time: 137, cid: 999 };

  it('正常改写并返回新文本', () => {
    const raw = JSON.stringify({ data: { last_play_time: 0, last_play_cid: 0 } });
    const out = fn(page, 'applyProgressToJson')(raw, PROG) as string;

    expect(JSON.parse(out).data).toEqual({ last_play_time: 137, last_play_cid: 999 });
  });

  it('last_play_time 不是 number → 返回 null（闸门 0）', () => {
    const raw = JSON.stringify({ data: { last_play_time: '0', last_play_cid: 0 } });
    expect(fn(page, 'applyProgressToJson')(raw, PROG)).toBeNull();
  });

  it('没有 data 段 → 返回 null', () => {
    expect(fn(page, 'applyProgressToJson')(JSON.stringify({ result: {} }), PROG)).toBeNull();
  });

  it('两值已相同 → 返回 null（幂等，不重复改写）', () => {
    const raw = JSON.stringify({ data: { last_play_time: 137, last_play_cid: 999 } });
    expect(fn(page, 'applyProgressToJson')(raw, PROG)).toBeNull();
  });

  it('非法 JSON → 返回 null，不抛', () => {
    expect(fn(page, 'applyProgressToJson')('{bad json', PROG)).toBeNull();
  });

  it('空串 → 返回 null，不抛', () => {
    expect(fn(page, 'applyProgressToJson')('', PROG)).toBeNull();
  });

  it('其它字段逐字保留', () => {
    const raw = JSON.stringify({
      data: { last_play_time: 0, last_play_cid: 0, dash: { video: [1, 2] }, accept_quality: [80] },
    });
    const parsed = JSON.parse(fn(page, 'applyProgressToJson')(raw, PROG) as string);

    expect(parsed.data.dash).toEqual({ video: [1, 2] });
    expect(parsed.data.accept_quality).toEqual([80]);
  });
});
