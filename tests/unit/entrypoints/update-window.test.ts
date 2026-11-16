// @vitest-environment jsdom

/**
 * 更新窗口（`entrypoints/update/main.ts`）的**降级防护**（2026-11-17 真机 bug）。
 *
 * ## 为什么必须单独测这个入口
 *
 * 同一批代码里，"有没有可装的新版本"这个判断被写在了两个地方：
 * 一处是面板的「关于」Tab，另一处就是这个窗口的「立即更新」按钮。
 * 后者比前者**更危险**：它不是"多显示一个徽标"，而是**允许降级安装** ——
 * 用户本地装了 1.2.0、线上最新是 1.1.0 时，旧判据（字符串不等）会认为
 * "有目标"，按钮可点，点下去就把自己的扩展退回 1.1.0。
 *
 * 面板那一侧由 `panel-about-tab.test.ts` 钉住，这里钉窗口这一侧。
 *
 * ## 怎么测一个入口
 *
 * 它 `import` 时就会 `document.getElementById(...)` 并 `void boot()` ——
 * 所以必须**先摆好 DOM、再动态 import**（每个用例 `vi.resetModules()` 重跑一遍）。
 * `fs-access` 走 IndexedDB（jsdom 没有），整块 mock 掉；
 * 其余依赖（`@core/update/*`）都是纯函数，不 mock。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateStatusView } from '@shared/types/update';

/** 与 `entrypoints/update/index.html` 里入口用到的 id 一一对应 */
const HTML = `
  <p id="version-line"></p>
  <p id="dir-line"></p>
  <button id="pick-dir" type="button"></button>
  <button id="start" type="button" disabled></button>
  <p id="estimate"></p>
  <progress id="bar" value="0" max="100"></progress>
  <p id="status"></p>
  <pre id="log"></pre>
`;

/** 目录句柄那一侧全走 IndexedDB，jsdom 没有 —— 整块替换成"没选过目录" */
vi.mock('@platform/update/fs-access', () => ({
  readStoredDir: async () => null,
  ensureWritable: async () => 'granted',
  pickInstallDir: async () => null,
  readDirManifestVersion: async () => '0.0.0',
  storeDir: async () => undefined,
  writeFiles: async () => ({ files: 0, bytes: 0 }),
}));

function statusWith(over: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    currentVersion: '1.1.0',
    latestVersion: '1.2.0',
    latestSizeBytes: 289_831,
    latestZipUrl: 'https://example.invalid/pluma-1.2.0.zip',
    phase: 'available',
    autoCheckEnabled: true,
    intervalDays: 1,
    lastCheckAt: Date.now() - 60_000,
    lastAppliedVersion: null,
    lastFailedVersion: null,
    ...over,
  };
}

/** 摆好 DOM + 桩后台，然后把入口整个跑一遍 */
async function bootWith(status: UpdateStatusView | null): Promise<void> {
  document.body.innerHTML = HTML;

  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (msg: { type?: string }) =>
        msg.type === 'update/status'
          ? status === null
            ? { type: 'update/status:err', detail: 'boom' }
            : { type: 'update/status:ok', status }
          : { type: 'proxy/status:ok' },
      ),
      getManifest: () => ({ version: status?.currentVersion ?? '0.0.0' }),
      reload: vi.fn(),
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
      },
    },
  });

  vi.resetModules();
  await import('@/entrypoints/update/main');
  // `boot()` 是 fire-and-forget：等它把版本行写完
  await vi.waitFor(() => {
    expect(document.getElementById('version-line')?.textContent ?? '').not.toBe('');
  });
}

function startBtn(): HTMLButtonElement {
  return document.getElementById('start') as HTMLButtonElement;
}

function versionLine(): string {
  return document.getElementById('version-line')?.textContent ?? '';
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('更新窗口：只有真的"更新"才允许装', () => {
  /**
   * ## 降级场景（真机 bug 的原始形态）
   *
   * 本地 1.2.0 / 线上 1.1.0。旧判据 `latestVersion !== currentVersion` ⇒ true
   * ⇒ 按钮可点 ⇒ 用户点一下就**把自己的扩展退回 1.1.0**。
   *
   * 变异验证：把 `isNewerThan(status.latestVersion, status.currentVersion)`
   * 换回 `status.latestVersion !== status.currentVersion` → 本条必红。
   */
  it('★★★ 本地 1.2.0 / 线上 1.1.0 ⇒ 「立即更新」必须 disabled（不许降级安装）', async () => {
    await bootWith(statusWith({ currentVersion: '1.2.0', latestVersion: '1.1.0', phase: 'idle' }));

    expect(startBtn().disabled, '本地比线上新，按钮却可点 —— 点下去就是降级安装').toBe(true);
    // 版本行也不能说"→ v1.1.0"（那是把降级说成更新）
    expect(versionLine()).toBe('当前 v1.2.0 · 已是最新');
  });

  it('★ 线上 1.2.0 / 本地 1.1.0 ⇒ 可点，版本行写成"当前 v1.1.0 → v1.2.0"', async () => {
    await bootWith(statusWith({ currentVersion: '1.1.0', latestVersion: '1.2.0' }));

    expect(startBtn().disabled).toBe(false);
    expect(versionLine()).toBe('当前 v1.1.0 → v1.2.0');
  });

  it('同版本 ⇒ disabled（没有可装的）', async () => {
    await bootWith(statusWith({ currentVersion: '1.2.0', latestVersion: '1.2.0', phase: 'idle' }));

    expect(startBtn().disabled).toBe(true);
    expect(versionLine()).toBe('当前 v1.2.0 · 已是最新');
  });

  it('读不到状态 ⇒ disabled，且行里说"读不到版本信息"（不谎报已是最新）', async () => {
    await bootWith(null);

    expect(startBtn().disabled).toBe(true);
    expect(versionLine()).toBe('读不到版本信息');
  });
});
