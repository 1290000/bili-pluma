// @vitest-environment jsdom

/**
 * 面板的**读—改—写**与**写完主动应用**（1.1.0 阶段 2，T4 / T5）。
 *
 * ## 为什么这个文件是整个阶段最重要的一个
 *
 * `writeCleanOptionFlags()` 是**整块覆盖**（`ui-prefs-store.ts` 的注释有完整出处），
 * 而面板与设置页是**两个写者**。面板只要少带一个键，
 * 用户在设置页调好的那个开关就会**静默回到缺省值**。
 *
 * 这种事故的形状：
 *   - 没有报错
 *   - 没有测试变红（如果没写本文件）
 *   - 用户只觉得"我明明设过 / 怎么又变回去了"
 *
 * 所以这里不是在测"函数能跑"，是在测**"其余键一个都不能丢"**。
 *
 * ## 两条必须钉住的判据
 *
 * | 判据 | 反例（改坏了会怎样） |
 * | --- | --- |
 * | 写前**重新读** | 用旧快照改写 → 覆盖掉别处刚做的修改 |
 * | 写完**主动应用** | 只发 storage 事件 → 广告那一侧没有监听器，用户点了没反应 |
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountPanelBody } from '../../../src/content/panel/panel';
import type { PanelModel } from '../../../src/content/panel/panel-data';
import { DEFAULT_CLEAN_OPTIONS } from '../../../src/content/site-clean/clean-options';

/**
 * ⚠️ `vi.mock` 的工厂函数会被**提升到文件顶部**，所以它引用的变量必须用
 * `vi.hoisted()` 先建出来 —— 直接写 `const writeFlags = vi.fn()` 会报
 * "Cannot access 'writeFlags' before initialization"（已实测踩到）。
 */
const mocks = vi.hoisted(() => ({
  writeFlags: vi.fn(async (_o: Record<string, boolean>) => undefined),
  writeCats: vi.fn(async (_c: string[]) => undefined),
  applyAdClean: vi.fn(),
  applyHomeClean: vi.fn(),
  sendMessage: vi.fn(async (_m: unknown) => ({ type: 'proxy/set:ok' }) as unknown),
  /** 存储里那份原始值 —— 每次写都更新，模拟真实存储 */
  store: { current: {} as Record<string, unknown> },
}));

const { writeFlags, writeCats, applyAdClean, applyHomeClean } = mocks;
const store = mocks.store;

vi.mock('@platform/storage/ui-prefs-store', () => ({
  readRawCleanOptions: async () => mocks.store.current['pluma:clean-options'],
  writeCleanOptionFlags: mocks.writeFlags,
  writeCleanHideCategories: mocks.writeCats,
  // 阶段 3 新增：角标开关迁入净化 Tab
  readBadgeEnabled: async () => true,
  writeBadgeEnabled: async () => undefined,
}));

/** 阶段 3：诊断浮层的数据源也要 mock 掉（本文件不测诊断） */
vi.mock('@platform/diagnostics/collect', () => ({
  collectFacts: async () => [],
  tipFor: () => '',
}));

vi.mock('@platform/storage/diag-store', () => ({
  readDiag: async () => [],
}));

vi.mock('../../../src/content/site-clean/ads', () => ({
  applyAdClean: (...a: unknown[]) => mocks.applyAdClean(...a),
}));

vi.mock('../../../src/content/site-clean/home-clean', () => ({
  applyHomeClean: (...a: unknown[]) => mocks.applyHomeClean(...a),
}));

/** 完整的偏好模型（面板要能画出净化 Tab） */
function model(overrides: Partial<PanelModel> = {}): PanelModel {
  return {
    quality: {
      pill: '未生效',
      tone: 'neutral',
      line: null,
      unlock: null,
      proxyEnabled: true,
      pageKind: 'other',
    },
    clean: { options: { ...DEFAULT_CLEAN_OPTIONS }, hideCategories: [] },
    account: {
      primary: { uname: null, level: null, loggedIn: 'unknown', source: 'none' },
      playback: null,
      unknown: false,
      hasCredential: true,
      needsLogin: false,
    },
    pageKind: 'other',
    pageStateKind: 'ok',
    pageView: null,
    ...overrides,
  };
}

/** 让挂起的 microtask 跑完（写入是 async 的） */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  store.current = {};
  // `chrome.runtime.sendMessage` 给所有动作兜底（toggleProxy / 重取模型）
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: mocks.sendMessage },
    storage: { onChanged: { addListener: () => undefined, removeListener: () => undefined } },
  };
});

/** 切到净化 Tab 并点某个开关 */
async function toggleClean(label: string, next: boolean): Promise<void> {
  const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
  c.setModel(model());
  c.showTab('clean');

  for (const row of c.root.querySelectorAll('.row')) {
    const text = row.querySelector('.row-label')?.firstElementChild?.textContent;
    if (text !== label) continue;
    const cb = row.querySelector('input');
    if (!cb) throw new Error(`「${label}」没有 checkbox`);
    cb.checked = next;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    break;
  }
  await flush();
}

describe('★ 读—改—写：只改一个键，其余三个必须原样写回', () => {
  it('存储里已有非默认值时，改 adEnabled 不会重置另外三个', async () => {
    /**
     * 初始值刻意全部**偏离默认**（默认是 false, false, false, false）。
     * 反例：把 `writeOption` 里的 `normalizeCleanPreferences(await readRawCleanOptions())`
     * 换成复用 `model.clean`（旧快照）→ 如果旧快照过期，本条仍可能通过；
     * 把 `patchCleanOption` 换成 `{[key]: next}` → 本条必红（只剩一个键）。
     */
    store.current['pluma:clean-options'] = {
      options: {
        adEnabled: false,
        adPreserveEventBanner: true,
        adDebug: true,
        homeHideSwipe: true,
      },
      hideCategories: ['番剧'],
    };

    await toggleClean('删除广告', true);

    expect(writeFlags).toHaveBeenCalledTimes(1);
    const written = writeFlags.mock.calls[0]?.[0] as Record<string, boolean>;

    // 改的那一个变了
    expect(written.adEnabled).toBe(true);
    // ★ 另外三个原样保留
    expect(written.adPreserveEventBanner).toBe(true);
    expect(written.adDebug).toBe(true);
    expect(written.homeHideSwipe).toBe(true);
    // 四个键一个都不能少
    expect(Object.keys(written).sort()).toEqual(
      ['adDebug', 'adEnabled', 'adPreserveEventBanner', 'homeHideSwipe'].sort(),
    );
  });

  it('★ 写前重新读：别处刚改的值不能被旧快照覆盖', async () => {
    /**
     * 场景：面板打开时 `model.clean` 是 `{adEnabled:false, adDebug:false}`，
     * 用户在**另一个标签页的设置页**里把 `adDebug` 打开了，然后回面板点「删除广告」。
     *
     * 正确行为：重新读到 `adDebug:true` 并写回。
     * 反例：复用 `model.clean`（`adDebug:false`）→ 用户的设置被静默回滚。
     *
     * 这里让 `model` 与 `store` **不一致**来模拟那个时间差。
     */
    store.current['pluma:clean-options'] = {
      options: {
        adEnabled: false,
        adPreserveEventBanner: false,
        adDebug: true,
        homeHideSwipe: false,
      },
      hideCategories: [],
    };
    const stale = model({
      clean: {
        // 旧快照：adDebug 还是关的
        options: { ...DEFAULT_CLEAN_OPTIONS, adDebug: false },
        hideCategories: [],
      },
    });

    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(stale);
    c.showTab('clean');
    // 面板上显示的是旧快照（adDebug 关）—— 但写回时必须用存储里的新值
    for (const row of c.root.querySelectorAll('.row')) {
      const text = row.querySelector('.row-label')?.firstElementChild?.textContent;
      if (text !== '删除广告') continue;
      const cb = row.querySelector('input');
      if (!cb) throw new Error('没找到删除广告');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    await flush();

    const written = writeFlags.mock.calls[0]?.[0] as Record<string, boolean>;
    expect(written.adEnabled).toBe(true);
    // ★ 存储里的 true 被保留，旧快照的 false 没有覆盖它
    expect(written.adDebug).toBe(true);
  });

  it('分类切换走另一半写入，且不碰布尔项', async () => {
    store.current['pluma:clean-options'] = {
      options: {
        adEnabled: true,
        adPreserveEventBanner: true,
        adDebug: false,
        homeHideSwipe: true,
      },
      hideCategories: [],
    };

    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('clean');
    // 进入二级浮层
    c.root.querySelector('.sub-entry')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    for (const row of c.root.querySelectorAll('.row')) {
      const text = row.querySelector('.row-label')?.firstElementChild?.textContent;
      if (text !== '番剧') continue;
      const cb = row.querySelector('input');
      if (!cb) throw new Error('没找到番剧');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    await flush();

    expect(writeCats).toHaveBeenCalledTimes(1);
    expect(writeCats.mock.calls[0]?.[0]).toEqual(['番剧']);
    // ⚠️ 分类写入**不许**动布尔项（那会调 writeCleanOptionFlags）
    expect(writeFlags).not.toHaveBeenCalled();
  });
});

describe('★ T5 写完必须主动应用', () => {
  it('改布尔开关后调了 applyAdClean 与 applyHomeClean', async () => {
    /**
     * 反例：把 `applyCleanNow()` 从 `writeOption` 里删掉 → 本条必红。
     * 后果是用户点了开关**页面上没反应**（广告那一侧没有 storage 监听器）。
     */
    store.current['pluma:clean-options'] = {
      options: { ...DEFAULT_CLEAN_OPTIONS },
      hideCategories: [],
    };

    await toggleClean('删除广告', true);

    expect(applyAdClean).toHaveBeenCalled();
    expect(applyHomeClean).toHaveBeenCalled();
  });

  it('应用时用的是**刚写下的**偏好（不是旧值）', async () => {
    /**
     * `applyCleanNow()` 内部重新读一次 storage。写入的 mock 必须更新 store，
     * 否则这里会读到旧值 —— 那条"读—改—写"的纪律在**应用**这一步同样成立。
     */
    store.current['pluma:clean-options'] = {
      options: { ...DEFAULT_CLEAN_OPTIONS },
      hideCategories: [],
    };
    writeFlags.mockImplementation(async (o: Record<string, boolean>) => {
      store.current['pluma:clean-options'] = {
        ...(store.current['pluma:clean-options'] as object),
        options: o,
      };
    });

    await toggleClean('删除广告', true);

    const opts = applyAdClean.mock.calls[0]?.[0] as Record<string, boolean> | undefined;
    expect(opts?.adEnabled).toBe(true);
  });
});

describe('Tab 与返回栈', () => {
  it('默认在画质 Tab，切 Tab 生效', () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    expect(c.currentTab()).toBe('quality');
    expect(c.depth()).toBe(0);

    c.showTab('account');
    expect(c.currentTab()).toBe('account');
  });

  it('★ 进入二级浮层会压栈，返回会弹栈', async () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('clean');

    c.root.querySelector('.sub-entry')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(c.depth()).toBe(1);
    expect(c.root.querySelector('.sub-bar')).not.toBeNull();

    c.root.querySelector('.sub-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(c.depth()).toBe(0);
    expect(c.root.querySelector('.sub-bar')).toBeNull();
  });

  it('★ 切 Tab 会清栈（用户点 Tab 是"看那个 Tab"，不是"在浮层里切后台"）', async () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('clean');
    c.root.querySelector('.sub-entry')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(c.depth()).toBe(1);

    c.showTab('quality');
    expect(c.depth()).toBe(0);
  });

  it('模型还没到时不崩，显示"正在读取…"', () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    expect(c.root.textContent).toContain('正在读取');
  });
});
