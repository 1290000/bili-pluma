// @vitest-environment jsdom

/**
 * 总开关的"能不能点"由**面板层**算，判据走 `isStreamingReady()`（task-10）。
 *
 * ## 为什么这条必须单独测
 *
 * `qualityTab()` 只接收**算好的结论**（`proxyUsable`）。真正容易错的是**谁去算、用什么算**：
 *
 * | 取流身份 | 有凭据 | `isStreamingReady` | 正确结果 |
 * | --- | --- | --- | --- |
 * | `page` | **无** | **`true`** | **可点** ← 最容易写错的一条 |
 * | `extension` | 有 | `true` | 可点 |
 * | `extension` | 无 | `false` | 灰 |
 *
 * ⚠️ **`page` 身份下 `hasCredential` 恒为 `false`**。若判据写成 `hasCredential`，
 * 一个**完全可用**的配置会被误禁 —— 这是 `isStreamingReady()` 被抽出来的原因
 * （`streaming-identity.ts`：「这是一条判据，只许有一处实现」）。
 *
 * ## 反向验证
 *
 * 把 `panel.ts` 的判据改成 `model.account.hasCredential` → `page` 那条必红。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountPanelBody } from '../../../../src/content/panel/panel';
import type { PanelController } from '../../../../src/content/panel/panel';
import type { PanelModel } from '../../../../src/content/panel/panel-data';
import type { StreamingIdentity } from '../../../../src/shared/constants/streaming-identity';

function modelWith(hasCredential: boolean): PanelModel {
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
      playback: null,
      unknown: false,
      hasCredential,
      needsLogin: !hasCredential,
      proxyEnabled: true,
    },
    pageKind: 'play',
    pageStateKind: 'ok',
    pageView: null,
  };
}

function acts(identity: StreamingIdentity | null) {
  return {
    login: () => undefined,
    logout: async () => ({ ok: true }),
    streamingIdentity: identity,
    toggleStreamingIdentity: () => undefined,
    feedAccountEnabled: false,
    toggleFeedAccount: () => undefined,
    currentStreamingIdentity: () => identity,
  };
}

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

/** 同上，但能控制 `proxyEnabled`（`null` = 读不到 `proxy/status`） */
function modelWithProxy(hasCredential: boolean, proxyEnabled: boolean | null): PanelModel {
  const base = modelWith(hasCredential);
  return { ...base, quality: { ...base.quality, proxyEnabled } };
}

/** 取「自动接管取流」那一行的**行元素**（不是开关） */
function proxyRow(root: HTMLElement): HTMLElement | null {
  for (const row of root.querySelectorAll('.row')) {
    if (
      (row.querySelector('.row-label')?.firstElementChild?.textContent ?? '') === '自动接管取流'
    ) {
      return row as HTMLElement;
    }
  }
  return null;
}

let controller: PanelController | null = null;

beforeEach(() => {
  document.body.textContent = '';
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async () => ({ type: 'proxy/set:ok' })),
      getManifest: () => ({ version: 't' }),
    },
  });
});

describe('★★★ `page` 身份下**不许**因 `hasCredential:false` 误禁总开关', () => {
  it('★★★ page + 无凭据 → 开关**可点**（这是最容易写错的一条）', () => {
    /**
     * `page` 身份 = 用浏览器当前登录态取流，**本就不需要**扩展存凭据。
     * 此时 `hasCredential` 恒为 `false`，但功能完全可用。
     *
     * 反例：把 `panel.ts` 的判据改成 `model.account.hasCredential`
     * → 本条必红（开关被误禁）。
     */
    controller = mountPanelBody(acts('page') as never);
    controller.setModel(modelWith(false));
    controller.showTab('quality');

    expect(proxySwitch(controller.root)?.disabled, 'page 身份本该完全可用，开关却被误禁了').toBe(
      false,
    );
  });

  it('★★ page + 无凭据 → **不**渲染"去扫码"的提示（不误导）', () => {
    controller = mountPanelBody(acts('page') as never);
    controller.setModel(modelWith(false));
    controller.showTab('quality');

    expect(controller.root.textContent ?? '').not.toContain('扫码登录取流账号');
  });
});

describe('★★ `extension` 身份下按凭据判断', () => {
  it('★★ extension + 无凭据 → **灰** + 说明原因', () => {
    controller = mountPanelBody(acts('extension') as never);
    controller.setModel(modelWith(false));
    controller.showTab('quality');

    expect(proxySwitch(controller.root)?.disabled, 'extension 无凭据却还能点').toBe(true);
    expect(controller.root.textContent ?? '', '灰了却不解释').toContain('扫码登录取流账号');
  });

  it('★★ extension + 有凭据 → 可点', () => {
    controller = mountPanelBody(acts('extension') as never);
    controller.setModel(modelWith(true));
    controller.showTab('quality');

    expect(proxySwitch(controller.root)?.disabled).toBe(false);
  });
});

describe('★ 身份未知时不擅自禁用', () => {
  it('★ 身份 `null`（还没读到）→ **不禁**（不知道就别替用户下结论）', () => {
    /**
     * 与 `panel-data.ts` 的"缺参数不改口"同一纪律。
     *
     * 理由：身份读不到 ≠ 没有账号。此时禁用会让一个**可能完全可用**的配置
     * 变成不可用；而不禁最强也只是让用户点一下，`toggleProxy` 照常发消息。
     *
     * 反例：把 `known === null ||` 删掉（当成 `extension` 处理）→ 本条可能红。
     */
    controller = mountPanelBody(acts(null) as never);
    controller.setModel(modelWith(false));
    controller.showTab('quality');

    expect(proxySwitch(controller.root)?.disabled, '身份未知就擅自禁用了').toBe(false);
  });
});

/**
 * 「灰法」：**两种灰不是一回事**（2026-11-17）。
 *
 * `switchRow` 的 `disabled` 只表盘淡（**此刻**不可操作，会自己恢复），
 * `dim` 整行淡（**本质**不可用，得先去满足依赖）。
 *
 * 「自动接管取流」的判据是混合的，所以 dim 只认其中**根本**的那一半：
 *
 * | 情形 | 本质？ | 该怎样 |
 * | --- | --- | --- |
 * | 没有可用账号（`!proxyUsable`） | 本质不可用 | 整行淡 |
 * | 状态读不到（`proxyEnabled === null`） | 此刻不可操作 | 只表盘淡 |
 *
 * ⚠️ 所以是 `dim: !proxyUsable`，**不是** `dim: proxyDisabled`（后者把两者混在一起）。
 */
describe('★★ 整行淡只用于"本质不可用"（没账号），不用于"读不到状态"', () => {
  it('★★ extension + 无凭据（proxyUsable=false）⇒ 整行淡', () => {
    controller = mountPanelBody(acts('extension') as never);
    controller.setModel(modelWithProxy(false, true));
    controller.showTab('quality');

    expect(proxyRow(controller.root)?.classList.contains('dim'), '没账号是根本缺条件').toBe(true);
    expect(proxySwitch(controller.root)?.disabled).toBe(true);
  });

  it('★★ 只是状态读不到（proxyEnabled=null，但账号可用）⇒ **不**整行淡', () => {
    // `page` 身份 ⇒ isStreamingReady 为 true ⇒ proxyUsable=true
    controller = mountPanelBody(acts('page') as never);
    controller.setModel(modelWithProxy(false, null));
    controller.showTab('quality');

    expect(
      proxyRow(controller.root)?.classList.contains('dim'),
      '读不到状态会自己恢复，按整行暗等于说"这功能坏了"',
    ).toBe(false);
    // 但它此刻确实不可操作 ⇒ 仍然禁用（表盘淡）
    expect(proxySwitch(controller.root)?.disabled).toBe(true);
  });

  it('★ 两者同时成立（没账号 + 读不到状态）⇒ 整行淡（没账号是更根本的原因）', () => {
    controller = mountPanelBody(acts('extension') as never);
    controller.setModel(modelWithProxy(false, null));
    controller.showTab('quality');

    expect(proxyRow(controller.root)?.classList.contains('dim')).toBe(true);
    expect(proxySwitch(controller.root)?.disabled).toBe(true);
  });

  it('★ 有凭据且状态正常 ⇒ 不淡、可点', () => {
    controller = mountPanelBody(acts('extension') as never);
    controller.setModel(modelWithProxy(true, true));
    controller.showTab('quality');

    expect(proxyRow(controller.root)?.classList.contains('dim')).toBe(false);
    expect(proxySwitch(controller.root)?.disabled).toBe(false);
  });
});
