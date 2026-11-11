import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PageState } from '../../../src/content/isolated/page-state';

/**
 * 守的是步骤 3 的两条不变量：
 *
 * 1. **`same-identity` 只在"能确证没有第二个身份"时才产出** ——
 *    五种 `page/activate` 回答里只有 `self`（及旧名 `same-account`）够格；
 *    `disabled` / `error` / `unknown` / `not-configured` / `ok` 都不能断言。
 * 2. **时序无关** —— `page/activate` 回包可能早于也可能晚于 `applySsr`
 *    （实测回包 ~400ms vs `patchedAt: 358ms`），两种顺序结论必须一致。
 *
 * ## 为什么这组测试是这一步唯一的验收证据
 *
 * `'same-identity'` 是个**跨文件、跨 world** 的判据（background → content → PageState）。
 * 类型加一个值不会让任何东西变红，面板那段分支写了也不会被执行到 ——
 * 这正是 handoff §2 记过的坑：**能编译、单测能过、真机上是死代码**。
 *
 * 所以这里的每个断言都必须满足一个条件：**把生产代码里的判据改回去，它必须变红**。
 * 见本文件末尾的"反向验证"块注释（记录了实际验证过的三个反例）。
 */

function load(name: string): unknown {
  const url = new URL(`../../fixtures/playinfo/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

const GUEST_480 = load('guest-480p.json');
const PLAYBACK_4K = load('playback-4k.json');

function asSsrData(raw: unknown): unknown {
  return (raw as { data?: unknown }).data ?? null;
}

const T0 = 1_760_000_000_000;

function playingState(): PageState {
  const s = new PageState(() => T0);
  s.setPageKey('BV1xx411c7mD', 1);
  // 一个**完全正常**的 SSR 基线：若无 same-identity 介入，它会是 'ssr' 且 usable=true
  s.applySsr({
    firstSeen: 'initial',
    playurlBefore: false,
    data: asSsrData(GUEST_480),
    user: { uname: '主账号', face: null, level: null },
  });
  s.applyPlayback(PLAYBACK_4K);
  return s;
}

describe('PageState：same-identity 的输入域（哪些 reason 够格）', () => {
  /**
   * ## ✅ 2026-11-11 清理：这里原来断言 `['self', 'same-account']` 两个值都命中
   *
   * 那条断言存在的唯一目的，是保证"过渡期结束时不会漏删旧名"。
   * 过渡期已结束（`'same-account'` 已从 `ProxyActivateReason` 移除），
   * 所以它拆成两条更明确的用例：
   *
   *   1. `'self'` **必须**产出 `same-identity`（唯二的正确输入）
   *   2. `'same-account'` **不再是合法输入** —— 靠类型系统保证，这里用 `@ts-expect-error`
   *      钉住"它已经不在联合里"这个事实。若哪天有人把旧名加回去，这条会报红。
   */
  it('reason=self → 产出 same-identity，且基线被判为不可用', () => {
    const s = playingState();
    // 前置：确认它本来是好基线，否则下面断言"变成不可用"没有意义
    expect(s.view()?.primary.reason).toBe('ssr');
    expect(s.view()?.primary.usable).toBe(true);

    s.setProxyIdentity('self');
    const v = s.view();

    expect(v?.primary.reason).toBe('same-identity');
    /**
     * ⚠️ `usable` 必须同时变 false。
     *
     * 只把 reason 改掉、留着 `usable: true` 会出现自相矛盾的视图：
     * "reason 说同一身份" + "usable 说基线可用"。
     * 诊断台据 `usable` 决定 `ok` 字段，两边不一致就会报错。
     */
    expect(v?.primary.usable).toBe(false);
    // 能力也要清掉：同一身份时那份"基线能力"根本不存在
    expect(v?.primary.capability).toBeNull();
  });

  it('旧名 same-account 已不在类型域里（加回来会红）', () => {
    const s = playingState();
    // @ts-expect-error —— `'same-account'` 已从 `ProxyActivateReason` 移除，不再是合法输入
    s.setProxyIdentity('same-account');
    // 运行时若被强塞进来，行为等同"未知"，**不许**产出 same-identity
    expect(s.view()?.primary.reason).not.toBe('same-identity');
  });

  it.each(['ok', 'disabled', 'not-configured', 'error', 'unknown'] as const)(
    'reason=%s → **不产出** same-identity（不知道 ≠ 同一身份）',
    (reason) => {
      const s = playingState();
      s.setProxyIdentity(reason);

      const v = s.view();
      // 保持原判：那份 SSR 基线仍然有效（`ok` / `disabled` / `error` 都无法否定它）
      expect(v?.primary.reason).toBe('ssr');
      expect(v?.primary.usable).toBe(true);
    },
  );

  it('从未调用 setProxyIdentity（回包没来）→ 同 unknown，不产出 same-identity', () => {
    const s = playingState();
    const v = s.view();

    expect(v?.primary.reason).toBe('ssr');
    expect(v?.primary.usable).toBe(true);
  });

  /**
   * ## ⭐ `page-identity` 与 `self` 的**后果相同**（2026-11-11 用户裁决）
   *
   * 两者**成因**不同：
   *   - `self`：事实 —— 两个 mid 恰好相同（扩展发现的）
   *   - `page-identity`：选择 —— 用户在面板里设了"用浏览器账号取流"
   *
   * 但**后果**相同：**没有第二个身份可以参与取流对比**。
   * `SAME_IDENTITY_REASONS` 表达的正是后果，所以两个值都在里面。
   *
   * ## 不加这里的后果（实测链条）
   *
   * `page` 身份下 `primaryReason` 不会是 `same-identity`
   * → `diff` 不是 `null`（两侧同数据、增益全 0）
   * → `summary-view` 落到 `same === true` 分支 → 「无提升（**源限制**）」
   * → **假归因**：暗示"这个视频本来就只有这画质"，而真相是"你只有一个号"。
   *
   * ## 反向验证
   *
   * 把 `page-state.ts` 的 `SAME_IDENTITY_REASONS` 改回 `['self']`
   * → 本用例 `expect(...).toBe('same-identity')` 红。
   */
  it('⭐ reason=page-identity → **同样产出** same-identity（后果相同）', () => {
    const s = playingState();
    s.setProxyIdentity('page-identity');

    const v = s.view();
    expect(v?.primary.reason).toBe('same-identity');
    // 与 self 一样：基线能力被清空，没有可比的两侧
    expect(v?.primary.capability).toBeNull();
  });

  it('⭐ page-identity 与 self 的产出**逐字段一致**（只换成因，不换后果）', () => {
    const viaSelf = playingState();
    viaSelf.setProxyIdentity('self');

    const viaPage = playingState();
    viaPage.setProxyIdentity('page-identity');

    /**
     * 两个 state 对象的 `view()` 必须给出**完全一样**的结论。
     * 这是"后果相同"最直接的证明 —— 如果哪天有人给 `page-identity`
     * 单独加了分支，这条会红。
     */
    expect(viaPage.view()?.primary).toEqual(viaSelf.view()?.primary);
  });
});

describe('PageState：same-identity 与 loggedIn 的互斥不变量', () => {
  /**
   * ## 为什么这条要写成测试而不是注释
   *
   * 互斥是靠**另一个文件的分支**保证的：`page.handler.ts` 的 `self` 分支要求
   * `primaryMid !== null`，而游客态 `primaryMid === null` 会继续代理。
   * 也就是说 `same-identity` 与"未登录"在真机上不可能同时出现。
   *
   * 但 `page.handler.ts` 一旦改动，这个不变量会**静默破掉** —— 没有任何检查会红。
   * 所以这里把"两者同时成立时 UI 该说什么"也钉住：
   * `summary-view.ts` 里 `same-identity` **优先于** `loggedIn === 'no'`。
   *
   * 那条优先级在 `summary-view` 的单测里；这里只守 PageState 侧的语义：
   * **`same-identity` 的裁定不依赖 `primaryMid` 是否读到**。
   */
  it('未拿到 mid（midSettled=false）+ self → 仍产出 same-identity', () => {
    const s = playingState();
    s.setProxyIdentity('self');

    const v = s.view();
    expect(v?.primary.reason).toBe('same-identity');
    // mid 还没到能读的时机 → loggedIn 是 'unknown'，不是 'no'
    expect(v?.primary.loggedIn).toBe('unknown');
  });

  it('确认未登录（midSettled=true 但 mid=null）+ self → 两者都在，交给 summary-view 判别优先级', () => {
    const s = playingState();
    s.setPrimaryMid(null, true); // settled 且读不到 → 确实未登录
    s.setProxyIdentity('self');

    const v = s.view();
    // PageState 不做优先级裁决，它只如实报告两件事
    expect(v?.primary.reason).toBe('same-identity');
    expect(v?.primary.loggedIn).toBe('no');
  });
});

describe('PageState：时序无关（回包早到 / 晚到结论一致）', () => {
  it('回包**晚于** applySsr → 覆盖掉已经判好的 ssr', () => {
    const s = playingState();
    expect(s.view()?.primary.reason).toBe('ssr');

    s.setProxyIdentity('self');
    expect(s.view()?.primary.reason).toBe('same-identity');
  });

  it('回包**早于** applySsr → applySsr 不再把它写成 ssr', () => {
    const s = new PageState(() => T0);
    s.setPageKey('BV1xx411c7mD', 1);
    s.setProxyIdentity('self'); // 回包先到

    s.applySsr({
      firstSeen: 'initial',
      playurlBefore: false,
      data: asSsrData(GUEST_480),
      user: { uname: '主账号', face: null, level: null },
    });
    s.applyPlayback(PLAYBACK_4K);

    const v = s.view();
    expect(v?.primary.reason).toBe('same-identity');
    expect(v?.primary.usable).toBe(false);
  });

  it('两种顺序的最终 view 在 reason / usable 上完全一致', () => {
    const late = playingState();
    late.setProxyIdentity('self');

    const early = new PageState(() => T0);
    early.setPageKey('BV1xx411c7mD', 1);
    early.setProxyIdentity('self');
    early.applySsr({
      firstSeen: 'initial',
      playurlBefore: false,
      data: asSsrData(GUEST_480),
      user: { uname: '主账号', face: null, level: null },
    });
    early.applyPlayback(PLAYBACK_4K);

    expect(late.view()?.primary.reason).toBe(early.view()?.primary.reason);
    expect(late.view()?.primary.usable).toBe(early.view()?.primary.usable);
  });
});

describe('PageState：切换页面后 same-identity 不许粘住', () => {
  /**
   * `setPageKey()` 是**唯一**清空两侧数据的地方（切 P / 切集）。
   * `proxyIdentity` 也必须跟着清 —— 否则用户切到一个新视频，
   * 新页面明明可以被代理，界面却说"同一身份"。
   *
   * ⚠️ 这一条对应 `SINGLE.md` §2.2 入口 B 记录的反向事实：
   * **`client-written` 会粘住到下次刷新**。新加的状态不能重犯这个错。
   */
  it('setPageKey 换页 → proxyIdentity 复位，新页的基线照常可用', () => {
    const s = playingState();
    s.setProxyIdentity('self');
    expect(s.view()?.primary.reason).toBe('same-identity');

    s.setPageKey('BV1yy411c7mE', 1); // 换一页
    expect(s.view()?.primary.reason).toBe('absent'); // 复位成初始态

    s.applySsr({
      firstSeen: 'initial',
      playurlBefore: false,
      data: asSsrData(GUEST_480),
      user: null,
    });
    // 新页不再被判成 same-identity
    expect(s.view()?.primary.reason).toBe('ssr');
  });
});

/**
 * ## 反向验证记录（必须真跑过，不是声称）
 *
 * 按 AGENTS.md §1.5，一个测试写完后必须确认**把它守的判据改回去会变红**。
 * 本文件实际验证过的三个反例：
 *
 * | # | 改回什么 | 变红的用例 |
 * | --- | --- | --- |
 * | 1 | `SAME_IDENTITY_REASONS` 里删掉 `'self'` | `reason=self → 产出 same-identity` |
 * | 2 | 把 `'disabled'` 加进 `SAME_IDENTITY_REASONS` | `reason=disabled → 不产出 same-identity` |
 * | 3 | 删掉 `applySsr()` 开头的 `confirmsSameIdentity` 早期返回 | `回包早于 applySsr → applySsr 不再把它写成 ssr` |
 *
 * 三次全部实际执行、确认变红、随后改回。若有人日后重构这段逻辑，
 * 请重跑这三个反例。
 */
