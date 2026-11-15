// @vitest-environment jsdom

/**
 * 退出取流账号 → 用户**一定看得到**发生了什么（2026-11-12，task-3 路径②）。
 *
 * ## 守的是什么
 *
 * 用户原话：「有些时候点击退出取流账号之后再次确认退出，可是扩展的弹窗界面
 * 没有任何变化，导致用户不知道到底有没有真的退出了」。
 *
 * 旧实现把结果写进 `box` 的 `.acct-result`，而 `panel.ts` 的 `render()` 每次
 * 都 `replaceChildren(content, [accountTab(...)])` —— **整个 `box` 被丢弃**，
 * 文案随之消失。而退出成功**必然**触发一次重画（`logout` 实现会重取并 `setModel`），
 * 所以文案几乎总是被自己触发的那次重画冲掉。
 *
 * ## 为什么测 `panel.ts` 的整条链路，而不是只测 `tabs.ts`
 *
 * 只看 `tabs.ts` 会漏掉那个真正致命的环节：**文案落在哪棵子树上**。
 * 一个"调用了回调"的断言在文案照样被 `replaceChildren` 冲掉时**仍然是绿的** ——
 * 那正是旧 bug 的形状。所以这里必须走 `mountPanelBody()`，并且在
 * **重画之后**再断言。
 *
 * ## 反向验证（改回去必须变红）
 *
 * 把 `panel.ts` 里 `accountTab(...)` 的 `notifyResult` 改回"写进 `box`"
 * （或直接删掉这一行），`★` 那几条必红 —— 见完成说明里的记录。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountPanelBody, type PanelController } from '../../../../src/content/panel/panel';
import type { PanelModel } from '../../../../src/content/panel/panel-data';

/** 裁决文件钉死的那两句，从测试**外部**照抄（不许在实现里引用常量再断言常量） */
const TEXT_LOGOUT_OK = '已退出取流账号，取流回退到浏览器当前账号';

/**
 * 建一个「有取流账号」的模型 —— 只有这种形态才会渲染「退出取流账号」按钮
 * （`tabs.ts` 的 `if (pb || a.hasCredential)`）。
 */
function modelWithPlayback(): PanelModel {
  return {
    quality: {
      pill: '已接管',
      tone: 'good',
      line: null,
      unlock: null,
      proxyEnabled: true,
      pageKind: 'play',
    },
    clean: null,
    account: {
      primary: { uname: '主账号', level: 6, loggedIn: 'yes', source: 'live' },
      playback: {
        uname: '取流账号',
        mid: 12345,
        vipLabel: 'annual',
        expireAt: null,
        healthy: true,
        checkedAt: 0,
        reason: null,
      },
      unknown: false,
      hasCredential: true,
      needsLogin: false,
    },
    pageKind: 'play',
    pageStateKind: 'ok',
    pageView: null,
  };
}

/** 「退出后」的模型：卡片该消失、按钮回到「扫码登录取流账号」 */
function modelAfterLogout(): PanelModel {
  const m = modelWithPlayback();
  return {
    ...m,
    account: {
      ...m.account,
      playback: null,
      hasCredential: false,
      needsLogin: true,
    },
  };
}

let controller: PanelController | null = null;
/** 退出请求的应答由每个用例决定 */
let logoutReply: { ok: boolean; detail?: string } = { ok: true };

function acts(overrides: Record<string, unknown> = {}) {
  return {
    login: () => undefined,
    logout: async () => logoutReply,
    streamingIdentity: null,
    toggleStreamingIdentity: () => undefined,
    feedAccountEnabled: false,
    toggleFeedAccount: () => undefined,
    currentStreamingIdentity: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  logoutReply = { ok: true };
  controller = mountPanelBody(acts() as never);
  controller.setModel(modelWithPlayback());
  controller.showTab('account');
});

afterEach(() => {
  vi.useRealTimers();
  document.body.textContent = '';
  controller = null;
});

/** 面板底部的提示条（`root` 级，跨 `replaceChildren` 存活） */
function notice(): HTMLElement | null {
  return controller?.root.querySelector('.panel-notice') ?? null;
}

/** 点「退出取流账号」→「确认退出」（两步确认必须保留） */
function confirmLogout(): void {
  const buttons = [...(controller?.root.querySelectorAll('.acct-btn') ?? [])];
  const removeBtn = buttons.find((b) => b.textContent === '退出取流账号');
  expect(removeBtn, '有取流账号时必须渲染「退出取流账号」按钮').toBeDefined();

  removeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  // 第一步只切文案，不许发请求
  expect(removeBtn?.textContent).toBe('确认退出');

  removeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('★★ 退出成功后，结果提示必须活过面板重画', () => {
  it('★★ 退出成功 → 提示文案出现在 root 级（不是 box 内）', async () => {
    confirmLogout();
    await vi.advanceTimersByTimeAsync(0);

    const bar = notice();
    expect(bar, '退出成功后用户什么提示都没看到').not.toBeNull();
    expect(bar?.textContent).toBe(TEXT_LOGOUT_OK);
  });

  it('★★★ 提示**不被**随后的 setModel/render 冲掉（旧 bug 的核心）', async () => {
    /**
     * 这条是修复的关键证据。
     *
     * 旧实现把文案写进 `box` 的 `.acct-result` —— `setModel()` 一跑
     * `replaceChildren` 就把它丢了。所以这里**必须**在结果出来之后
     * 再模拟"重取完成 → 重画"，然后断言文案还在。
     *
     * 反例：把 `notifyResult` 改回写 `box` → 本条必红（提示条为 null）。
     */
    confirmLogout();
    await vi.advanceTimersByTimeAsync(0);
    expect(notice()?.textContent).toBe(TEXT_LOGOUT_OK);

    // 模拟 `loadOnce()` 成功后的重画（退出成功的正常路径）
    controller?.setModel(modelAfterLogout());
    // 再切一次 Tab，确保不是"恰好没重画"
    controller?.showTab('quality');
    controller?.showTab('account');

    expect(notice(), '提示条被面板重画冲掉了 —— 这正是旧 bug').not.toBeNull();
    expect(notice()?.textContent).toBe(TEXT_LOGOUT_OK);
  });

  it('★★ 提示条**不在** content 子树里（那里每次 render 都被清空）', async () => {
    /**
     * 结构判据，与上一条互补：即使文案活着，若它长在 `content` 里，
     * 下一次 `replaceChildren` 一样会吃掉它。断言"它在 root 但不在 content"。
     */
    confirmLogout();
    await vi.advanceTimersByTimeAsync(0);

    const contentEl = controller?.root.querySelector('.panel-content');
    expect(contentEl, 'content 容器必须存在').not.toBeNull();
    expect(contentEl?.querySelector('.panel-notice') ?? null).toBeNull();
  });

  it('★ 成功提示是**中性色**（不带 danger）', async () => {
    confirmLogout();
    await vi.advanceTimersByTimeAsync(0);

    expect(notice()?.classList.contains('danger')).toBe(false);
  });
});

describe('★★ 退出失败时说清原因（不静默）', () => {
  it('★★ 退出失败 → 提示里带后台给的 detail', async () => {
    logoutReply = { ok: false, detail: '没有可删除的账号' };
    confirmLogout();
    await vi.advanceTimersByTimeAsync(0);

    expect(notice()?.textContent).toContain('退出失败');
    expect(notice()?.textContent).toContain('没有可删除的账号');
  });

  it('★ 退出失败 → 危险色', async () => {
    logoutReply = { ok: false };
    confirmLogout();
    await vi.advanceTimersByTimeAsync(0);

    expect(notice()?.classList.contains('danger')).toBe(true);
  });

  it('★ 退出失败也活过重画（不是只在原地闪一下）', async () => {
    logoutReply = { ok: false, detail: 'x' };
    confirmLogout();
    await vi.advanceTimersByTimeAsync(0);

    controller?.setModel(modelWithPlayback());
    expect(notice()?.textContent).toContain('退出失败');
  });
});

describe('★ 文案纪律（裁决 1 第 2 条）', () => {
  it('★ 成功文案说「浏览器当前账号」，不说内部术语「主账号」', async () => {
    /**
     * 裁决文件：「不要说「主账号」以外的内部术语」——
     * 实际规则是用户能读懂「浏览器当前账号」。旧文案写的
     * 「取流回退到主账号身份」正是要消灭的那句。
     */
    confirmLogout();
    await vi.advanceTimersByTimeAsync(0);

    const text = notice()?.textContent ?? '';
    expect(text).toContain('浏览器当前账号');
    expect(text, '不许再出现旧文案').not.toContain('主账号身份');
    expect(text, '不许出现实现词「凭据」').not.toContain('凭据');
    expect(text, '不许出现实现词「配置」').not.toContain('配置');
  });
});

describe('★★ 两步确认交互必须保留（裁决 1 第 5 条）', () => {
  it('★★ 第一步点击**不发**退出请求，只切文案 + 露出「取消」', async () => {
    const logout = vi.fn(async () => logoutReply);
    controller?.setModel(modelWithPlayback());
    controller = mountPanelBody(acts({ logout }) as never);
    controller.setModel(modelWithPlayback());
    controller.showTab('account');

    const buttons = [...(controller.root.querySelectorAll('.acct-btn') ?? [])];
    const removeBtn = buttons.find((b) => b.textContent === '退出取流账号');
    expect(removeBtn).toBeDefined();

    removeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(logout, '第一步就发了退出请求 —— 防误触失效').not.toHaveBeenCalled();
    expect(removeBtn?.textContent).toBe('确认退出');
    expect(removeBtn?.classList.contains('danger')).toBe(true);

    const cancel = [...controller.root.querySelectorAll('.acct-btn')].find(
      (b) => b.textContent === '取消',
    ) as HTMLElement | undefined;
    expect(cancel, '第一步之后必须出现「取消」').toBeDefined();
    expect(cancel?.style.display).not.toBe('none');
  });

  it('★ 点「取消」回到非确认态，且不发请求', async () => {
    const logout = vi.fn(async () => logoutReply);
    controller?.setModel(modelWithPlayback());
    controller = mountPanelBody(acts({ logout }) as never);
    controller.setModel(modelWithPlayback());
    controller.showTab('account');

    const buttons = [...controller.root.querySelectorAll('.acct-btn')];
    const removeBtn = buttons.find((b) => b.textContent === '退出取流账号') as HTMLElement;
    removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const cancel = [...controller.root.querySelectorAll('.acct-btn')].find(
      (b) => b.textContent === '取消',
    ) as HTMLElement;
    cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(removeBtn.textContent).toBe('退出取流账号');
    expect(removeBtn.classList.contains('danger')).toBe(false);
    expect(logout).not.toHaveBeenCalled();
  });

  it('★★ 全程不出现 confirm()/alert()（02-ui-spec §7）', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    confirmLogout();
    await vi.advanceTimersByTimeAsync(0);

    expect(confirmSpy, '用了 confirm()').not.toHaveBeenCalled();
    expect(alertSpy, '用了 alert()').not.toHaveBeenCalled();

    confirmSpy.mockRestore();
    alertSpy.mockRestore();
  });
});
