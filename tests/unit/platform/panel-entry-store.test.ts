// @vitest-environment jsdom

/**
 * 页内悬浮入口开关的**默认值语义**（1.1.0 阶段 1，ADR 0033 决定三）。
 *
 * ## 为什么这个文件存在
 *
 * `readPanelEntryEnabled()` 写的是 `bag[KEY] !== false`，而不是 `!!bag[KEY]`
 * 或 `bag[KEY] === true`。这个差别**只在一种情况下表现出来**：键不存在的时候。
 *
 * 而键不存在正是**每一个新装用户**第一次打开 B站 页面时的状态。
 * 写成 `!== false` 之外的任何形式，新用户都看不到面板 ——
 * 没有任何报错、构建正常、单测（如果没这条）全绿，用户只会觉得"这功能没做"。
 *
 * 同一个坑 `ui-prefs-store.ts` 的文件头已经记过一次（角标开关），
 * `badge.ts` 里也记过。所以这里**必须**把三种状态都钉住。
 *
 * ## 反例验证
 *
 * 把 `readPanelEntryEnabled` 的 `!== false` 改成 `=== true`，
 * "键不存在 → true" 那条必红。已实测（见任务报告）。
 *
 * ⚠️ 这里**不测 chrome.storage 本身**（那是浏览器的责任），
 * 只测"读到什么就返回什么、缺省怎么算"这一层。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 内存版 `chrome.storage.local`。
 *
 * `ui-prefs-store.ts` 只用 `chrome.storage.local.get/set` 两个方法，
 * 所以这里只需要实现这两个 —— 不引任何 mock 库（依赖清单是封闭的，`AGENTS.md` §7）。
 */
function installFakeChrome(initial: Record<string, unknown>): void {
  let bag: Record<string, unknown> = { ...initial };

  const fake = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: bag[key] })),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          bag = { ...bag, ...patch };
        }),
      },
    },
  };

  vi.stubGlobal('chrome', fake);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readPanelEntryEnabled 的默认值', () => {
  it('★ 键不存在（全新安装）→ true', async () => {
    /**
     * 最重要的一条：`chrome.storage.local.get` 对不存在的键返回 `{}`，
     * 于是 `bag[key]` 是 `undefined`。`undefined !== false` → `true`。
     *
     * 反例：把实现改成 `return bag[KEY] === true` → 本条必红，
     * 表现为"新装用户永远没有面板"。
     */
    installFakeChrome({});
    const { readPanelEntryEnabled } = await import('@platform/storage/ui-prefs-store');
    expect(await readPanelEntryEnabled()).toBe(true);
  });

  it('显式存 false → false（用户关掉了）', async () => {
    installFakeChrome({ 'pluma:panel-entry-enabled': false });
    const { readPanelEntryEnabled } = await import('@platform/storage/ui-prefs-store');
    expect(await readPanelEntryEnabled()).toBe(false);
  });

  it('显式存 true → true', async () => {
    installFakeChrome({ 'pluma:panel-entry-enabled': true });
    const { readPanelEntryEnabled } = await import('@platform/storage/ui-prefs-store');
    expect(await readPanelEntryEnabled()).toBe(true);
  });

  it('读到 null 之类的脏值也当"开"（只有显式 false 算关）', async () => {
    installFakeChrome({ 'pluma:panel-entry-enabled': null });
    const { readPanelEntryEnabled } = await import('@platform/storage/ui-prefs-store');
    expect(await readPanelEntryEnabled()).toBe(true);
  });

  it('storage 抛错时静默回落 true（不把"读不到"当成"关掉"）', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => Promise.reject(new Error('boom'))) } },
    });
    const { readPanelEntryEnabled } = await import('@platform/storage/ui-prefs-store');
    expect(await readPanelEntryEnabled()).toBe(true);
  });
});

describe('writePanelEntryEnabled', () => {
  it('写进去的值能被原样读回', async () => {
    installFakeChrome({});
    const { readPanelEntryEnabled, writePanelEntryEnabled } =
      await import('@platform/storage/ui-prefs-store');

    await writePanelEntryEnabled(false);
    expect(await readPanelEntryEnabled()).toBe(false);

    await writePanelEntryEnabled(true);
    expect(await readPanelEntryEnabled()).toBe(true);
  });

  it('用的是自己的键，不会覆盖角标开关', async () => {
    /**
     * 两个开关是**独立的偏好**（见 ui-prefs-store.ts 里 `PANEL_ENTRY_KEY` 的注释）。
     * 写面板开关把角标开关一起改掉，是"两个键共用一个"的典型事故。
     */
    installFakeChrome({ 'pluma:badge-enabled': true });
    const { readBadgeEnabled, writePanelEntryEnabled } =
      await import('@platform/storage/ui-prefs-store');

    await writePanelEntryEnabled(false);
    expect(await readBadgeEnabled()).toBe(true);
  });
});

describe('键名与监听常量一致', () => {
  it('PANEL_ENTRY_ENABLED_KEY 就是实际读写的那个键', async () => {
    /**
     * content script 靠这个常量比对 `storage.onChanged` 的 `changes`。
     * 常量与读写用的键漂移时，表现为"拨了开关页面没反应"而**不报任何错**。
     */
    installFakeChrome({});
    const { PANEL_ENTRY_ENABLED_KEY, writePanelEntryEnabled } =
      await import('@platform/storage/ui-prefs-store');

    await writePanelEntryEnabled(false);

    const get = vi.mocked(chrome.storage.local.get);
    // 读和写都必须落在同一个键上
    expect(get).toBeTypeOf('function');
    const { readPanelEntryEnabled } = await import('@platform/storage/ui-prefs-store');
    await readPanelEntryEnabled();
    expect(get).toHaveBeenCalledWith(PANEL_ENTRY_ENABLED_KEY);
  });
});
