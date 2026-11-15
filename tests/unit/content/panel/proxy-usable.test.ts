// @vitest-environment jsdom

/**
 * 没有可用取流账号时，画质总开关**灰掉且说明原因**（2026-11-12，task-10 第 2 条）。
 *
 * ## 用户裁决（原话）
 *
 * > 「可以保留这个开关原本的状态，但是因为退出了扩展账号所以这个开关
 * > 即便是开着也是没有用了，所以整个开关应变为灰色不可点击」
 *
 * ## 三种情况必须区分（判据只许有一处实现）
 *
 * | 取流身份 | 有凭据 | `isStreamingReady` | 开关 |
 * | --- | --- | --- | --- |
 * | `page` | 无 | `true` | **可点** |
 * | `extension` | 有 | `true` | 可点 |
 * | `extension` | 无 | `false` | **灰** |
 *
 * ⚠️ **`page` 身份下 `hasCredential` 恒为 `false`** —— 只看 `hasCredential`
 * 会把一个**完全可用**的配置误禁。这是本文件最关键的一条。
 *
 * ## 两条纪律（handoff §2.3）
 *
 * - 灰掉**不是不渲染** —— 控件消失是隐形 bug
 * - 灰掉**必须给文字** —— 只灰不说，用户以为控件坏了
 */

import { describe, expect, it } from 'vitest';

import { qualityTab } from '../../../../src/content/panel/tabs';
import type { QualityView } from '../../../../src/content/panel/panel-data';

function quality(overrides: Partial<QualityView> = {}): QualityView {
  return {
    pill: '已接管',
    tone: 'good',
    line: null,
    unlock: null,
    proxyEnabled: true,
    pageKind: 'play',
    ...overrides,
  };
}

function acts(overrides: Record<string, unknown> = {}) {
  return {
    toggleProxy: () => undefined,
    proxyUsable: true,
    proxyDisabledReason: null as string | null,
    ...overrides,
  };
}

/** 找到总开关那一行的 checkbox */
function proxySwitch(root: HTMLElement): HTMLInputElement | null {
  for (const row of root.querySelectorAll('.row')) {
    if (
      (row.querySelector('.row-label')?.firstElementChild?.textContent ?? '') === '自动接管取流'
    ) {
      return row.querySelector('input');
    }
  }
  return null;
}

describe('★★★ 无可用账号 → 总开关灰掉（task-10）', () => {
  it('★★★ `proxyUsable: false` → 开关 disabled', () => {
    /**
     * 反例：`qualityTab` 里把 `disabled` 改回只判 `q.proxyEnabled === null`
     * → 本条必红（开关会变成可点）。
     */
    const box = qualityTab(quality(), acts({ proxyUsable: false }));
    expect(proxySwitch(box)?.disabled, '没有可用账号，开关却还能点').toBe(true);
  });

  it('★★★ 灰掉时必须给原因（不许只灰不说）', () => {
    /**
     * handoff §2.3 记过"开关永久禁用且不说明原因"这一类。
     * 反例：把那段 `else if (!actions.proxyUsable && ...)` 删掉 → 本条必红。
     */
    const box = qualityTab(
      quality(),
      acts({
        proxyUsable: false,
        proxyDisabledReason: '还没有可用的取流账号 —— 到「账号」Tab 扫码登录取流账号后就能打开',
      }),
    );

    expect(box.textContent ?? '', '开关灰着却一个字都不解释').toContain('扫码登录取流账号');
  });

  it('★★ 灰掉的开关**仍然渲染**（不是不渲染 —— 控件消失是隐形 bug）', () => {
    const box = qualityTab(quality(), acts({ proxyUsable: false }));
    expect(proxySwitch(box), '禁用的开关被整个删掉了').not.toBeNull();
  });

  it('★★ 灰掉时**保留**开关原本的位置/标签（用户还能看到这是什么）', () => {
    const box = qualityTab(quality(), acts({ proxyUsable: false }));
    expect(box.textContent ?? '').toContain('自动接管取流');
  });

  it('★★ `proxyUsable: true` → 开关可点、**不**渲染禁用原因（不误伤）', () => {
    const box = qualityTab(quality(), acts({ proxyUsable: true }));

    expect(proxySwitch(box)?.disabled).toBe(false);
    expect(box.textContent ?? '').not.toContain('扫码登录取流账号');
  });
});

describe('★★ 两种"禁用"要分开（读不到状态 vs 没账号）', () => {
  it('★★ 状态读不到（`proxyEnabled: null`）→ 仍然禁用 + 原有的"读取失败"提示', () => {
    const box = qualityTab(quality({ proxyEnabled: null }), acts({ proxyUsable: true }));

    expect(proxySwitch(box)?.disabled).toBe(true);
    expect(box.textContent ?? '').toContain('状态读取失败');
  });

  it('★★ 两者同时成立 → 说"读取失败"而不是"去扫码"（后者会白折腾一次）', () => {
    const box = qualityTab(
      quality({ proxyEnabled: null }),
      acts({ proxyUsable: false, proxyDisabledReason: '还没有可用的取流账号 —— 扫码登录' }),
    );

    const text = box.textContent ?? '';
    expect(text).toContain('状态读取失败');
    expect(text, '状态都读不到，却让用户先去扫码').not.toContain('扫码登录');
  });
});

describe('★★★ 开关的 checked **保留用户原本的状态**（用户裁决的一半）', () => {
  it('★★★ 无账号但开关原本是 true → 仍然显示"开"（只是灰着）', () => {
    /**
     * 用户原话：「**可以保留这个开关原本的状态**」。
     *
     * 所以这里**不许**为了"看起来一致"把它画成关 ——
     * 那是另一个陈述错误事实的方向（用户会以为自己关的）。
     */
    const box = qualityTab(quality({ proxyEnabled: true }), acts({ proxyUsable: false }));

    expect(proxySwitch(box)?.checked, '开关原本是开，被画成了关').toBe(true);
  });

  it('★★ 无账号且开关原本是 false → 显示关', () => {
    const box = qualityTab(quality({ proxyEnabled: false }), acts({ proxyUsable: false }));
    expect(proxySwitch(box)?.checked).toBe(false);
  });
});
