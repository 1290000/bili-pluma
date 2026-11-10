// @vitest-environment jsdom

/**
 * 诊断浮层的**接线**测试（阶段 3）。
 *
 * ## 为什么需要这个文件
 *
 * `panel-diagnostics-export.test.ts` 测的是导出**内容**的安全性，
 * 但没有验证"进得去、拉得到、画得出来"这条链路。
 * 阶段 3 新增了一整条二级浮层路径（`openDiag` → `ensureDiag` → `diagnosticsPane`），
 * 任何一环断了都表现为"点了没反应"。
 *
 * ## 守什么
 *
 * | 场景 | 必须 |
 * | --- | --- |
 * | 点「诊断」 | 压栈、进入浮层 |
 * | 进入后 | **懒加载** `collectFacts()` 且**传 `pageView: null`**（不能传 undefined） |
 * | 数据到了 | 画出自检行与日志 |
 * | 点返回 | 弹栈回净化 Tab |
 * | 角标开关 | 懒读 + 写入 |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectFacts: vi.fn(),
  readDiag: vi.fn(),
  tipFor: vi.fn(),
  readBadgeEnabled: vi.fn(),
  writeBadgeEnabled: vi.fn(),
  readRawCleanOptions: vi.fn(),
}));

vi.mock('@platform/diagnostics/collect', () => ({
  collectFacts: (...a: unknown[]) => mocks.collectFacts(...a),
  tipFor: (...a: unknown[]) => mocks.tipFor(...a),
  /** 第八轮：echo 回显走模块级变量，不经 storage */
  readLastDiagEcho: () => null,
}));

vi.mock('@platform/storage/diag-store', () => ({
  readDiag: (...a: unknown[]) => mocks.readDiag(...a),
  /** 第七轮新增的定位追踪通道 */
  readDiagTrace: async () => null,
}));

vi.mock('@platform/storage/ui-prefs-store', () => ({
  readRawCleanOptions: (...a: unknown[]) => mocks.readRawCleanOptions(...a),
  writeCleanOptionFlags: async () => undefined,
  writeCleanHideCategories: async () => undefined,
  readBadgeEnabled: (...a: unknown[]) => mocks.readBadgeEnabled(...a),
  writeBadgeEnabled: (...a: unknown[]) => mocks.writeBadgeEnabled(...a),
}));

vi.mock('../../../src/content/site-clean/ads', () => ({ applyAdClean: () => undefined }));
vi.mock('../../../src/content/site-clean/home-clean', () => ({ applyHomeClean: () => undefined }));

import { mountPanelBody } from '../../../src/content/panel/panel';
import { mountSidebar } from '../../../src/content/panel/sidebar';
import type { PanelModel } from '../../../src/content/panel/panel-data';

function model(): PanelModel {
  return {
    quality: {
      pill: '未生效',
      tone: 'neutral',
      line: null,
      unlock: null,
      proxyEnabled: true,
      pageKind: 'other',
    },
    clean: {
      options: {
        adEnabled: false,
        adPreserveEventBanner: false,
        adDebug: false,
        homeHideSwipe: false,
      },
      hideCategories: [],
    },
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
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** 只推微任务（模拟"点了但请求还没回来"的瞬间） */
async function flash(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.collectFacts.mockResolvedValue([{ label: 'InPrivate 权限', value: '已允许', ok: true }]);
  mocks.readDiag.mockResolvedValue([{ at: 1, step: 'panel/page-state', detail: 'kind=ok' }]);
  mocks.tipFor.mockReturnValue('规则齐全。');
  mocks.readBadgeEnabled.mockResolvedValue(true);
  mocks.readRawCleanOptions.mockResolvedValue({});
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '0.0.0-test' }), sendMessage: async () => null },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = '';
});

describe('★ 诊断浮层接线', () => {
  it('★ 点「诊断」进入二级浮层，并懒加载 collectFacts', async () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('display');

    // 进入前**不应**拉数据（懒加载）
    expect(mocks.collectFacts).not.toHaveBeenCalled();

    // 找「诊断」入口并点
    const entries = [...c.root.querySelectorAll('.sub-entry')];
    const diagEntry = entries.find((e) => e.textContent?.includes('诊断'));
    expect(diagEntry, '没找到诊断入口').toBeDefined();
    diagEntry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(c.depth()).toBe(1);
    await flush();
    expect(mocks.collectFacts).toHaveBeenCalledTimes(1);
  });

  it('★★ collectFacts 收到的是 pageView: null，不是 undefined', async () => {
    /**
     * 这是本阶段最容易写错的一条：不传参数（`undefined`）会让 `collectFacts`
     * 用 `chrome.tabs.query` 去找**别的**视频标签页，诊断页就显示别人的数据。
     *
     * 反例：把 `{ pageView: model?.pageView ?? null }` 改成 `collectFacts()` → 本条必红。
     */
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('display');
    const diagEntry = [...c.root.querySelectorAll('.sub-entry')].find((e) =>
      e.textContent?.includes('诊断'),
    );
    diagEntry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(mocks.collectFacts).toHaveBeenCalledTimes(1);
    const arg = mocks.collectFacts.mock.calls[0]?.[0] as { pageView?: unknown } | undefined;
    expect(arg, 'collectFacts 调用缺少参数对象').toBeDefined();
    expect('pageView' in (arg ?? {})).toBe(true);
    // ★ 必须是显式 null，不能是 undefined
    expect(arg?.pageView).toBeNull();
  });

  it('数据到了之后画出自检行与日志', async () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('display');
    const diagEntry = [...c.root.querySelectorAll('.sub-entry')].find((e) =>
      e.textContent?.includes('诊断'),
    );
    diagEntry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(c.root.textContent).toContain('InPrivate 权限');
    expect(c.root.textContent).toContain('已允许');
    // 日志里的 panel/page-state 要出现（阶段 3 的目的之一）
    expect(c.root.textContent).toContain('panel/page-state');
  });

  it('★ 点返回弹栈，回到净化 Tab', async () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('display');
    const diagEntry = [...c.root.querySelectorAll('.sub-entry')].find((e) =>
      e.textContent?.includes('诊断'),
    );
    diagEntry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(c.depth()).toBe(1);

    c.root.querySelector('.sub-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(c.depth()).toBe(0);
  });

  it('ok===true 的行带 ok class（绿），ok===false 带 bad（红）', async () => {
    mocks.collectFacts.mockResolvedValue([
      { label: '好', value: 'a', ok: true },
      { label: '坏', value: 'b', ok: false },
      { label: '中性', value: 'c' },
    ]);
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('display');
    [...c.root.querySelectorAll('.sub-entry')]
      .find((e) => e.textContent?.includes('诊断'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(c.root.querySelector('.diag-row.ok')).not.toBeNull();
    expect(c.root.querySelector('.diag-row.bad')).not.toBeNull();
    // 中性行既不是 ok 也不是 bad
    const rows = [...c.root.querySelectorAll('.diag-row')];
    expect(
      rows.filter((r) => !r.classList.contains('ok') && !r.classList.contains('bad')).length,
    ).toBe(1);
  });

  /**
   * ## 每次进入都要重取（2026-11-10 第七轮）
   *
   * smoke 实测：第二次进诊断浮层（隔 6 秒）**没有任何新增的 `diag/facts` 日志**
   * ——说明原实现 `if (diagData !== null) return` 只在首次拉过一次。
   *
   * 后果：**一次失败后永远显示旧结果**。诊断工具最要紧的就是"现在这一刻"。
   */
  function enterDiag(c: ReturnType<typeof mountPanelBody>): void {
    [...c.root.querySelectorAll('.sub-entry')]
      .find((e) => e.textContent?.includes('诊断'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  it('★★ 第二次进入诊断浮层会**重新**取数（不是只拉一次）', async () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('display');

    enterDiag(c);
    await flush();
    expect(mocks.collectFacts).toHaveBeenCalledTimes(1);

    // 返回，再进一次
    c.root.querySelector('.sub-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    enterDiag(c);
    await flush();

    // ★ 必须第二次也拉了
    expect(mocks.collectFacts).toHaveBeenCalledTimes(2);
  });

  it('★ 点「⟳」刷新按钮会重新取数', async () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('display');
    enterDiag(c);
    await flush();
    expect(mocks.collectFacts).toHaveBeenCalledTimes(1);

    // 找刷新按钮（aria-label="重新采集"）
    const refresh = c.root.querySelector('[aria-label="重新采集"]');
    expect(refresh, '没找到刷新按钮').not.toBeNull();
    refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(mocks.collectFacts).toHaveBeenCalledTimes(2);
  });

  it('多次刷新不会并发堆积（in-flight 去重）', async () => {
    /**
     * `loadDiag` 里有 `if (diagLoading) return`。
     * 连点刷新不应该同时发出多个请求。
     */
    /** 显式标注类型，否则 TS 会把闭包里的赋值收窄成 never */
    let release: (() => void) | undefined;
    mocks.collectFacts.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => {
            r([{ label: 'x', value: 'y', ok: true }]);
          };
        }),
    );
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('display');
    enterDiag(c);
    await flush();
    expect(mocks.collectFacts).toHaveBeenCalledTimes(1);

    // 在第一次还没回来时，连点刷新
    for (let i = 0; i < 3; i += 1) {
      c.root
        .querySelector('[aria-label="重新采集"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flash();
    }
    // 仍只有第一次那次（in-flight 去重）
    expect(mocks.collectFacts).toHaveBeenCalledTimes(1);

    release?.();
    await flush();
    // 能走到这里说明没有并发堆积
    expect(true).toBe(true);
  }, 10_000);
});

describe('★ 端到端：点「诊断」后不会收起（2026-11-10 真机 bug 修复）', () => {
  /**
   * ## 用户报的原话
   *
   * > 「点击诊断、账号等按钮时面板会直接消失，而不会直接跳转到对应的界面，
   * > 需要再次唤起面板才能显示」
   *
   * ## 这条测什么
   *
   * `panel.ts` 的 `openDiag()` 只负责压栈 + 重取，**它不管"面板是否还开着"**；
   * 开合由 `sidebar.ts` 的钉住态决定。两者分属不同文件，所以需要一条
   * **把它们接起来**的测试 —— 单测各自绿、真机不可用，正是上一轮的教训。
   */
  it('★★ 点「诊断 ▸」后：进入二级浮层，且面板仍在钉住态（不会因鼠标离开收起）', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const controller = mountPanelBody({
      login: () => undefined,
      logout: async () => ({ ok: true }),
    });
    controller.setModel(model());
    const sidebar = mountSidebar(shadow, { body: controller.root });
    controller.showTab('display');

    const panel = shadow.querySelector('.panel') as HTMLElement;
    // 悬停展开（预览态）
    panel.dispatchEvent(new MouseEvent('mouseenter'));
    expect(sidebar.isPinned()).toBe(false);

    // 点「诊断 ▸」—— 按钮在显示 Tab 里
    const diagEntry = [...controller.root.querySelectorAll('.sub-entry')].find((e) =>
      e.textContent?.includes('诊断'),
    );
    expect(diagEntry, '显示 Tab 里没有诊断入口').toBeDefined();
    diagEntry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // 进入了二级浮层
    expect(controller.depth()).toBe(1);
    // ★ 而且面板被钉住了 —— 鼠标离开不会收起
    expect(sidebar.isPinned()).toBe(true);

    panel.dispatchEvent(new MouseEvent('mouseleave'));
    expect(sidebar.isOpen(), '点完诊断，鼠标一离开面板就消失了 —— 正是用户报的 bug').toBe(true);

    sidebar.dispose();
  });
});

describe('★ 角标开关接线', () => {
  it('★ 进净化 Tab 才懒读角标开关', async () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    // 默认在画质 Tab：不应读
    await flush();
    expect(mocks.readBadgeEnabled).not.toHaveBeenCalled();

    c.showTab('display');
    await flush();
    expect(mocks.readBadgeEnabled).toHaveBeenCalledTimes(1);
  });

  it('★ 拨开关会写入 storage', async () => {
    const c = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
    c.setModel(model());
    c.showTab('display');
    await flush();

    // 找「页内角标」那一行的 checkbox
    let target: HTMLInputElement | null = null;
    for (const row of c.root.querySelectorAll('.row')) {
      if (row.querySelector('.row-label')?.firstElementChild?.textContent === '页内角标') {
        target = row.querySelector('input');
      }
    }
    expect(target, '没找到页内角标开关').not.toBeNull();

    if (!target) return;
    target.checked = false;
    target.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(mocks.writeBadgeEnabled).toHaveBeenCalledWith(false);
  });
});
