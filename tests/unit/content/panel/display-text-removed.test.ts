// @vitest-environment jsdom

/**
 * 删除推荐流开关的副说明文字（2026-11-12，task-11）。
 *
 * ## 用户原话（一字不改，唯一需求）
 *
 * > 「另外把首页推荐流使用取流账号这个开关的"打开后首页推荐完成取流账号的"
 * > 这些详细描述删掉，**标题已经能够完美解释这个开关的含义了**」
 * >
 * > 「"先扫码登录取流账号，才能用它来换首页推荐流"、
 * > "诊断里有 InPrivate权限、DNR规则与诊断日志 -- 出问题 时先看那里。"
 * > 这些字都可以删掉」
 *
 * ## 删的是**三处**
 *
 * | # | 位置 | 内容 |
 * | --- | --- | --- |
 * | 1 | `displayTab()` 推荐流开关 | `hint: '打开后，首页推荐换成取流账号的'` |
 * | 2 | `displayTab()` 底部 | `'先扫码登录取流账号，才能用它来换首页推荐流'` |
 * | 3 | `displayTab()` 诊断入口下方 | `'诊断里有 InPrivate 权限、DNR 规则与诊断日志 —— 出问题时先看那里。'` |
 *
 * ## ⚠️ 不许自己造替代文案
 *
 * 用户要的是**删除**，不是"换句更短的"。删完那里就是空的。
 *
 * ## ⚠️ 已知副作用（用户已明确接受）
 *
 * 删掉 #2 后，推荐流开关在**无凭据时是灰的却没有原因说明**。
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

/** 找到推荐流开关那一行的 `label` 容器 */
function feedRow(root: HTMLElement): HTMLElement | null {
  for (const row of root.querySelectorAll('.row')) {
    if (
      (row.querySelector('.row-label')?.firstElementChild?.textContent ?? '') ===
      '首页推荐流使用取流账号'
    ) {
      return row as HTMLElement;
    }
  }
  return null;
}

const DELETED = [
  '打开后，首页推荐换成取流账号的',
  '先扫码登录取流账号，才能用它来换首页推荐流',
  '诊断里有 InPrivate 权限',
  '出问题时先看那里',
];

describe('★★★ 三处说明文字全部删除（task-11 唯一需求）', () => {
  for (const text of DELETED) {
    it(`★★★ 「${text}」不出现在任何渲染结果里（无凭据）`, () => {
      /**
       * 无凭据态是最容易漏的：那里原本同时有 #1（hint）和 #2（引导语）。
       *
       * 🔁 反向验证：把任意一句加回 `displayTab()` → 对应本条红。
       */
      const box = displayTab(null, acts({ hasCredential: false }));
      expect(box.textContent ?? '', `「${text}」还在`).not.toContain(text);
    });

    it(`★★ 「${text}」不出现在任何渲染结果里（有凭据）`, () => {
      const box = displayTab(null, acts({ hasCredential: true }));
      expect(box.textContent ?? '').not.toContain(text);
    });
  }
});

describe('★★ 推荐流开关：有 label、**无 hint**', () => {
  it('★★★ 开关的 label 还在（删的是说明，不是开关）', () => {
    const row = feedRow(displayTab(null, acts()));
    expect(row, '推荐流开关整块不见了').not.toBeNull();
    expect(row?.textContent ?? '').toContain('首页推荐流使用取流账号');
  });

  it('★★★ 开关**没有** `row-hint` 子元素（不是空 span 占位）', () => {
    /**
     * 判据是 DOM 结构，不是文字：`switchRow()` 里是
     * `if (input.hint) labelBox.appendChild(...)`，所以不传就是**没有这个节点**。
     *
     * 若有人改成 `hint: ''` 占位，文字断言会绿但会留一个空 `<span class="row-hint">`
     * —— 那是死 DOM（handoff §2.3 第 8 条 `acct-divider` 的同类）。
     *
     * 🔁 反向验证：加回 `hint: '打开后，首页推荐换成取流账号的'` → 本条红。
     */
    const row = feedRow(displayTab(null, acts()));
    expect(row?.querySelector('.row-hint'), 'hint 节点还在（或用了空串占位）').toBeNull();
  });

  it('★★ 其它开关的 hint **不受影响**（只删推荐流那一处）', () => {
    /**
     * 防"删过头"：页内角标的 hint 是它的解释，用户没说要删。
     */
    const box = displayTab(null, acts());
    const all = [...box.querySelectorAll('.row-hint')].map((n) => n.textContent ?? '');
    expect(
      all.some((t) => t.includes('播放器右下角')),
      '角标开关的 hint 被误删了',
    ).toBe(true);
  });
});

describe('★★★ 诊断入口**必须仍然存在**（防删过头）', () => {
  it('★★★ 诊断按钮还在（删的是解释，不是入口）', () => {
    /**
     * 诊断分区是排查 InPrivate 权限的**唯一入口**（`wxt.config.ts` 注释原话）。
     * 若把它连同那句解释一起删掉，用户就再也找不到排查手段了。
     *
     * 🔁 反向验证：把 `box.appendChild(diag)` 删掉 → 本条红。
     */
    const box = displayTab(null, acts());
    const diag = [...box.querySelectorAll('.sub-entry')].find(
      (b) => b.textContent?.startsWith('诊断') === true,
    );
    expect(diag, '诊断入口被一起删掉了').toBeDefined();
  });

  it('★★ 诊断按钮的副标题还在（「自检信息 · 日志 · 导出」）', () => {
    const box = displayTab(null, acts());
    expect(box.textContent ?? '').toContain('自检信息');
  });
});

describe('★★ task-5 的判据**一个字都没回退**', () => {
  it('★★★ 无凭据 → 开关仍然**灰掉**（disabled 判据不变）', () => {
    const row = feedRow(displayTab(null, acts({ hasCredential: false })));
    expect(row?.querySelector('input')?.disabled).toBe(true);
  });

  it('★★★ 无凭据 + 开关原为开 → 仍然渲染成**关**（task-5 的生效状态逻辑）', () => {
    const row = feedRow(displayTab(null, acts({ hasCredential: false, feedAccountEnabled: true })));
    expect(row?.querySelector('input')?.checked, 'task-5 的"报告生效状态"被回退了').toBe(false);
  });

  it('★★ 有凭据 + 开 → 仍然渲染成开、可点', () => {
    const row = feedRow(displayTab(null, acts({ hasCredential: true, feedAccountEnabled: true })));
    const cb = row?.querySelector('input') as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(cb.disabled).toBe(false);
  });
});
