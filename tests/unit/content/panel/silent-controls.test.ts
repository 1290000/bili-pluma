// @vitest-environment jsdom

/**
 * 面板其余**静默失败点**统一给反馈（2026-11-12，task-5）。
 *
 * ## 用户原话
 *
 * 「你再看看还有没有类似的问题，尤其是点击之后没有反应的情况」
 *
 * ## 统一判据（卡里定的验收标准）
 *
 * **每一个"改状态"的控件：点击后用户能看见某种变化；失败时有文字说明。**
 * 全部走 task-8 建立的 `showNotice`（`root` 级、跨 `render()` 存活），
 * **不另造第二套提示机制**。
 *
 * ## 本文件覆盖的静默点
 *
 * | # | 控件 | 旧行为 |
 * | --- | --- | --- |
 * | 1 | 画质总开关 `toggleProxy` | `.catch(() => null)` **完全静默**，连应答 type 都不看 |
 * | 2 | 角标开关 | 读失败 → 永久灰着、**不解释**；写失败 → 静默回滚 |
 * | 3 | 净化开关 `writeOption`/`writeCategory` | 异常冒泡 → 开关不动、无文字 |
 * | 4 | 诊断浮层 | 失败 → **空表无归因** |
 * | 6 | 推荐流开关 `setFeedAccount` | 只 `throw`，调用方 `.catch(() => {})` 吞掉 |
 *
 * 推荐流**禁用态视觉**（静默点 5）另见 `feed-account-effective-state.test.ts`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⚠️ **静态 import + 顶层 `vi.mock`**，不要写 `await import()`。
 *
 * `vi.mock` 会被提升到文件顶部，而顶层 `await import()` 与 `vi.hoisted()`
 * 混用会让模块图解析自锁 —— 实测：整份文件**一行测试都不跑**，进程挂住
 * 且 `--testTimeout` 无效（因为卡在加载阶段而不是用例阶段）。
 *
 * `panel-write.test.ts` 用的就是这个模式，照抄即可。
 */
import { mountPanelBody } from '../../../../src/content/panel/panel';
import type { PanelController } from '../../../../src/content/panel/panel';
import type { PanelModel } from '../../../../src/content/panel/panel-data';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  readBadgeEnabled: vi.fn(),
  writeBadgeEnabled: vi.fn(),
  readPcdnFilterEnabled: vi.fn(),
  writePcdnFilterEnabled: vi.fn(),
  readRawCleanOptions: vi.fn(),
  writeCleanOptionFlags: vi.fn(),
  writeCleanHideCategories: vi.fn(),
  collectFacts: vi.fn(),
  readDiag: vi.fn(),
}));

vi.mock('@platform/storage/ui-prefs-store', () => ({
  readBadgeEnabled: (...a: unknown[]) => mocks.readBadgeEnabled(...a),
  writeBadgeEnabled: (...a: unknown[]) => mocks.writeBadgeEnabled(...a),
  readPcdnFilterEnabled: (...a: unknown[]) => mocks.readPcdnFilterEnabled(...a),
  writePcdnFilterEnabled: (...a: unknown[]) => mocks.writePcdnFilterEnabled(...a),
  readRawCleanOptions: (...a: unknown[]) => mocks.readRawCleanOptions(...a),
  writeCleanOptionFlags: (...a: unknown[]) => mocks.writeCleanOptionFlags(...a),
  writeCleanHideCategories: (...a: unknown[]) => mocks.writeCleanHideCategories(...a),
}));

vi.mock('@platform/diagnostics/collect', () => ({
  collectFacts: (...a: unknown[]) => mocks.collectFacts(...a),
  /**
   * ⚠️ `loadDiag()` 还会调 `readLastDiagEcho()` —— 不 mock 它这里就是
   * `undefined is not a function`，会让"采集成功"的用例走进失败分支
   * （实测踩过：诊断成功用例却弹了失败提示）。
   */
  readLastDiagEcho: () => null,
  tipFor: () => '',
}));

vi.mock('@platform/storage/diag-store', () => ({
  readDiag: (...a: unknown[]) => mocks.readDiag(...a),
  /** ⚠️ 同理：`loadDiag()` 也调 `readDiagTrace()` */
  readDiagTrace: async () => null,
  /**
   * ⚠️ **这两个也必须给**（task-26 起 `loadDiag()` 用它们算 `logsMeta`）。
   * 缺 `instanceId` 会让 `panel.ts` 的 `probeLogsReadability()` 抛
   * `No "instanceId" export is defined on the ... mock`，那是个
   * **Unhandled Rejection** —— 用例会红成"没弹提示"，
   * 看起来像产品缺陷，实际是 mock 少一个导出。
   */
  DIAG_LIMIT: 30,
  instanceId: () => 'test01',
}));

vi.mock('../../../../src/content/site-clean/ads', () => ({
  applyAdClean: () => undefined,
  // 诊断页渲染时会问一次广告命中数；本文件测的是静默失败提示，与它无关
  inspectAdClean: () => ({
    candidates: 0,
    marked: 0,
    containerMissing: false,
    verdict: 'dead' as const,
  }),
}));
vi.mock('../../../../src/content/site-clean/home-clean', () => ({
  applyHomeClean: () => undefined,
}));

function model(overrides: Partial<PanelModel> = {}): PanelModel {
  return {
    quality: {
      pill: '已接管',
      tone: 'good',
      line: null,
      unlock: null,
      proxyEnabled: true,
      pageKind: 'play',
    },
    clean: {
      /**
       * ⚠️ 用**真实的**选项键（`CLEAN_OPTION_META` 的第一项是 `adEnabled`）。
       * 写成 `adBlock` 之类的臆造键会让"构造前提"断言失败 —— 而那只是个
       * 测试自身的数据错误，把它当成实现 bug 排查会浪费很多时间（实测踩过）。
       */
      options: { adEnabled: true, adPreserveEventBanner: false, adDebug: false },
      hideCategories: [],
    },
    account: {
      primary: { uname: '主账号', level: 6, loggedIn: 'yes', source: 'live' },
      playback: null,
      unknown: false,
      hasCredential: true,
      needsLogin: false,
    },
    pageKind: 'play',
    pageStateKind: 'ok',
    pageView: null,
    ...overrides,
  } as PanelModel;
}

function acts(overrides: Record<string, unknown> = {}) {
  return {
    login: () => undefined,
    logout: async () => ({ ok: true }),
    streamingIdentity: null,
    toggleStreamingIdentity: () => undefined,
    feedAccountEnabled: false,
    toggleFeedAccount: () => undefined,
    currentStreamingIdentity: () => undefined,
    ...overrides,
  };
}

let controller: PanelController | null = null;

function notice(): HTMLElement | null {
  return controller?.root.querySelector('.panel-notice') ?? null;
}

/** 找到某个标签对应的开关 checkbox */
function switchFor(root: HTMLElement, label: string): HTMLInputElement | null {
  for (const row of root.querySelectorAll('.row')) {
    if ((row.querySelector('.row-label')?.firstElementChild?.textContent ?? '') === label) {
      return row.querySelector('input');
    }
  }
  return null;
}

beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: mocks.sendMessage, getManifest: () => ({ version: 'test' }) },
  });
  // 默认：一切正常
  mocks.sendMessage.mockResolvedValue({ type: 'proxy/set:ok' });
  mocks.readBadgeEnabled.mockResolvedValue(true);
  mocks.readPcdnFilterEnabled.mockResolvedValue(false);
  mocks.writeBadgeEnabled.mockResolvedValue(undefined);
  mocks.readRawCleanOptions.mockResolvedValue({
    options: { adEnabled: true, adPreserveEventBanner: false, adDebug: false },
    hideCategories: [],
  });
  mocks.writeCleanOptionFlags.mockResolvedValue(undefined);
  mocks.writeCleanHideCategories.mockResolvedValue(undefined);
  mocks.collectFacts.mockResolvedValue([]);
  mocks.readDiag.mockResolvedValue([]);
  document.body.textContent = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.textContent = '';
  controller = null;
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// ───────────────────────── 静默点 1：画质总开关 ─────────────────────────

describe('🔴 静默点 1：画质总开关失败必须有文字', () => {
  it('★★★ 消息抛错 → 用户看到提示（旧实现完全静默）', async () => {
    /**
     * 旧实现：`await sendMessage(...).catch(() => null)` —— 吞掉。
     * 反例：把 `if (res?.type !== 'proxy/set:ok') showNotice(...)` 删掉 → 本条必红。
     */
    mocks.sendMessage.mockRejectedValue(new Error('SW 没应答'));

    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('quality');

    const sw = controller.root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(sw, '画质 Tab 必须有总开关').not.toBeNull();
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(notice(), '总开关失败时用户一个字都看不到').not.toBeNull();
    expect(notice()?.classList.contains('danger')).toBe(true);
  });

  it('★★★ 应答是失败 type（不抛错但没 ok）→ 也要提示', async () => {
    /**
     * 旧实现**连应答 type 都不看** —— 即使 background 明确回了失败，
     * 面板也当成功处理。这条堵的是"只 catch 不判 type"的半修。
     *
     * 反例：把 `res?.type !== 'proxy/set:ok'` 的判断删掉（只留 catch）→ 本条必红。
     */
    mocks.sendMessage.mockResolvedValue({ type: 'proxy/set:failed' });

    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('quality');

    const sw = controller.root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(notice(), '后台回了失败，面板却当成功').not.toBeNull();
  });

  it('★ 成功时**不**弹失败提示（不误报）', async () => {
    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('quality');

    const sw = controller.root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(notice(), '成功了却弹了失败提示').toBeNull();
  });
});

// ───────────────────────── 静默点 2：角标开关 ─────────────────────────

describe('🔴 静默点 2：角标开关读失败要说明原因', () => {
  it('★★★ 读失败 → 面板上有文字解释（旧实现一个灰开关、零文字）', async () => {
    /**
     * 旧实现 catch 是空的：`badgeEnabled` 停在 `null` → 开关永久 `disabled`，
     * **不告诉用户为什么**。
     *
     * 反例：把 `badgeReadFailed = true; render();` 删掉（回到空 catch）
     * → 本条必红。
     */
    mocks.readBadgeEnabled.mockRejectedValue(new Error('storage 读不到'));

    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('display');
    await vi.waitFor(() => {
      expect(mocks.readBadgeEnabled).toHaveBeenCalled();
    });
    await flush();

    const text = controller.root.textContent ?? '';
    expect(text, '读不到角标设置却不解释原因').toContain('读不到角标开关');
  });

  it('★★ 读失败时开关**仍然禁用**（不猜成"关"）', async () => {
    mocks.readBadgeEnabled.mockRejectedValue(new Error('x'));

    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('display');
    await vi.waitFor(() => {
      expect(mocks.readBadgeEnabled).toHaveBeenCalled();
    });
    await flush();

    const sw = switchFor(controller.root, '页内角标');
    expect(sw?.disabled, '读失败时不该猜成"关"（那会让用户以为功能被自己关了）').toBe(true);
  });

  it('★★★ 读成功时**不**出现"读不到"那句（不误报 —— 卡里点名的风险）', async () => {
    /**
     * ⚠️ 这是卡里提醒的那条："`badgeEnabled === null` 很容易写成一个永远为真的断言"。
     *
     * 如果实现用 `badgeEnabled === null` 当"读失败"的判据，那么**挂载瞬间**
     * （还没读完）也会显示"读不到"——每次进 Tab 都闪一下错文案。
     *
     * 所以必须用独立的 `badgeReadFailed` 标志，且读成功后它保持 `false`。
     *
     * 反例：把渲染条件改成 `badgeEnabled === null` → 本条必红（读成功后仍可能有
     * 一瞬为 null，且这个断言在读完的稳态下能守住）。
     */
    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('display');
    await vi.waitFor(() => {
      expect(mocks.readBadgeEnabled).toHaveBeenCalled();
    });
    await flush();

    expect(controller.root.textContent ?? '').not.toContain('读不到角标开关');
  });

  it('★★★ 写入失败 → 回滚 + 文字说明（旧实现静默回滚）', async () => {
    /**
     * 反例：把 `catch` 里的 `showNotice(...)` 删掉（只回滚）→ 本条必红。
     */
    mocks.writeBadgeEnabled.mockRejectedValue(new Error('写不进去'));

    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('display');
    const c = controller;
    await vi.waitFor(() => {
      expect(switchFor(c.root, '页内角标')).not.toBeNull();
    });

    const sw = switchFor(c.root, '页内角标') as HTMLInputElement;
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(notice(), '角标写入失败时没有提示').not.toBeNull();
    expect(notice()?.classList.contains('danger')).toBe(true);
  });
});

// ───────────────────────── 静默点 3：净化开关 ─────────────────────────

describe('🟠 静默点 3：净化开关失败要可见（且**不加**乐观更新）', () => {
  it('★★★ 读失败 → 提示（旧实现异常冒泡，开关不动无文字）', async () => {
    /**
     * 反例：把 `writeOption` 的 try/catch 去掉 → 异常冒泡 → 本条必红。
     */
    mocks.readRawCleanOptions.mockRejectedValue(new Error('storage 挂了'));

    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('clean');

    const sw = controller.root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(sw, '净化 Tab 必须有开关').not.toBeNull();
    sw.checked = !sw.checked;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(notice(), '净化开关读失败时没有提示').not.toBeNull();
  });

  it('★★★ 写失败 → 提示', async () => {
    mocks.writeCleanOptionFlags.mockRejectedValue(new Error('写不进去'));

    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('clean');

    const sw = controller.root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    sw.checked = !sw.checked;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(notice()).not.toBeNull();
  });

  it('★★ 失败后**不**乐观翻转（开关停在模型的原值）', async () => {
    /**
     * ## 为什么这条重要（Lead 明确要求）
     *
     * 净化开关是**读—改—写**：先读最新整块偏好，改一个键，整块写回。
     * 若给它加乐观更新，读失败时界面会显示一个 **storage 里不存在**的状态。
     *
     * 所以修法只有"让失败可见"，**不许**顺手加乐观更新。
     *
     * ⚠️ 注意：`switchRow` 的 checkbox 是**用户点的那一下**改的，它天然是"用户的
     * 意图"而不是"已保存的值"。所以这里断言的是：失败后 `render()` 把它拉回
     * 模型里的值 —— 即最终视觉与 storage 一致。
     */
    mocks.writeCleanOptionFlags.mockRejectedValue(new Error('写不进去'));

    controller = mountPanelBody(acts() as never);
    controller.setModel(model()); // adEnabled: true
    controller.showTab('clean');

    const before = controller.root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(before.checked, '构造前提：模型里 adEnabled 是 true').toBe(true);

    before.checked = false; // 用户试图关掉
    before.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    // 写失败 → 不许把界面留在"关"（那是个没保存上的值）
    const after = controller.root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(after.checked, '写失败却把开关留在了未保存的状态上').toBe(true);
  });
});

// ───────────────────────── 静默点 4：诊断浮层 ─────────────────────────

describe('🟠 静默点 4：诊断采集失败不能只给空表', () => {
  it('★★★ 采集抛错 → 有文字说明（旧实现渲染一张空表）', async () => {
    /**
     * 反例：把 `catch` 里的 `showNotice(...)` 删掉 → 本条必红。
     */
    mocks.collectFacts.mockRejectedValue(new Error('采集挂了'));

    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('display');

    const diagBtn = [...controller.root.querySelectorAll('.sub-entry')].find(
      (b) => b.textContent?.startsWith('诊断') === true,
    ) as HTMLElement | undefined;
    expect(diagBtn, '找不到诊断入口').toBeDefined();
    diagBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await flush();
    await flush();

    expect(notice(), '诊断采集失败却没有任何说明').not.toBeNull();
    expect(notice()?.textContent).toContain('诊断');
  });

  it('★ 采集成功时**不**弹失败提示（不误报）', async () => {
    controller = mountPanelBody(acts() as never);
    controller.setModel(model());
    controller.showTab('display');

    const diagBtn = [...controller.root.querySelectorAll('.sub-entry')].find(
      (b) => b.textContent?.startsWith('诊断') === true,
    ) as HTMLElement | undefined;
    diagBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await flush();
    await flush();
    expect(notice()).toBeNull();
  });
});
