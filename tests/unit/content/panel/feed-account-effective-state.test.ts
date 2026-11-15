// @vitest-environment jsdom

/**
 * 推荐流开关**渲染的是生效状态**（2026-11-12，task-5 静默点 5）。
 *
 * ## 用户可见的矛盾（真机证据 `poc/probe/logout-login/REPORT.md` E-3）
 *
 * ```
 * @e267 checkbox "首页推荐流使用取流账号" [disabled] [checked] ="on"
 * paragraph "先扫码登录取流账号，才能用它来换首页推荐流"
 * ```
 *
 * 一个**勾着的、点不动的**开关 + 一句"先扫码登录" —— 用户读到的信息自相矛盾。
 *
 * ## 为什么这不是"视觉问题"
 *
 * 判据在 `rule-plan.ts` 的 `buildRulePlan()`：
 * ```ts
 * if (!state.hasCredential) return { feedStreaming: false, feedAccount: false };
 * ```
 * 没有凭据时 `feedAccount` **恒为 `false`** —— 这个功能**没有在生效**。
 * 而开关画成"开"就是在说"它在生效"：**控件陈述了一件没发生的事**。
 *
 * ## 修法与边界（裁决文件「定稿 C」）
 *
 * - **判据一行没改**：`disabled` 仍然只判 `hasCredential`；
 *   `rule-plan.ts` 里"只看 `feedAccountEnabled`"的独立防线也一个字没动。
 * - 本轮只改**这一个控件渲染什么值**：`checked = hasCredential && feedAccountEnabled`。
 * - **没有**去改通用的 `switchRow()` —— 在通用组件里"禁用就不加 on"
 *   会让所有 disabled+checked 的开关变灰白，而"禁用但确实开着"在某些场景下是真实状态。
 */

import { describe, expect, it } from 'vitest';

import { displayTab } from '../../../../src/content/panel/tabs';

function acts(overrides: Record<string, unknown> = {}) {
  return {
    toggleBadge: () => undefined,
    openDiag: () => undefined,
    feedAccountEnabled: false,
    toggleFeedAccount: () => undefined,
    hasCredential: false,
    badgeReadFailed: false,
    ...overrides,
  };
}

/** 找到「首页推荐流使用取流账号」那一行的开关 */
function feedSwitch(root: HTMLElement): HTMLInputElement | null {
  for (const row of root.querySelectorAll('.row')) {
    const label = row.querySelector('.row-label')?.firstElementChild?.textContent ?? '';
    if (label === '首页推荐流使用取流账号') return row.querySelector('input');
  }
  return null;
}

describe('★★★ 无凭据 + 开关已开 → 控件必须渲染成「关」（不是「开 + 灰」）', () => {
  it('★★★ 真机那个矛盾态：`feedAccountEnabled: true` + `hasCredential: false`', () => {
    /**
     * 这正是真机 `@e267 checkbox [disabled] [checked]` 的那个组合。
     *
     * 反例：把 `checked` 改回只判 `actions.feedAccountEnabled` → 本条必红
     * （`cb.checked` 会是 `true`）。
     */
    const box = displayTab(null, acts({ feedAccountEnabled: true, hasCredential: false }));
    const cb = feedSwitch(box);

    expect(cb, '找不到推荐流开关').not.toBeNull();
    expect(cb?.checked, '无凭据时功能没在生效，控件却显示"开"——陈述错误事实').toBe(false);
  });

  it('★★ 同时仍然**禁用**（判据不改：无凭据不可点）', () => {
    const box = displayTab(null, acts({ feedAccountEnabled: true, hasCredential: false }));
    const cb = feedSwitch(box);

    expect(cb?.disabled, '判据（无凭据禁用）不许改').toBe(true);
  });

  it('★★ 下方那句提示**已删除**（2026-11-12 task-11 按用户要求）', () => {
    /**
     * ⚠️ 这条的口径**反转了**。
     *
     * 旧版：「下方那句提示还在（用户知道该怎么做）」。
     * 用户 task-11 原话：「"先扫码登录取流账号，才能用它来换首页推荐流"…… 这些字都可以删掉」。
     *
     * 已知副作用（用户已确认接受）：无凭据时开关灰着且无解释。
     * **不要自己造替代文案。**
     *
     * 🔁 反向验证：把那句 `pane-note` 加回去 → 本条红。
     */
    const box = displayTab(null, acts({ feedAccountEnabled: true, hasCredential: false }));
    expect(box.textContent ?? '', '那句引导语还在').not.toContain('先扫码登录取流账号');
  });

  // ★ 原「勾着+灰」组合用例已删（2026-11-12，verifier 待修 #1）：它依赖的引导语被
  // task-11 删除后，`saysPleaseLogin` 被上面 :93 的断言强制为 false ⇒ 整个 `&&` 表达式
  // 恒 false ⇒ 永远绿（变异测试实证：把 `tabs.ts:431` 的 `checked` 改回
  // `actions.feedAccountEnabled` 重新引入 bug，本条仍绿）。**零保护，不是保护变弱。**
  // 保护由 :59-71（`expect(cb?.checked).toBe(false)`）承担 —— 不要换成"第二个信号量"加回来，
  // 那会让人误以为这里还有一层防线。
});

describe('★★ 有凭据时开关正常反映用户选择（不误伤）', () => {
  it('★★ 有凭据 + 开着 → 渲染成开、可点', () => {
    const box = displayTab(null, acts({ feedAccountEnabled: true, hasCredential: true }));
    const cb = feedSwitch(box);

    expect(cb?.checked).toBe(true);
    expect(cb?.disabled).toBe(false);
  });

  it('★★ 有凭据 + 关着 → 渲染成关、可点', () => {
    const box = displayTab(null, acts({ feedAccountEnabled: false, hasCredential: true }));
    const cb = feedSwitch(box);

    expect(cb?.checked).toBe(false);
    expect(cb?.disabled).toBe(false);
  });

  it('★ 有凭据时**不**渲染那句「先扫码登录」提示', () => {
    const box = displayTab(null, acts({ feedAccountEnabled: true, hasCredential: true }));
    expect(box.textContent ?? '').not.toContain('先扫码登录取流账号');
  });
});

describe('★★ 与取流身份**无关**（两个功能独立，不许回归）', () => {
  // ⚠️ 名字里的"类型级防线"指 tabs.ts 的签名不含 StreamingIdentity；
  //    本条实际断言的是**渲染值**（与 :59-71 同口径）。两者都要看，别只信名字。
  it('★★ `displayTab` 的类型里根本没有 `StreamingIdentity` 这个入口', () => {
    /**
     * 类型级防线：`displayTab` 的 `actions` 只认 `hasCredential: boolean`。
     * 谁想让推荐流开关跟着取流身份走，必须先改签名 —— 改签名会让所有调用点报错，
     * **不可能静默发生**。
     *
     * 这里做的是运行时验证：只传 `hasCredential`，结果只由它决定。
     * （真要把 `streamingIdentity` 塞进来，TypeScript 会在调用点报多余属性。）
     */
    const withCred = displayTab(null, acts({ feedAccountEnabled: true, hasCredential: true }));
    const withoutCred = displayTab(null, acts({ feedAccountEnabled: true, hasCredential: false }));

    expect(feedSwitch(withCred)?.checked).toBe(true);
    expect(feedSwitch(withoutCred)?.checked).toBe(false);
  });
});
