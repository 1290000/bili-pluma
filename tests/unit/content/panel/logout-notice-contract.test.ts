// @vitest-environment jsdom

/**
 * 取数失败**不许静默**（2026-11-12，task-3 修路径①）+ 退出后的三条文案契约。
 *
 * ## 守的是什么
 *
 * `entrypoints/content-panel.content.ts` 的 `loadOnce()` 旧实现是裸
 * `catch { return null; }` —— 既不重画也不提示，面板**保持上一帧的模型**。
 * 退出路径上这表现为「点了确认退出，界面什么都没变」：旧模型里
 * `hasCredential` 仍为 true、`pb` 仍非空，于是取流卡片还在、按钮还是「重新登录」。
 *
 * 这与用户说的「**有些时候**」吻合（`loadPanelModel` 并发 4 条消息，任一失败即 throw）。
 *
 * ## ⚠️ 为什么这个文件测的是"文案契约 + 提示通道"，不是 `loadOnce()` 本身
 *
 * `content-panel.content.ts` 是 **WXT 入口**（`defineContentScript()` 在 import 时
 * 就有副作用，依赖 `chrome.*` 与真实 content-script 环境），**没有任何单测能 import 它**
 * —— 这是 `pgc-proxy-off.test.ts` 与 `content-entry.test.ts` 都记过的既有约束。
 *
 * 所以把可测的部分**提出来到 `panel.ts`**（那在写域内）：
 *   - 三条文案常量（`NOTICE_LOGOUT_OK` / `NOTICE_LOGOUT_REFRESH_FAILED` / `NOTICE_LOAD_FAILED`）
 *   - `describeLogoutNotice()` 纯函数
 *   - `showNotice()` / `clearNotice()` 通道
 *
 * 入口那几行调用点由 `tests/unit/content/panel/entry-wiring.test.ts` 做
 * **源码接线断言**（与 `panel-quality-page-identity.test.ts` 同一手法，
 * 且那里明确说了"入口只能这样测"）。
 *
 * ## 反向验证
 *
 * 见每条用例里的"反例"注释与完成说明里的记录。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NOTICE_LOAD_FAILED,
  NOTICE_LOGOUT_OK,
  NOTICE_LOGOUT_REFRESH_FAILED,
  describeLogoutNotice,
  mountPanelBody,
  type PanelController,
} from '../../../../src/content/panel/panel';
import type { PanelModel } from '../../../../src/content/panel/panel-data';

const ACTS = {
  login: () => undefined,
  logout: async () => ({ ok: true }),
  streamingIdentity: null,
  toggleStreamingIdentity: () => undefined,
  feedAccountEnabled: false,
  toggleFeedAccount: () => undefined,
  currentStreamingIdentity: () => undefined,
};

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
  controller = mountPanelBody(ACTS as never);
  controller.setModel(model());
});

afterEach(() => {
  vi.useRealTimers();
  document.body.textContent = '';
  controller = null;
});

function notice(): HTMLElement | null {
  return controller?.root.querySelector('.panel-notice') ?? null;
}

describe('★★★ 三条文案必须与裁决文件逐字一致', () => {
  it('★★★ 退出成功文案', () => {
    /**
     * 裁决文件原文：「已退出取流账号，取流回退到浏览器当前账号」。
     *
     * 反例：改回旧文案「取流回退到主账号身份」→ 本条必红。
     */
    expect(NOTICE_LOGOUT_OK).toBe('已退出取流账号，取流回退到浏览器当前账号');
  });

  it('★★★ 退出成功但刷新失败的文案', () => {
    /**
     * 裁决文件原文：「已退出，但界面刷新失败 —— 收起重开面板可刷新」。
     *
     * 反例：写成「主浏览器账号」或漏掉动作 → 本条必红。
     */
    expect(NOTICE_LOGOUT_REFRESH_FAILED).toBe('已退出，但界面刷新失败 —— 收起重开面板可刷新');
  });

  it('★★ 取数失败文案给出可执行的动作', () => {
    expect(NOTICE_LOAD_FAILED).toContain('收起重开面板');
  });

  it('★★ 三条文案都不含内部术语', () => {
    /**
     * 裁决 1 第 2 条：不要说内部术语。三个词是本轮明确点名的：
     * 「主账号」（用户视角叫"浏览器当前账号"）、「凭据」、「配置」。
     */
    for (const text of [NOTICE_LOGOUT_OK, NOTICE_LOGOUT_REFRESH_FAILED, NOTICE_LOAD_FAILED]) {
      expect(text, `「${text}」含内部术语「主账号」`).not.toContain('主账号');
      expect(text, `「${text}」含实现词「凭据」`).not.toContain('凭据');
      expect(text, `「${text}」含实现词「配置」`).not.toContain('配置');
    }
  });
});

describe('★★ describeLogoutNotice：三种结局各给正确结论', () => {
  it('★★ 成功 → 成功文案 + 中性色', () => {
    expect(describeLogoutNotice({ ok: true })).toEqual({ text: NOTICE_LOGOUT_OK, ok: true });
  });

  it('★★ 失败 → 带 detail 的失败文案 + 危险色', () => {
    const r = describeLogoutNotice({ ok: false, detail: '没有可删除的账号' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('退出失败');
    expect(r.text).toContain('没有可删除的账号');
  });

  it('★ 失败但没有 detail → 不编原因，写「未知原因」', () => {
    const r = describeLogoutNotice({ ok: false });
    expect(r.text).toContain('未知原因');
  });
});

describe('★★ 取数失败必须落到界面上（不再静默）', () => {
  it('★★★ 走 showNotice 报失败 → 用户能看到文字（旧实现什么都不说）', () => {
    /**
     * 这是 `loadOnce()` 失败分支的**行为等价物**：入口在 catch 里做的就是这一句。
     *
     * 反例：把入口 catch 里的 `showNotice(...)` 删掉（退回裸 `return null`）
     * → `entry-wiring.test.ts` 的接线断言必红（本文件测通道，那里测接线）。
     */
    controller?.showNotice(NOTICE_LOAD_FAILED, false);

    expect(notice(), '取数失败后用户一个字都看不到').not.toBeNull();
    expect(notice()?.textContent).toBe(NOTICE_LOAD_FAILED);
  });

  it('★★ 失败提示是危险色且**常驻**（不给红字加超时 —— 裁决 3 明令）', () => {
    controller?.showNotice(NOTICE_LOAD_FAILED, false);
    expect(notice()?.classList.contains('danger')).toBe(true);

    vi.advanceTimersByTime(120_000);
    expect(notice(), '失败提示自动消失了 —— 用户会错过原因').not.toBeNull();
  });

  it('★★ 提示挂在 root 上，切 Tab / 重画都不消失', () => {
    controller?.showNotice(NOTICE_LOAD_FAILED, false);

    controller?.setModel(model());
    controller?.showTab('account');
    controller?.showTab('quality');

    expect(notice()?.textContent).toBe(NOTICE_LOAD_FAILED);
  });
});

describe('★★ clearNotice：点按钮前先清掉上一条（裁决 3）', () => {
  it('★★★ 清掉之后旧红字不在了（用户能分清是不是这次失败的）', () => {
    /**
     * 取证 D.2：用户开完权限回来点按钮，底下还挂着**上一次**的红字，
     * 两条红字长得一样 → 分不清新旧 → 以为"权限开了也没用"。
     *
     * 反例：入口 `openLogin()` 里删掉 `controller?.clearNotice()`
     * → `entry-wiring.test.ts` 的接线断言必红。
     */
    controller?.showNotice('上一次的失败', false);
    expect(notice()).not.toBeNull();

    controller?.clearNotice();
    expect(notice(), 'clearNotice 之后旧提示还在').toBeNull();
  });

  it('★★ 清掉成功色的也清（不区分成败色）', () => {
    controller?.showNotice('扫码窗口已打开', true);
    controller?.clearNotice();
    expect(notice()).toBeNull();
  });

  it('★ 清掉后再报新失败 → 只剩一条，且是新那条', () => {
    controller?.showNotice('上一次的失败', false);
    controller?.clearNotice();
    controller?.showNotice('这一次的失败', false);

    expect(controller?.root.querySelectorAll('.panel-notice').length).toBe(1);
    expect(notice()?.textContent).toBe('这一次的失败');
  });

  it('★ 清掉时也清掉成功提示的定时器（不留悬空 timer 误删后续提示）', () => {
    controller?.showNotice('第一条', true);
    controller?.clearNotice();
    // 若旧定时器还在，5 秒到点会去 remove 一个已经不在/已换的节点
    controller?.showNotice('第二条', true);

    vi.advanceTimersByTime(4_000);
    expect(notice()?.textContent, '残留定时器把新提示提前抹掉了').toBe('第二条');
  });

  it('★ 没有提示时调 clearNotice 不抛错（幂等）', () => {
    expect(() => controller?.clearNotice()).not.toThrow();
    expect(notice()).toBeNull();
  });
});
