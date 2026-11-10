// @vitest-environment jsdom

/**
 * 面板底部提示条的**自动消失**行为（2026-11-10）。
 *
 * ## 规则
 *
 * | 类型 | 自动清除 | 为什么 |
 * | --- | --- | --- |
 * | 成功 / 中性（`ok: true`） | ✅ 5 秒 | 用户看一眼就够，留着占地方 |
 * | **失败（`ok: false`）** | ❌ **常驻** | 用户可能正在读、或已经去开权限了 —— 回来时提示还在 |
 *
 * 失败常驻是**刻意的**：这一轮的核心修复之一就是"点了没反应"，
 * 而自动消失会让用户错过原因。下一次 `showNotice` 会替换掉它。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountPanelBody, type PanelController } from '../../../src/content/panel/panel';
import type { PanelModel } from '../../../src/content/panel/panel-data';

/** 最小可用模型（提示条测试不关心内容） */
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
    clean: null,
    account: {
      primary: { uname: null, level: null, loggedIn: 'unknown', source: 'none' },
      playback: null,
      unknown: false,
      hasCredential: false,
      needsLogin: true,
    },
    pageKind: 'other',
    pageStateKind: 'ok',
    pageView: null,
  };
}

let controller: PanelController | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  controller = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
  controller.setModel(model());
});

afterEach(() => {
  vi.useRealTimers();
  document.body.textContent = '';
});

function notice(): HTMLElement | null {
  return controller?.root.querySelector('.panel-notice') ?? null;
}

describe('★★ 成功类提示 5 秒后自动消失', () => {
  it('★★ showNotice(ok=true) → 5 秒后节点被移除', () => {
    /**
     * 反例：去掉 `setTimeout(... bar.remove())` → 本条必红（节点一直在）。
     */
    controller?.showNotice('扫码窗口已打开', true);
    expect(notice()?.textContent).toBe('扫码窗口已打开');

    vi.advanceTimersByTime(4_999);
    expect(notice(), '还没到 5 秒就消失了').not.toBeNull();

    vi.advanceTimersByTime(2);
    expect(notice(), '5 秒后应该自动消失').toBeNull();
  });
});

describe('★★ 失败类提示**不**自动消失', () => {
  it('★★ showNotice(ok=false) → 10 秒后仍在', () => {
    /**
     * 这一轮的核心修复之一就是"点了没反应"。失败提示自动消失会让用户
     * 错过原因（他可能正要去开 InPrivate 权限，回来时提示没了就不知道发生了什么）。
     */
    controller?.showNotice('需要先在扩展详情页打开「在 InPrivate 中允许」', false);
    expect(notice()).not.toBeNull();

    vi.advanceTimersByTime(60_000);
    expect(notice(), '失败提示不该自动消失').not.toBeNull();
    expect(notice()?.textContent).toContain('InPrivate');
  });

  it('★ 失败提示带 danger 样式', () => {
    controller?.showNotice('登录窗口打不开', false);
    expect(notice()?.classList.contains('danger')).toBe(true);
  });

  it('★ 成功提示不带 danger 样式', () => {
    controller?.showNotice('已打开', true);
    expect(notice()?.classList.contains('danger')).toBe(false);
  });
});

describe('★ 替换与定时器管理', () => {
  it('★ 新提示替换旧的（不堆积）', () => {
    controller?.showNotice('第一条', true);
    controller?.showNotice('第二条', true);
    expect(controller?.root.querySelectorAll('.panel-notice').length).toBe(1);
    expect(notice()?.textContent).toBe('第二条');
  });

  it('★★ 新的成功提示**不会**被上一条的定时器提前抹掉', () => {
    /**
     * 反例：不清旧定时器 → 第一次的 5 秒到点时会把**第二条**删掉。
     * 真机表现：用户看到提示闪一下就没了。
     */
    controller?.showNotice('第一条', true);
    vi.advanceTimersByTime(3_000);

    controller?.showNotice('第二条', true);
    // 第一条的定时器本该在此时到点 —— 必须已被清掉
    vi.advanceTimersByTime(3_000);

    expect(notice()?.textContent, '第二条被第一条的定时器抹掉了').toBe('第二条');
  });

  it('★ 成功提示在 5 秒内被失败提示替换 → 不会到点删掉失败提示', () => {
    controller?.showNotice('已打开', true);
    vi.advanceTimersByTime(3_000);

    controller?.showNotice('打不开', false);
    // 原定时器到点
    vi.advanceTimersByTime(3_000);

    expect(notice()?.textContent).toBe('打不开');
  });

  it('提示条挂在 root 上，切 Tab 不会消失', () => {
    controller?.showNotice('打不开', false);
    controller?.showTab('account');
    expect(notice(), '切 Tab 后提示被清掉了').not.toBeNull();
  });
});
