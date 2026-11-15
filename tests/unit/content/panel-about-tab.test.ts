// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { aboutTab } from '@/src/content/panel/tabs';
import type { UpdateStatusView } from '@shared/types/update';

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
