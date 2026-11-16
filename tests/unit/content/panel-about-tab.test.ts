// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { aboutTab } from '@/src/content/panel/tabs';
import type { UpdateStatusView } from '@shared/types/update';
import { CONTRIBUTORS } from '@/src/generated/contributors';

function view(over: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    currentVersion: '1.1.0',
    latestVersion: null,
    latestSizeBytes: null,
    latestZipUrl: null,
    phase: 'idle',
    autoCheckEnabled: true,
    intervalDays: 1,
    lastCheckAt: Date.now() - 3 * 60_000,
    lastAppliedVersion: null,
    lastFailedVersion: null,
    ...over,
  };
}

const noop = {
  check: () => {},
  openUpdate: () => {},
  openReleases: () => {},
  toggleAuto: () => {},
  busy: false,
};

function text(node: HTMLElement, testid: string): string {
  return node.querySelector(`[data-testid="${testid}"]`)?.textContent ?? '';
}

describe('aboutTab：读不到状态时不许谎报', () => {
  it('view 为 null ⇒ 只说读不到，不显示"已是最新"', () => {
    const node = aboutTab(null, noop);
    expect(node.textContent).toContain('读不到更新状态');
    expect(node.textContent).not.toContain('已是最新');
    // 也没有版本号可显示
    expect(text(node, 'update-version')).toBe('');
  });
});

describe('aboutTab：版本行', () => {
  it('无新版 ⇒ 已是最新，且不写"最新 v1.1.0"这种重复信息', () => {
    const node = aboutTab(view(), noop);
    expect(text(node, 'update-version')).toBe('当前 v1.1.0 · 已是最新');
  });

  it('有新版 ⇒ 带上体积（283 KB 这种量级）', () => {
    const node = aboutTab(
      view({ latestVersion: '1.2.0', latestSizeBytes: 289_831, phase: 'available' }),
      noop,
    );
    const line = text(node, 'update-version');
    expect(line).toContain('当前 v1.1.0');
    expect(line).toContain('最新 v1.2.0');
    expect(line).toContain('283 KB');
  });

  it('体积缺失时不显示一对空括号', () => {
    const node = aboutTab(view({ latestVersion: '1.2.0', latestSizeBytes: null }), noop);
    expect(text(node, 'update-version')).toBe('当前 v1.1.0 · 最新 v1.2.0');
  });

  it('上次检查用相对说法', () => {
    const node = aboutTab(view({ lastCheckAt: Date.now() - 3 * 60_000 }), noop);
    expect(text(node, 'update-last-check')).toBe('上次检查 3 分钟前');
  });

  it('从未检查过 ⇒ 说"从未检查"', () => {
    const node = aboutTab(view({ lastCheckAt: null }), noop);
    expect(text(node, 'update-last-check')).toBe('上次检查 从未检查');
  });

  it('时钟回拨（lastCheckAt 在未来）⇒ 说"刚刚"，不显示负数', () => {
    const node = aboutTab(view({ lastCheckAt: Date.now() + 10 * 60_000 }), noop);
    expect(text(node, 'update-last-check')).toBe('上次检查 刚刚');
  });
});

describe('aboutTab：控件', () => {
  it('点「检查更新」回调一次', () => {
    const check = vi.fn();
    const node = aboutTab(view(), { ...noop, check });
    (node.querySelector('[data-testid="update-check"]') as HTMLButtonElement).click();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('busy 时按钮置灰、文案改成"检查中…"', () => {
    const node = aboutTab(view(), { ...noop, busy: true });
    const btn = node.querySelector('[data-testid="update-check"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('检查中…');
  });

  it('没有新版时「立即更新」禁用（点了也只会拿到"没有可更新的版本"）', () => {
    const node = aboutTab(view(), noop);
    expect((node.querySelector('[data-testid="update-now"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('有新版时「立即更新」可点，且与 Releases 是两个独立回调', () => {
    const openUpdate = vi.fn();
    const openReleases = vi.fn();
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'available' }), {
      ...noop,
      openUpdate,
      openReleases,
    });
    const btn = node.querySelector('[data-testid="update-now"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(openUpdate).toHaveBeenCalledTimes(1);
    expect(openReleases).not.toHaveBeenCalled();
  });

  /**
   * 护栏：dismiss 只表示"不再提示"，**不代表没有更新**。
   *
   * 曾经的写法是 `disabled = view.phase !== 'available'`，加上"进「关于」Tab 自动 dismiss"
   * 之后，用户一进来按钮就被永久禁用 —— 从此无法更新，比"红点消不掉"更严重。
   * 这条测试就是钉住那次回归。
   */
  it('phase 是 dismissed 时「立即更新」**必须仍可点**（否则一进关于页就再也更新不了）', () => {
    const openUpdate = vi.fn();
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'dismissed' }), {
      ...noop,
      openUpdate,
    });
    const btn = node.querySelector('[data-testid="update-now"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(openUpdate).toHaveBeenCalledTimes(1);
  });

  it('phase 是 dismissed 时版本行仍说"最新 v1.2.0"，不许谎报"已是最新"', () => {
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'dismissed' }), noop);
    const line = text(node, 'update-version');
    expect(line).toContain('最新 v1.2.0');
    expect(line).not.toContain('已是最新');
  });

  it('只有真的没有新版（idle / pending-reload）才禁用「立即更新」', () => {
    for (const phase of ['idle', 'pending-reload'] as const) {
      const node = aboutTab(view({ phase }), noop);
      expect((node.querySelector('[data-testid="update-now"]') as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
  });

  it('点 Releases 走 openReleases（与"检查更新"是两个独立动作）', () => {
    const openReleases = vi.fn();
    const node = aboutTab(view(), { ...noop, openReleases });
    (node.querySelector('[data-testid="update-releases"]') as HTMLButtonElement).click();
    expect(openReleases).toHaveBeenCalledTimes(1);
  });

  it('自动检查开关文案不许写成"启用更新检查"（会让人以为手动也失效）', () => {
    const node = aboutTab(view({ autoCheckEnabled: false }), noop);
    expect(node.textContent).toContain('自动检查更新');
    expect(node.textContent).toContain('关掉后仍可手动检查');
  });
});

describe('贡献者清单（Step 7）', () => {
  it('生成物里没有 Bot、没有超量', () => {
    // 这份数据由 scripts/gen-contributors.mjs 生成，这里只核对"生成规则真的生效了"
    expect(CONTRIBUTORS.length).toBeGreaterThan(0);
    expect(CONTRIBUTORS.length).toBeLessThanOrEqual(12);
    for (const person of CONTRIBUTORS) {
      expect(person.login.toLowerCase()).not.toContain('[bot]');
      expect(person.avatarUrl.startsWith('https://')).toBe(true);
      expect(person.htmlUrl.startsWith('https://github.com/')).toBe(true);
    }
  });

  it('按 contributions 降序', () => {
    const counts = CONTRIBUTORS.map((p) => p.contributions);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('面板里渲染出每一位的 login（头像是修饰，名字是必须的）', () => {
    const node = aboutTab(view(), noop);
    for (const person of CONTRIBUTORS) {
      expect(node.textContent).toContain(person.login);
    }
  });

  it('点头像/名字走 open，不触发面板其他动作', () => {
    const node = aboutTab(view(), noop);
    const first = node.querySelector('.contributor') as HTMLButtonElement;
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    first.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]?.[0])).toContain('github.com/');
    open.mockRestore();
  });
});

describe('失败提示的样式类（真机截图暴露过一次）', () => {
  it('用的是现有的 .warn，不是不存在的 .warning', () => {
    const node = aboutTab(view({ lastFailedVersion: '1.2.0' }), noop);
    const el = node.querySelector('[data-testid="update-failed"]');
    expect(el?.className).toBe('pane-note warn');
  });
});
