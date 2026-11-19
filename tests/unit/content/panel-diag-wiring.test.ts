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
  readPcdnFilterEnabled: vi.fn(),
  writePcdnFilterEnabled: vi.fn(),
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
  /**
   * 2026-11-12（task-26）：`logsMeta` 需要这两个。
   *
   * ⚠️ **mock 里少导出会让 `panel.ts` 的探针直接抛** →
   * `logsMeta.ok = false` → 诊断页画"日志读取失败"而**不画 facts**。
   * 这批用例当时就是这么红的（5 条），表现是 `expected '正在采集…' to contain
   * 'InPrivate 权限'` —— 看现象像渲染坏了，实际是 mock 少了一个常量。
   */
  DIAG_LIMIT: 30,
  instanceId: () => 'test01',
}));

vi.mock('@platform/storage/ui-prefs-store', () => ({
  readRawCleanOptions: (...a: unknown[]) => mocks.readRawCleanOptions(...a),
  writeCleanOptionFlags: async () => undefined,
  writeCleanHideCategories: async () => undefined,
  readBadgeEnabled: (...a: unknown[]) => mocks.readBadgeEnabled(...a),
  writeBadgeEnabled: (...a: unknown[]) => mocks.writeBadgeEnabled(...a),
  readPcdnFilterEnabled: (...a: unknown[]) => mocks.readPcdnFilterEnabled(...a),
  writePcdnFilterEnabled: (...a: unknown[]) => mocks.writePcdnFilterEnabled(...a),
}));

vi.mock('../../../src/content/site-clean/ads', () => ({
  applyAdClean: () => undefined,
  /**
   * 面板渲染诊断页时会问一次广告命中数（`inspectAdClean`）。这几个用例测的是
   * 诊断**接线**（取数/弹栈/日志三态），与广告无关 —— 桩成"这页没广告位"
   * 即可，它只是让 `adCleanSection()` 画出一段安静的内容。
   * ⚠️ 不桩会直接抛 "No inspectAdClean export is defined on the mock"，
   * 那是 mock 不全，不是被测代码的问题。
   */
  inspectAdClean: () => ({
    candidates: 0,
    marked: 0,
    containerMissing: false,
    verdict: 'dead' as const,
  }),
}));
vi.mock('../../../src/content/site-clean/home-clean', () => ({ applyHomeClean: () => undefined }));

import { mountPanelBody } from '../../../src/content/panel/panel';
import { mountSidebar } from '../../../src/content/panel/sidebar';
import type { PanelModel } from '../../../src/content/panel/panel-data';

/**
 * 面板动作的公共默认值。
 *
 * `streamingIdentity: null` = **这些用例不关心取流身份胶囊**（它们测诊断接线）。
 * 显式传 `null` 而不是省略 —— 字段必填，"省略"与"明确没有"必须能区分。
 */
const ACTS = {
  login: () => undefined,
  logout: async () => ({ ok: true }),
  streamingIdentity: null,
  toggleStreamingIdentity: () => undefined,
  feedAccountEnabled: false,
  toggleFeedAccount: () => undefined,
  /** 本用例不关心重取时的身份来源（`undefined` = 还没读到，走既有判据） */
  currentStreamingIdentity: () => undefined,
} as const;

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
      proxyEnabled: true,
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
  /**
   * 屏蔽 PCDN 开关也走懒读，**必须给它一个 resolved Promise**。
   *
   * 漏了这条：`vi.fn()` 默认返回 `undefined`，`ensurePcdnFilterRead()` 里
   * `void readPcdnFilterEnabled().then(...)` 会抛 `Cannot read properties of
   * undefined (reading 'then')` —— 而这 14 条用例**全部**会因为进入「显示」Tab
   * 那一步连带红掉，看起来像是诊断接线坏了（实际是我们少给了一个 mock）。
   */
  mocks.readPcdnFilterEnabled.mockResolvedValue(false);
  mocks.readRawCleanOptions.mockResolvedValue({});
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '0.0.0-test' }), sendMessage: async () => null },
    /**
     * task-26 的存活探针（`probeLogsReadability()`）会调 `storage.local.get(null)`。
     * 这里必须提供 —— 缺了它就抛 → `logsMeta.ok=false` → 诊断页转去画失败态，
     * 这 11 条接线用例会集体变红（而且看起来像是渲染路径坏了）。
     */
    storage: { local: { get: async () => ({}) } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = '';
});

describe('★ 诊断浮层接线', () => {
  it('★ 点「诊断」进入二级浮层，并懒加载 collectFacts', async () => {
    const c = mountPanelBody(ACTS);
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
    const c = mountPanelBody(ACTS);
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
    const c = mountPanelBody(ACTS);
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
    const c = mountPanelBody(ACTS);
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
    const c = mountPanelBody(ACTS);
    c.setModel(model());
    c.showTab('display');
    [...c.root.querySelectorAll('.sub-entry')]
      .find((e) => e.textContent?.includes('诊断'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    /**
     * ⚠️ 断言必须**限定在 `.diag-facts`（自检信息那块）**里。
     *
     * 2026-11-17（T7）：诊断浮层在自检信息**之前**新增了「本次加载」区块，
     * 它也由 `factRow()` 拼出来（因此也是 `.diag-row`）。原来这三条按
     * `c.root.querySelectorAll('.diag-row')` 数全屏，于是把新块的那些行
     * 一起数了进去（中性行从 1 变 2）。
     *
     * 本用例的本意是"自检项的三种 ok 值各画成什么样"，**主语是自检信息**，
     * 所以收窄到 `.diag-facts` 不是放宽判据，是把它写准确 —— 顺带让以后
     * 再往这个浮层加行时不会误伤。
     */
    const facts = c.root.querySelector('.diag-facts');
    expect(facts).not.toBeNull();

    expect(facts?.querySelector('.diag-row.ok')).not.toBeNull();
    expect(facts?.querySelector('.diag-row.bad')).not.toBeNull();
    // 中性行既不是 ok 也不是 bad
    const rows = [...(facts?.querySelectorAll('.diag-row') ?? [])];
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
    const c = mountPanelBody(ACTS);
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
    const c = mountPanelBody(ACTS);
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
    const c = mountPanelBody(ACTS);
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
      ...ACTS,
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
    const c = mountPanelBody(ACTS);
    c.setModel(model());
    // 默认在画质 Tab：不应读
    await flush();
    expect(mocks.readBadgeEnabled).not.toHaveBeenCalled();

    c.showTab('display');
    await flush();
    expect(mocks.readBadgeEnabled).toHaveBeenCalledTimes(1);
  });

  it('★ 拨开关会写入 storage', async () => {
    const c = mountPanelBody(ACTS);
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

/**
 * ## ★★ 日志读失败必须**看得见**，而且不能长得像"没有日志"（2026-11-12，task-26）
 *
 * 用户在孤儿态（`Extension context invalidated`）下导出诊断，拿到 `"logs": []`
 * —— 和"这台机器真的一条日志都没记"**完全一样**。界面上也是同一个问题：
 * 旧实现只判 `logs.length === 0`，于是「读取失败」和「真的没有」都渲染成
 * 「还没有日志。」。
 *
 * 这两条守的是**用户最容易看到的那一眼**：
 * - 读失败 → 必须说"读取失败" + 给用户可执行的下一步（刷新页面）
 * - 真没有 → 才可以显示"还没有日志。"
 *
 * ⚠️ 判据是 `logsMeta.ok`，**不是** `logs.length`。若实现改成用 length 推，
 * 第一条必红（因为读失败时 logs 也是空数组）。
 */
describe('★★ 日志读失败 vs 真的没有日志（task-26）', () => {
  /** 进诊断浮层并等数据回来 */
  async function enterDiagAndFlush(c: ReturnType<typeof mountPanelBody>): Promise<void> {
    [...c.root.querySelectorAll('.sub-entry')]
      .find((e) => e.textContent?.includes('诊断'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
  }

  it('★★ 孤儿态：读不到时显示读取失败，不显示「还没有日志。」', async () => {
    /**
     * 模拟孤儿态：`chrome.storage` 整个不可用（真实表现就是抛这个固定串）。
     */
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '0.0.0-test' }), sendMessage: async () => null },
      storage: {
        local: {
          get: async () => {
            throw new Error('Extension context invalidated.');
          },
        },
      },
    });
    mocks.readDiag.mockResolvedValue([]);

    const c = mountPanelBody(ACTS);
    c.setModel(model());
    c.showTab('display');
    await enterDiagAndFlush(c);

    const text = c.root.textContent ?? '';
    expect(text, '读失败被渲染成了"还没有日志。"——这正是用户误判的成因').not.toContain(
      '还没有日志',
    );
    expect(text).toContain('诊断日志读取失败');
    // 必须给出用户能做的动作
    expect(text).toContain('刷新');
    // 自检事实仍然要画（失败的是日志通道，不是整页）
    expect(text).toContain('InPrivate 权限');
  });

  it('★ 真的没有日志时才显示「还没有日志。」', async () => {
    mocks.readDiag.mockResolvedValue([]);
    const c = mountPanelBody(ACTS);
    c.setModel(model());
    c.showTab('display');
    await enterDiagAndFlush(c);

    const text = c.root.textContent ?? '';
    expect(text).toContain('还没有日志');
    expect(text).not.toContain('诊断日志读取失败');
  });

  it('★★ 导出 JSON 里 `logsMeta.ok` 是**真信号**，不是由 length 推出来的', async () => {
    /**
     * 这是本卡的核心理由：只加 `count` 修不了缺陷 —— 孤儿态下 count 同样是 0。
     * 所以导出包里必须有一个**独立于 logs.length** 的 ok。
     */
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '0.0.0-test' }), sendMessage: async () => null },
      storage: {
        local: {
          get: async () => {
            throw new Error('Extension context invalidated.');
          },
        },
      },
    });
    mocks.readDiag.mockResolvedValue([]);

    const c = mountPanelBody(ACTS);
    c.setModel(model());
    c.showTab('display');
    await enterDiagAndFlush(c);

    c.root.querySelector('.sub-entry')?.parentElement?.querySelector('.sub-entry');
    /** 找「导出诊断 JSON」并点它（downloadJson 在 jsdom 里会走 Blob/URL） */
    let exported: string | null = null;
    const origCreate = URL.createObjectURL;
    /**
     * ⚠️ `revokeObjectURL` 也必须 stub —— jsdom 没有它，而 `downloadJson()`
     * 里有一个 `setTimeout(…, 0)` 会在**用例结束之后**调它 → vitest 报
     * Unhandled Error。那种错误不会让用例变红，但会**掩盖**真正的失败。
     *
     * ⚠️ 而且**不能在这里还原**：那个 `setTimeout` 是排在用例之后跑的，
     * 一还原就又是 `undefined`。所以留在全局（本文件所有用例共用，
     * 只有这一条会触发导出，不会互相干扰）。
     */
    URL.createObjectURL = ((blob: Blob) => {
      void blob.text().then((t) => {
        exported = t;
      });
      return 'blob:fake';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    try {
      const btn = [...c.root.querySelectorAll('.sub-entry')].find((e) =>
        e.textContent?.includes('导出'),
      );
      expect(btn, '没找到导出按钮').toBeDefined();
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    } finally {
      URL.createObjectURL = origCreate;
    }

    expect(exported, '没有捕获到导出内容').not.toBeNull();
    const obj = JSON.parse(exported ?? '{}') as {
      logs: unknown[];
      logsMeta?: { ok: boolean; err: string | null; count: number; limit: number };
    };
    expect(obj.logs).toEqual([]);
    expect(obj.logsMeta, '导出里没有 logsMeta，孤儿态依旧伪装成"没有日志"').toBeDefined();
    expect(obj.logsMeta?.ok, 'logs 是空数组但 ok 却是 true —— 假正常').toBe(false);
    expect(obj.logsMeta?.err).toBe('Extension context invalidated.');
    expect(obj.logsMeta?.count).toBe(0);
    /** 上限从 diag-store 导入，不许写死 */
    expect(obj.logsMeta?.limit).toBe(30);
  });

  /**
   * ## 为什么选导出侧兜底**函数**的单元测试，而不是端到端
   *
   * verifier 的 RV3 把导出兜底改成 `ok:true` / `err:null`，20 + 14 条**一条不红**。
   * 我按它说的去补端到端，结果撞出一个更基本的事实：
   *
   * **`diagData === null` 时导出按钮根本不存在。** `render()` 在
   * `panel.ts:1028` 就 `if (diagData === null) { 画「正在采集诊断信息…」; return; }`，
   * 二级浮层（连同里面的「导出诊断 JSON」）压根没画出来。而 `openDiag` 是
   * **先 `diagData = null` 再 `loadDiag()`** —— 进得去的那一刻永远是 null。
   *
   * ⇒ **那条路径在界面上点不到**（除非采集永远不回来，而那种情况下也没有按钮）。
   * 端到端用例写出来的只会是"等采集回来再导出"，走的**不是** null 分支 ——
   * 我第一版就是这样，导出的 `count` 是 1，`ok` 是 `true`，测了个寂寞。
   *
   * ## 那这段兜底还要不要守？要，但守的位置不同
   *
   * 它是**真实存在的防御**（`?.` 已经保证运行期不炸），只是**不可达**所以没有行为级
   * 断言能覆盖它 —— verifier 的 RV3 零红正是这个原因，不是"忘了测"。
   *
   * 所以改为**源码级守两点**（剥注释后断言）：
   * 1. 导出侧兜底**必须调用** `describeLogsMetaFallback()` —— 这一条直接杀 RV3：
   *    变异把它写成 `ok:true, err:null` 字面量，就不再调用那个函数了。
   * 2. 兜底**不许**自己写 `ok:` 字面量 —— 否则两处又会长出各自的判断。
   */
  it('★★★ 导出侧兜底必须复用 `describeLogsMetaFallback()`，不许自己写 ok/err 字面量', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/content/panel/panel.ts', 'utf8');
    const start = src.indexOf('exportJson:');
    expect(start, '找不到 exportJson 处理函数').toBeGreaterThan(-1);
    /** 截到 diagnostics case 的闭合为止（花括号配平，避免切到别的回调） */
    let depth = 0;
    let i = src.indexOf('{', start);
    const open = i;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const block = src.slice(open, i + 1);
    expect(block.length, '切片为空，配平坏了').toBeGreaterThan(50);
    const codeOnly = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(codeOnly, '导出侧兜底没有复用 describeLogsMetaFallback()').toMatch(
      /logsMeta:\s*diagData\?\.logsMeta\s*\?\?\s*\{[^}]*\.\.\.describeLogsMetaFallback\(\)/,
    );
    expect(codeOnly, '导出侧兜底自己写了 ok/err 字面量 —— 两侧又开始各写一份').not.toMatch(
      /\b(?:ok|err)\s*:/,
    );
  });
});
