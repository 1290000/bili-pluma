// @vitest-environment jsdom

/**
 * `renderBadge()` 的挂载点健壮性（2026-10-31）
 *
 * ## 为什么需要这个文件
 *
 * 真机报错（1.0.1，ep341217）：
 *
 * ```
 * Uncaught (in promise) TypeError: Cannot read properties of null (reading 'appendChild')
 *   at extensions://…/content-scripts/content.js (y):1:2817
 * ```
 *
 * 根因：content script 是 `runAt: 'document_start'`，而角标是**事件驱动**绘制的
 * （收到 `tracks` / `hdr` 消息就画）。那几条消息可能在 `<body>` 解析出来**之前**到达，
 * 此时 `document.body === null` → `appendChild` 抛错。
 *
 * ## 这个文件守什么
 *
 * | 场景 | 期望 |
 * | --- | --- |
 * | body 存在 | 挂到 body（常规路径，视觉与原来一致） |
 * | **body 为 null** | **不抛错**，改挂 `documentElement` |
 * | 重复调用 | 幂等，不出现第二个角标 |
 *
 * ⚠️ **反例验证**：把 `document.body ?? document.documentElement`
 * 改回 `document.body`，第 2 条必红。
 *
 * ⚠️ 这个文件之前**不存在** —— `badge.ts` 的 DOM 渲染路径一直没有单测，
 * 所以那个 TypeError 是"真机才发现"的。这次补上。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { removeBadge, renderBadge, resetBadgeCache } from '../../../src/content/isolated/badge';

/** 最小可用输入：只要 `visible` 为 true 就会走 render 路径 */
function input(overrides: Record<string, unknown> = {}) {
  return {
    proxying: true,
    playingHeight: 1080,
    videoFamily: '',
    audioFamily: '',
    frameRate: 60,
    ...overrides,
  } as Parameters<typeof renderBadge>[1];
}

const TOKENS = ':root { --pluma-fg: #fff; }';

/**
 * 角标宿主的 id（与 badge.ts 的 HOST_ID 一致）
 */
const HOST_ID = 'pluma-badge-host';

/**
 * ⚠️ `badge.ts` 有**模块级缓存** `lastPaintedHeight`，而 `removeBadge()` **故意不清它**
 * （见该函数注释：清了会让角标在 SPA 切换时闪回「已接管」）。
 *
 * 后果：同一个文件里连续跑多个用例时，前一个用例留下的高度会影响后一个 ——
 * 这正是我第一版测试 3 条全红的原因（不是被测代码的缺陷，是测试没隔离状态）。
 *
 * 所以每个用例开始前都要**显式重置**：`resetBadgeCache()` 是唯一会清它的公开函数
 * （它语义上是"彻底离开视频页时才调"，在这里借用来做测试隔离是恰当的）。
 */
beforeEach(() => {
  resetBadgeCache();
  document.getElementById(HOST_ID)?.remove();
  expect(document.body).not.toBeNull();
});

/**
 * 在"没有 body"的状态下执行一段代码（模拟 `document_start`）。
 *
 * ## ⚠️ 还原必须删**实例上的自有属性**（2026-10-31 踩过）
 *
 * 第一版在 `document` 实例上 `defineProperty('body', …)`，还原时却去恢复
 * `Document.prototype` 的描述符 —— 实例自有属性优先级更高，**原型恢复对它无效**，
 * 于是 `document.body` 一直是 `null`，污染了同文件后续所有用例（3 条无辜变红）。
 *
 * 正确做法：`delete (document as any).body`，让原型上的 getter 重新生效。
 */
function withoutBody(fn: () => void): void {
  const ownDescriptor = Object.getOwnPropertyDescriptor(document, 'body');

  Object.defineProperty(document, 'body', {
    configurable: true,
    get: () => null,
  });

  try {
    expect(document.body).toBeNull();
    fn();
  } finally {
    // 删掉实例自有属性，原型上的原始 getter 自然恢复
    Reflect.deleteProperty(document as unknown as Record<string, unknown>, 'body');
    // 万一原本实例上就有 body 自有属性（理论上不会），恢复它
    if (ownDescriptor) Object.defineProperty(document, 'body', ownDescriptor);
  }
}

describe('renderBadge 挂载点', () => {
  it('body 存在时挂到 body', () => {
    renderBadge(TOKENS, input());
    const host = document.getElementById(HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.parentElement).toBe(document.body);
  });

  it('★ body 为 null 时不抛错，改挂 documentElement', () => {
    /**
     * 模拟 `document_start`：真实浏览器里那时 `<html>` 已有、`<body>` 未解析，
     * 所以 `document.body === null`，而 `document.body.appendChild` 会抛 TypeError。
     *
     * 反例：把 badge.ts 的 `document.body ?? document.documentElement` 改回
     * `document.body` → 本条必红。
     */
    withoutBody(() => {
      expect(() => {
        renderBadge(TOKENS, input());
      }).not.toThrow();

      const host = document.getElementById(HOST_ID);
      expect(host).not.toBeNull();
      expect(host?.parentElement).toBe(document.documentElement);
    });

    // 还原确认：后续用例必须能正常拿到 body
    expect(document.body).not.toBeNull();
  });

  it('重复调用是幂等的，不出现第二个角标', () => {
    renderBadge(TOKENS, input());
    renderBadge(TOKENS, input({ playingHeight: 2160 }));
    expect(document.querySelectorAll(`#${HOST_ID}`).length).toBe(1);
  });

  it('visible 为 false 时移除已有角标', () => {
    renderBadge(TOKENS, input());
    expect(document.getElementById(HOST_ID)).not.toBeNull();

    renderBadge(TOKENS, input({ proxying: false, playingHeight: 0 }));
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it('removeBadge 能摘掉挂在 documentElement 上的角标', () => {
    /**
     * 为什么单独测：`removeBadge()` 用 `getElementById`，与挂载点无关 ——
     * 但如果哪天有人把移除逻辑改成 `document.body.removeChild(...)`，
     * "body 为 null 时挂到 html"这条路径就摘不掉了（角标永久残留）。
     * 这条断言把那个可能性锁死。
     */
    withoutBody(() => {
      renderBadge(TOKENS, input());
    });

    expect(document.getElementById(HOST_ID)).not.toBeNull();
    removeBadge();
    expect(document.getElementById(HOST_ID)).toBeNull();
  });
});
