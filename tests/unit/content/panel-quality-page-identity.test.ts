// @vitest-environment jsdom

/**
 * Bug B：`page` 模式下画质 Tab 说「已接管」是**假话**（2026-11-11）。
 *
 * ## 现象（engineer-dnr 真机实测）
 *
 * 切到「浏览器账号」后，画质 Tab：
 *
 * ```
 * StaticText "已接管"
 * StaticText "无法对比"
 * StaticText "取流身份与页面身份相同，无对比基线"
 * ```
 *
 * **同一块界面里自相矛盾**：下面那行自己都说"取流身份与页面身份相同"，
 * 上面却写着「已接管」。
 *
 * ## 为什么这是假话，不是措辞问题
 *
 * `popup-state.ts` 对「已接管」的定义是：**"我替你换了 Cookie"的断言**。
 * 而 `page` 模式（用户选了"用浏览器当前登录态取流"）**一条 DNR 规则都没装**，
 * 一个 Cookie 都没换。
 *
 * 这与本轮修过的 `rewriteGate`（界面说在工作、实际没工作）、
 * `same-account`（零消费方）是**同一类**：**界面陈述错误事实**。
 *
 * ## 根因（链路断在两处）
 *
 * ```
 * describePopup()            ← 判据本身**是对的**（popup-state.ts:279 有 page 短路）
 *   ↑ snapshot.streamingIdentity
 * buildPopupSnapshot()       ← ✅ 接受并有这个字段
 *   ↑
 * loadPanelModel()           ← ❌ 曾经**没传**（`buildPopupSnapshot({ proxy, account, buckets, pageKind })`）
 *   ↑
 * content-panel.content.ts   ← ❌ 曾经**没传**
 * ```
 *
 * 于是 `snapshot.streamingIdentity` 恒为 `undefined` → `popup-state.ts:279`
 * 的 `if (snap.streamingIdentity === 'page')` **永远不触发** → 一路落到「已接管」。
 *
 * **这不是判据写错，是参数没接上。** 判据写对但没人传参，比判据写错更难发现 ——
 * 因为读 `popup-state.ts` 的人会以为它已经修好了。
 *
 * ## 反向验证
 *
 * 把 `loadPanelModel()` 里传 `streamingIdentity` 那一行删掉 →
 * 「page 身份下画质 Tab 不说已接管」那组必然变红。已在任务报告里贴过实测输出。
 */

import { describe, expect, it } from 'vitest';

import {
  buildPanelModel,
  buildPopupSnapshot,
  buildQualityView,
} from '../../../src/content/panel/panel-data';
import type { PrimaryCard } from '../../../src/shared/utils/primary-card';

const PRIMARY: PrimaryCard = { uname: '主', level: 6, loggedIn: 'yes', source: 'live' };

/**
 * 走**真实的** `buildPopupSnapshot` → `buildPanelModel` 链路。
 *
 * ⚠️ 为什么不直接调 `describePopup`：
 * 那样测的是 `popup-state.ts` 的判据（它本来就是对的），
 * **测不出"参数没接上"这个 bug** —— 而那正是本次要守的东西。
 */
function qualityPillFor(streamingIdentity: 'extension' | 'page' | null | undefined) {
  const snap = buildPopupSnapshot({
    proxy: { enabled: true, hasCredential: true, ruleCount: 3 },
    account: {
      configured: true,
      account: {
        uname: '播',
        mid: 2,
        vipLabel: 'annual',
        expireAt: null,
        healthy: true,
        checkedAt: 0,
        reason: null,
      },
    },
    buckets: [],
    pageKind: 'play',
    ...(streamingIdentity !== undefined ? { streamingIdentity } : {}),
  });

  const model = buildPanelModel({
    snapshot: snap,
    pageView: null,
    primary: PRIMARY,
    clean: null,
    pageKind: 'play',
    accountKnown: true,
    pageStateKind: 'not-ready',
  });

  return model.quality;
}

describe('Bug B：page 模式下画质 Tab 不许说「已接管」', () => {
  it('★ page 身份 → pill 是「无需代理」，不是「已接管」', () => {
    /**
     * 「已接管」= "我替你换了 Cookie"。`page` 模式下什么都没换。
     */
    const q = qualityPillFor('page');
    expect(q.pill).toBe('无需代理');
    expect(q.pill, 'page 模式下说「已接管」是假话 —— 什么都没换').not.toBe('已接管');
  });

  it('★ page 身份 → tone 不再是 good（绿色）', () => {
    /**
     * `good` 是"成功了"的颜色。`page` 模式确实正常，但**不是扩展的功劳**，
     * 用中性色才不暗示"扩展在工作"。
     */
    const q = qualityPillFor('page');
    expect(q.tone).toBe('neutral');
  });

  it('★ page 身份 + 总开关关着 → 「已停用」（用户操作优先）', () => {
    const snap = buildPopupSnapshot({
      proxy: { enabled: false, hasCredential: true, ruleCount: 0 },
      account: { configured: true, account: null },
      buckets: [],
      pageKind: 'play',
      streamingIdentity: 'page',
    });
    const model = buildPanelModel({
      snapshot: snap,
      pageView: null,
      primary: PRIMARY,
      clean: null,
      pageKind: 'play',
      accountKnown: true,
      pageStateKind: 'not-ready',
    });
    expect(model.quality.pill).toBe('已停用');
  });

  it('对照组：extension 身份 → 仍然是「已接管」（该说的要说）', () => {
    /**
     * 修 Bug B **不能**把 `extension` 的「已接管」也改掉 ——
     * 那时扩展**确实**换了 Cookie，那就是接管。
     */
    const q = qualityPillFor('extension');
    expect(q.pill).toBe('已接管');
    expect(q.tone).toBe('good');
  });

  it('对照组：identity 未知（null / undefined）→ 走既有判据，仍是「已接管」', () => {
    /**
     * 拿不到配置时不改口（与 `lastActivateReason` 缺省时同一纪律）。
     * 这条防的是"为了修 Bug B 把未知态也改成无需代理" —— 那是拿未知冒充结论。
     */
    for (const id of [null, undefined] as const) {
      const q = qualityPillFor(id);
      expect(q.pill, `identity=${String(id)} 时不该改口`).toBe('已接管');
    }
  });
});

describe('Bug B 的链路完整性：loadPanelModel 必须把 streamingIdentity 传下去', () => {
  /**
   * ## 为什么这一组必须是**源码级**断言
   *
   * 反向验证暴露了一个真实弱点：上面那组"行为断言"是**直接**调
   * `buildPopupSnapshot({ ..., streamingIdentity })` —— 它复刻了调用方的传参，
   * 所以**删掉 `loadPanelModel` 里那一行，它们全都不会红**（实测：10 条里只有 1 条变红）。
   *
   * 而 Bug B 的本质恰恰是**"函数接受参数但调用方没传"** ——
   * 行为测试只要自己传对了参数就永远测不到它。
   *
   * 所以这一组直接**读源码断言调用点**。与
   * `tests/unit/platform/background-play-page.test.ts` 同款做法。
   *
   * ⚠️ 这是"行为测不到就只能测结构"的例子，不是偷懒：
   * `loadPanelModel()` 要发真实消息（`fetchPanelReplies` 内含
   * `chrome.runtime.sendMessage` 与 `tabs.sendMessage`），在 jsdom 里跑不起来。
   * mock 掉它们就等于**不再测真实链路**。
   */
  async function readSrc(rel: string): Promise<string> {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    return readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8');
  }

  it('★ buildPopupSnapshot 的调用点必须含 streamingIdentity', async () => {
    const src = await readSrc('src/content/panel/panel-data.ts');
    const call = /buildPopupSnapshot\(\{([\s\S]*?)\n {2}\}\);/.exec(src);
    expect(call, '找不到 buildPopupSnapshot 的调用点').not.toBeNull();
    expect(
      call?.[1] ?? '',
      'buildPopupSnapshot 的调用点没传 streamingIdentity —— page 模式下画质 Tab 会说「已接管」',
    ).toContain('streamingIdentity');
  });

  it('★ loadPanelModel 的签名必须接受 streamingIdentity', async () => {
    const src = await readSrc('src/content/panel/panel-data.ts');
    const sig =
      /export async function loadPanelModel\(input: \{([\s\S]*?)\}\): Promise<PanelModel>/.exec(
        src,
      );
    expect(sig, '找不到 loadPanelModel 的签名').not.toBeNull();
    expect(sig?.[1] ?? '', 'loadPanelModel 不接受 streamingIdentity').toContain(
      'streamingIdentity',
    );
  });

  it('★ content 入口必须把 streamingIdentity 传给 loadPanelModel', async () => {
    const src = await readSrc('entrypoints/content-panel.content.ts');
    const call = /loadPanelModel\(\{([\s\S]*?)\}\)/.exec(src);
    expect(call, '找不到 loadPanelModel 的调用点').not.toBeNull();
    expect(call?.[1] ?? '', 'content 入口没把 streamingIdentity 传给 loadPanelModel').toContain(
      'streamingIdentity',
    );
  });

  it('★ 三处链路节点必须**同时**存在（缺任一环，Bug B 就复发）', async () => {
    /**
     * 把三环放在一条断言里，是因为**任何一环断了效果都一样**：
     * `page` 模式下画质 Tab 说「已接管」。
     *
     * 分开写会让人以为"我只改了这一处，另外两处没动所以没问题" ——
     * 而 bug 的形态正是"每一处单独看都没改坏"。
     */
    const panelData = await readSrc('src/content/panel/panel-data.ts');
    const contentEntry = await readSrc('entrypoints/content-panel.content.ts');

    expect({
      签名接受: /export async function loadPanelModel\(input: \{[\s\S]*?streamingIdentity/.test(
        panelData,
      ),
      透传给快照: /buildPopupSnapshot\(\{[\s\S]*?streamingIdentity/.test(panelData),
      入口传进来: /loadPanelModel\(\{[\s\S]*?streamingIdentity/.test(contentEntry),
    }).toEqual({ 签名接受: true, 透传给快照: true, 入口传进来: true });
  });
});

describe('对照组：buildQualityView 自身不做身份判断（判据只在 describePopup）', () => {
  it('buildQualityView 只透传 view.pill，不自己判身份', () => {
    /**
     * 这条守的是"判据只有一处"。
     * 若有人在 `buildQualityView` 里另写一份 `if (identity === 'page')`，
     * 就变成两处判据 —— 那正是本轮反复出问题的形状。
     */
    const q = buildQualityView({
      view: { pill: '某个外部传入的胶囊', tone: 'good' },
      unlock: null,
      proxyEnabled: true,
      pageKind: 'play',
      pageStateKind: 'not-ready',
    });
    expect(q.pill).toBe('某个外部传入的胶囊');
  });

  it('view 为 null → pill 是「未知」，不编一个结论', () => {
    const q = buildQualityView({
      view: null,
      unlock: null,
      proxyEnabled: null,
      pageKind: 'play',
      pageStateKind: 'not-ready',
    });
    expect(q.pill).toBe('未知');
    expect(q.tone).toBe('neutral');
  });
});
