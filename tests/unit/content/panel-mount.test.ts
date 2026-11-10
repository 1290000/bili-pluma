// @vitest-environment jsdom

/**
 * 页内侧栏面板的**挂载点健壮性**冒烟测试（1.1.0 阶段 1）。
 *
 * ## 为什么需要这个文件
 *
 * `panel/host.ts` 的挂载路径和 `badge.ts` 是同一个形状，而 `badge.ts` 那条
 * `document.body ?? document.documentElement` 是**真机 TypeError 之后**才补的
 * （见 `tests/unit/content/badge-render-mount.test.ts` 与 `badge.ts` 的注释）。
 *
 * 新写的宿主如果只测"能挂上"，那么把兜底那行删掉，测试**仍然是绿的** ——
 * 等于这次没有守住任何东西。所以这里必须**构造性地**测 body 为 null 的那条路径。
 *
 * ## 这个文件守什么
 *
 * | 场景 | 期望 |
 * | --- | --- |
 * | 正常挂载 | 宿主出现在 body 下，`z-index` 是实测过的那个值 |
 * | **`document.body === null`** | **不抛错**，改挂 `documentElement` |
 * | 重复调用 | 幂等：只有一个宿主（`attachShadow` 二次调用会抛 NotSupportedError） |
 * | 摘除 | 两条挂载路径都能摘掉（不会永久残留） |
 *
 * ⚠️ 这里**不测视觉**（颜色/间距）—— 那是真机的事，jsdom 没有布局。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  PANEL_HOST_ID,
  ensurePanelHost,
  isPanelMounted,
  removePanelHost,
} from '../../../src/content/panel/host';
import { PANEL_CSS, mountSidebar } from '../../../src/content/panel/sidebar';

const TOKENS = ':host, :root { --pluma-accent: #378add; }';

/** 建宿主 + 侧栏，返回 shadow root（host.ts 不导出 shadow，测试自己留引用） */
function mount(): ShadowRoot | null {
  let shadow: ShadowRoot | null = null;
  shadow = ensurePanelHost(TOKENS, PANEL_CSS, (s) => {
    mountSidebar(s);
  });
  return shadow;
}

beforeEach(() => {
  removePanelHost();
  expect(document.body).not.toBeNull();
});

describe('页内面板挂载', () => {
  it('挂到 body 上，且 z-index 是阶段 0 实测用的最高值', () => {
    mount();
    const host = document.getElementById(PANEL_HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.parentElement).toBe(document.body);
    // ADR 0033：直播页 iframe 覆盖左侧，靠这个值才能 shadowHostHitIndex === 0
    expect(host?.style.zIndex).toBe('2147483647');
  });

  it('tokens.css 先进 shadow，面板样式在后（顺序反了变量全失效）', () => {
    const shadow = mount();
    expect(shadow).not.toBeNull();
    const styles = shadow?.querySelectorAll('style') ?? [];
    expect(styles.length).toBe(2);
    expect(styles[0]?.textContent).toBe(TOKENS);
    expect(styles[1]?.textContent).toBe(PANEL_CSS);
  });

  it('★ tokens 为空串时必须抛错，不能静默挂一个没颜色的面板', () => {
    /**
     * ## 为什么这条不能省（2026-11-10 verifier 指出）
     *
     * `tokens.css` 的传入**只靠入口那一行** `import tokensCss from '…tokens.css?raw'`。
     * 那行被删掉 / `?raw` 写错时，传进来的是 `undefined` 或 `''` ——
     * 类型合法、构建通过、宿主照样挂上，但所有 `var(--pluma-*)` 落空：
     * 面板变成一块没有任何颜色/边框/字号的裸元素。
     *
     * 它**看起来"已经工作了"**（有 DOM、能点、能展开），所以没人会去查。
     * 这正是本项目反复记录过的"静默失效"形状。
     *
     * 反例：把 `host.ts` 里那段空值检查删掉 → 本条必红。
     */
    expect(() => {
      ensurePanelHost('', PANEL_CSS, (s) => mountSidebar(s));
    }).toThrow(/tokens\.css 文本为空/);

    // 抛错之后**不许**留下半个宿主（否则页面上残留一个空壳）
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull();
  });

  it('tokens 是纯空白时同样抛错', () => {
    expect(() => {
      ensurePanelHost('   \n\t  ', PANEL_CSS, (s) => mountSidebar(s));
    }).toThrow(/tokens\.css 文本为空/);
  });

  it('★ body 为 null 时不抛错，改挂 documentElement', () => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(document, 'body');
    Object.defineProperty(document, 'body', { configurable: true, get: () => null });
    try {
      expect(document.body).toBeNull();
      expect(() => {
        mount();
      }).not.toThrow();
      const host = document.getElementById(PANEL_HOST_ID);
      expect(host).not.toBeNull();
      expect(host?.parentElement).toBe(document.documentElement);
    } finally {
      // 必须删**实例自有属性**让原型 getter 恢复，见 badge-render-mount.test.ts 的踩坑记录
      Reflect.deleteProperty(document as unknown as Record<string, unknown>, 'body');
      if (ownDescriptor) Object.defineProperty(document, 'body', ownDescriptor);
    }
    expect(document.body).not.toBeNull();
  });

  it('重复调用是幂等的（不会抛 attachShadow 二次调用的错）', () => {
    mount();
    expect(() => {
      mount();
    }).not.toThrow();
    expect(document.querySelectorAll(`#${PANEL_HOST_ID}`).length).toBe(1);
  });

  it('removePanelHost 能摘掉挂在 documentElement 上的宿主', () => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(document, 'body');
    Object.defineProperty(document, 'body', { configurable: true, get: () => null });
    try {
      mount();
    } finally {
      Reflect.deleteProperty(document as unknown as Record<string, unknown>, 'body');
      if (ownDescriptor) Object.defineProperty(document, 'body', ownDescriptor);
    }
    expect(isPanelMounted()).toBe(true);
    removePanelHost();
    expect(isPanelMounted()).toBe(false);
  });
});

describe('侧栏骨架', () => {
  it('静息态默认收起，点贴边条后展开', () => {
    const shadow = mount();
    expect(shadow).not.toBeNull();
    const panel = shadow?.querySelector('.panel');
    expect(panel?.classList.contains('open')).toBe(false);

    const strip = shadow?.querySelector('.strip');
    expect(strip).not.toBeNull();
    strip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(panel?.classList.contains('open')).toBe(true);

    const close = shadow?.querySelector('.close');
    close?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(panel?.classList.contains('open')).toBe(false);
  });

  it('面板里的文字不含任何"已经做好"的功能承诺', () => {
    /**
     * `AGENTS.md` §1.5 / `02-ui-spec.md` §5 的「不许谎报」：本阶段只做壳，
     * 文案必须自己说明"还没接入"，不能让用户以为点了有反应。
     */
    const shadow = mount();
    const text = shadow?.querySelector('.skeleton')?.textContent ?? '';
    expect(text).toContain('尚未接入');
  });
});
