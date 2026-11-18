// @vitest-environment jsdom

/**
 * `refreshModel()` 必须用**当前的**取流身份重取（2026-11-12，task-3 修 B-1/B-2/B-3）。
 *
 * ## 守的是什么
 *
 * `refreshModel()` 由「总开关 / 净化开关 / 退出」之后的写操作调用。旧实现
 * **不传** `streamingIdentity`，于是 `panel-data.ts` 的
 * `streamingIdentity ?? 'extension'` 缺省成 `'extension'`：
 *
 * | 真实身份 | `hasCredential` | 真实答案（`isStreamingReady`） | 缺省后的答案 |
 * | --- | --- | --- | --- |
 * | `'page'` | `false` | **`true`（本来就可用）** | `false` → 误判「未配置」 |
 *
 * 同时 `panel-data.ts` 的透传条件 `streamingIdentity !== undefined` 为假 →
 * `describePopup()` 里 `if (snap.streamingIdentity === 'page')` 永不触发 →
 * 画质 Tab 说「已接管」，而 `page` 模式下**什么都没换 Cookie**。
 *
 * ## ⚠️ 这些用例**不复述实现**（卡里第 8 条纪律）
 *
 * 断言"把 `'page'` 传进了 `loadPanelModel`"是复述实现：换成任何别的实现方式
 * 就绿了，而且它挡不住上面那张表里真正会坏掉的东西。
 *
 * 所以这里断言的是**用户看到什么**：
 *   - `page` 身份下不出现「还没有配置取流账号」
 *   - `page` 身份下画质 Tab 不说「已接管」
 * 两条都是"把参数删掉就变红"的**行为**断言。
 *
 * ## 为什么要 mock `loadPanelModel`
 *
 * 真实现要发 4 条 `chrome.runtime.sendMessage`，jsdom 里没有 `chrome`。
 * mock 掉它之后，被测的仍然是 `panel.ts` 的 `refreshModel()` → **渲染**这条链路；
 * `loadPanelModel` 自己的透传逻辑在 `panel-data.test.ts` 另有覆盖。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⚠️ `vi.mock` 的工厂会被提升到文件顶部，引用的变量必须 `vi.hoisted()` 建
 * （`panel-write.test.ts` 记过这个坑）。
 */
const mocks = vi.hoisted(() => ({
  loadPanelModel: vi.fn(),
  sendMessage: vi.fn(async (_m: unknown) => ({ type: 'proxy/set:ok' }) as unknown),
  /** 净化偏好的"存储"：`writeOption` 会读—改—写 */
  store: { current: {} as Record<string, unknown> },
}));

vi.mock('../../../../src/content/panel/panel-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/content/panel/panel-data')>();
  return {
    ...actual,
    loadPanelModel: (...args: unknown[]) => mocks.loadPanelModel(...args),
  };
});

vi.mock('@platform/storage/ui-prefs-store', () => ({
  readRawCleanOptions: async () => mocks.store.current['pluma:clean-options'],
  writeCleanOptionFlags: async (o: Record<string, boolean>) => {
    mocks.store.current['pluma:clean-options'] = { options: o, hideCategories: [] };
  },
  writeCleanHideCategories: async () => undefined,
  readBadgeEnabled: async () => true,
  writeBadgeEnabled: async () => undefined,
  readPcdnFilterEnabled: async () => false,
  writePcdnFilterEnabled: async () => undefined,
}));

vi.mock('@platform/diagnostics/collect', () => ({
  collectFacts: async () => [],
  tipFor: () => '',
}));

vi.mock('@platform/storage/diag-store', () => ({
  readDiag: async () => [],
}));

vi.mock('../../../../src/content/site-clean/ads', () => ({
  applyAdClean: () => undefined,
  // 诊断页渲染时会问一次广告命中数；本文件测的是重取用的身份，与它无关
  inspectAdClean: () => ({ candidates: 0, marked: 0, containerMissing: false, verdict: 'dead' as const }),
}));

vi.mock('../../../../src/content/site-clean/home-clean', () => ({
  applyHomeClean: () => undefined,
}));

const { mountPanelBody } = await import('../../../../src/content/panel/panel');
const { buildPanelModel } = await import('../../../../src/content/panel/panel-data');
type PanelModel = import('../../../../src/content/panel/panel-data').PanelModel;

/**
 * 用**真实**的 `buildPanelModel()` 造一个 `page` 身份的模型。
 *
 * ⚠️ 关键点：`buildPanelModel` 内部走 `buildPopupSnapshot()`，而后者是
 * `configured` 与 `streamingIdentity` 透传的落点 —— 所以这样造出来的模型
 * 承载的正是"身份有没有传到"这个事实，而不是我在测试里手写的结论。
 */
function pageIdentityModel(): PanelModel {
  return buildPanelModel({
    snapshot: {
      proxy: { enabled: true, hasCredential: false, rules: 0, pathRules: 0, tabRules: 0 },
      account: null,
      configured: false,
      buckets: [],
      page: { kind: 'play' },
      streamingIdentity: 'page',
    } as never,
    pageView: null,
    primary: { uname: '主账号', level: 6, loggedIn: 'yes', source: 'live' },
    clean: null,
    pageKind: 'play',
    accountKnown: true,
    pageStateKind: 'ok',
  });
}

/** 首次挂载用的空模型（`model === null` 时的兜底形状） */
function emptyModel(): PanelModel {
  return buildPanelModel({
    snapshot: null,
    pageView: null,
    primary: { uname: null, level: null, loggedIn: 'unknown', source: 'none' },
    clean: null,
    pageKind: 'play',
    accountKnown: false,
    pageStateKind: 'ok',
  });
}

/**
 * `'extension'` 身份 + 没有密文的模型 —— 这是**真的未配置**：
 * `isStreamingReady('extension', false) === false`。
 *
 * 用于对照：若 `refreshModel` 没传身份（缺省成 `'extension'`），
 * 走的就是这份判据 → 界面会说「还没有配置取流账号」。
 */
function extensionIdentityModel(): PanelModel {
  return buildPanelModel({
    snapshot: {
      proxy: { enabled: true, hasCredential: false, rules: 0, pathRules: 0, tabRules: 0 },
      account: null,
      configured: false,
      buckets: [],
      page: { kind: 'play' },
      streamingIdentity: 'extension',
    } as never,
    pageView: null,
    primary: { uname: '主账号', level: 6, loggedIn: 'yes', source: 'live' },
    clean: null,
    pageKind: 'play',
    accountKnown: true,
    pageStateKind: 'ok',
  });
}

function acts(overrides: Record<string, unknown> = {}) {
  return {
    login: () => undefined,
    logout: async () => ({ ok: true }),
    streamingIdentity: 'page' as const,
    toggleStreamingIdentity: () => undefined,
    feedAccountEnabled: false,
    toggleFeedAccount: () => undefined,
    /**
     * 唯一真相源的**读取函数**（不是值）—— 每次重取都读一次。
     */
    currentStreamingIdentity: () => 'page' as const,
    ...overrides,
  };
}

/** 面板上所有文字 */
function textOf(root: HTMLElement): string {
  return root.textContent ?? '';
}

/**
 * 触发一次 `refreshModel()`：点净化 Tab 里的第一个开关。
 *
 * ⚠️ 为什么用净化开关而不是总开关：总开关走 `chrome.runtime.sendMessage`，
 * 而净化开关走"读—改—写 storage"，两者最终**都**落到 `refreshModel()`。
 * 用后者可以少 mock 一层，且不影响被测的东西（`refreshModel` 的入参）。
 */
async function triggerRefresh(controller: {
  root: HTMLElement;
  showTab: (t: 'clean') => void;
}): Promise<void> {
  // 先给净化开关准备好"存储里的初始值"
  mocks.store.current['pluma:clean-options'] = {
    options: { adBlock: true, homeCategories: true, topBanner: true },
    hideCategories: [],
  };
  controller.showTab('clean');

  const input = controller.root.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(input, '净化 Tab 必须有开关').not.toBeNull();
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await vi.waitFor(() => {
    expect(mocks.loadPanelModel).toHaveBeenCalled();
  });
  // 等 refreshModel 的 await 完成、render() 落地
  await vi.waitFor(() => {
    expect(textOf(controller.root)).not.toBe('');
  });
  await Promise.resolve();
}

beforeEach(() => {
  mocks.loadPanelModel.mockReset();
  mocks.sendMessage.mockClear();
  mocks.store.current = {};
  document.body.textContent = '';
  // `panel.ts` 的 `toggleProxy` 与诊断会直接摸 `chrome`
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: mocks.sendMessage, getManifest: () => ({ version: '0.0.0-test' }) },
  });
});

describe('★★ `page` 身份重取后画质 Tab 必须说实话', () => {
  it('★★★ 写操作触发 refreshModel → 画质 Tab 不说「未配置」（旧实现必红）', async () => {
    /**
     * ## 这条测试怎么挡住旧 bug
     *
     * 实测（`buildPanelModel` 真实调用）：
     *
     * | 送进 `loadPanelModel` 的身份 | 画质胶囊 |
     * | --- | --- |
     * | `'page'` | **「无需代理」** + 「当前用浏览器账号取流，未使用取流账号」 |
     * | `'extension'` | 「未配置」 |
     * | **不传（旧实现的 bug）** | 「未配置」← 与 `'extension'` 同 |
     *
     * 旧 `refreshModel` **不传**身份 → 缺省 `'extension'` → `page` 身份的
     * 用户每次拨开关都会看到「未配置」。这是用户能直接看见的错误结论。
     *
     * 反例：把 `refreshModel` 的 `streamingIdentity` 删掉 → 本条必红，
     * 红在 `expect(text).not.toContain('未配置')`。
     *
     * ## 为什么断言画质 Tab 而不是账号 Tab
     *
     * 账号 Tab 的「还没有配置取流账号」判据走的是**面板本地镜像**
     * `actions.streamingIdentity`（`tabs.ts:911`），不是模型 ——
     * 所以它测不到 `refreshModel` 的透传。画质 Tab 的胶囊才是模型算出来的，
     * 那正是这条修复真正影响的地方（`describePopup` 的 `streamingIdentity` 短路）。
     */
    const m = pageIdentityModel();
    // 前置事实：page 身份下没有密文，但画质 Tab 说「无需代理」而不是「未配置」
    expect(m.account.hasCredential, '构造前提：page 身份下没有密文').toBe(false);
    expect(m.quality.pill, '构造前提：page 身份不需要代理').toContain('无需代理');

    /**
     * ⚠️ mock 必须**像真实现一样消费入参**，否则这条界面断言测不到东西：
     * 一个恒返回 `page` 模型的 mock 会让"删掉传参"的反向改动**照样绿**
     * （第一版就是这样 —— 反向验证时只有参数断言变红、这条没红）。
     *
     * 按真实语义分流：
     *   - 传 `'page'` → 真实 `'page'` 模型（画质「无需代理」）
     *   - 没传（`undefined`）→ `panel-data.ts` 缺省 `'extension'` → 未配置模型
     */
    mocks.loadPanelModel.mockImplementation(async (input: { streamingIdentity?: unknown }) =>
      input.streamingIdentity === 'page' ? pageIdentityModel() : extensionIdentityModel(),
    );

    const controller = mountPanelBody(acts({ streamingIdentity: null }) as never);
    /**
     * ⚠️ 初值用 `'extension'` 那份：它本身画质 Tab 就是「未配置」，
     * 于是下面的断言必须等到重取把它换成 `'page'` 那份、结论变了，才算证明。
     */
    controller.setModel(extensionIdentityModel());
    controller.showTab('quality');

    // 前置事实：初值确实画着「未配置」（否则下面的 not.toContain 没意义）
    expect(textOf(controller.root), '构造前提：初值是未配置态').toContain('未配置');

    await triggerRefresh(controller as never);

    controller.showTab('quality');
    const text = textOf(controller.root);
    expect(text, '`page` 身份被算成「未配置」—— refreshModel 没把身份传下去').not.toContain(
      '未配置',
    );
    expect(text, 'page 身份应该说「无需代理」').toContain('无需代理');
  });

  it('★★ `page` 身份下画质 Tab **不说**「已接管」', async () => {
    /**
     * `page` 模式下扩展**什么都没换 Cookie**，说「已接管」是陈述错误事实
     * （`panel-data.ts` 那段注释描述的就是这个复发）。
     */
    const m = pageIdentityModel();
    const controller = mountPanelBody(acts() as never);
    controller.setModel(m);
    controller.showTab('quality');

    const text = textOf(controller.root);
    expect(text, '`page` 身份下说了「已接管」，而实际什么都没换').not.toContain('已接管');
  });

  it('★★ `refreshModel` 读的是**当前**身份函数，而不是挂载初值', async () => {
    /**
     * 用户先点了胶囊把身份切成 `page`，然后拨开关触发重取。
     * 若 `refreshModel` 拿的是挂载初值（`'extension'`），就会把 `page`
     * 重新算成"未配置"。
     *
     * ## ⚠️ 这条为什么断言"模型"而不是"账号 Tab 的文字"
     *
     * `accountTab()` 拿的是面板**本地镜像** `streamingIdentity`（挂载初值 +
     * 乐观更新），它**设计上**不与 `actions.currentStreamingIdentity()` 同步
     * （见 `panel.ts` 那段"同源不同步是有意的"）。
     * 所以"界面胶囊显示什么"由本地镜像决定，**不是** `refreshModel` 的职责；
     * 用界面文字断言这条会测到一个与修复无关的东西。
     *
     * 这里要守的是：`refreshModel()` 送进 `loadPanelModel()` 的身份是**当前值**。
     * 用返回值（模型）承载这个事实 —— 若实现退化成"用挂载初值"或"不传"，
     * 造出的模型就不是 `page` 身份那份，`configured` 会变 `false`。
     *
     * 反例：把 `refreshModel` 改成 `streamingIdentity: null`（或删掉字段）
     * → `mocks.loadPanelModel` 拿到的身份不是 `'page'` → 本条必红。
     */
    const m = pageIdentityModel();
    mocks.loadPanelModel.mockResolvedValue(m);

    const controller = mountPanelBody(
      acts({
        // 挂载那一刻是 extension（旧值）
        streamingIdentity: 'extension',
        // 但"当前"已经是 page（用户点过胶囊）
        currentStreamingIdentity: () => 'page' as const,
      }) as never,
    );
    controller.setModel(emptyModel());
    controller.showTab('quality');

    await triggerRefresh(controller as never);

    /**
     * 断言送进 `loadPanelModel` 的身份参数是当前值。
     *
     * ⚠️ 这不是"复述实现"：这里断的是**数据契约**——
     * `loadPanelModel` 的 `streamingIdentity` 是唯一真相源，`'page'` 与
     * `undefined` 在它内部走两条不同的判据分支（透传 / 缺省 `'extension'`）。
     * 上一条用例已经在**界面**层面断言了 `'page'` 的正确结论。
     */
    const lastCall = mocks.loadPanelModel.mock.calls.at(-1)?.[0] as {
      streamingIdentity?: unknown;
    };
    expect(lastCall?.streamingIdentity, 'refreshModel 没把当前身份传下去').toBe('page');
  });
});

describe('★ 身份未知时不编造结论', () => {
  it('★ `currentStreamingIdentity()` 返回 undefined → 走既有保守判据（不改口、不崩）', async () => {
    /**
     * `undefined` = 还没读到。缺省行为的语义是"调用方没给"，
     * 不该被替换成任何具体身份。这里只断言**不崩且能画出来**，
     * 具体显示什么由 `panel-data` 的既有判据决定（那条另有测试）。
     */
    mocks.loadPanelModel.mockResolvedValue(emptyModel());

    const controller = mountPanelBody(acts({ currentStreamingIdentity: () => undefined }) as never);
    controller.setModel(emptyModel());
    controller.showTab('quality');

    await triggerRefresh(controller as never);

    expect(textOf(controller.root)).not.toBe('');
  });
});
