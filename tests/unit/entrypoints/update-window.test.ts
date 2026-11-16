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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { maskComments, maskCommentsAndStrings } from '../../../scripts/lib/mask-source';
import type { UpdateStatusView } from '@shared/types/update';

const ENTRY_RAW = readFileSync(resolve(process.cwd(), 'entrypoints/update/main.ts'), 'utf8');
/** 注释被抹白：**注释掉的代码在这里看不见**（"临时注掉"是最常见的回退形态） */
const ENTRY_CODE = maskCommentsAndStrings(ENTRY_RAW);
/** 只遮注释：用来断言"某段文案/字面量是否出现在代码里" */
const ENTRY_LITERALS = maskComments(ENTRY_RAW);

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

  /**
   * ## 第四态：后台**应答了**，但 `latestVersion` 是 `null`（从没查过）
   *
   * 它跟"读不到版本信息"（`status === null`）不是一回事：前者有状态、只是没比过；
   * 后者连状态都没拿到。两者都**不许**说「已是最新」—— 那会让用户以为
   * 自己是最新版，于是不再去点「检查更新」。
   *
   * 变异验证：把 `status.latestVersion === null` 那条分支删掉（退回三歧义）→ 本条必红。
   */
  it('★★ 有状态但 latestVersion=null（从没查过）⇒ 说「还没检查过」，按钮 disabled', async () => {
    await bootWith(
      statusWith({
        currentVersion: '1.1.0',
        latestVersion: null,
        phase: 'idle',
        lastCheckAt: null,
      }),
    );

    expect(versionLine()).toBe('当前 v1.1.0 · 还没检查过');
    expect(versionLine(), '没比过就说"已是最新"是谎报').not.toContain('已是最新');
    expect(startBtn().disabled).toBe(true);
  });
});

/**
 * 收尾：**不再由页面自己 reload**（2026-11-17 第二个真机 bug）。
 *
 * 页面自己 `chrome.runtime.reload()` 有两个必然后果：上面那句「正在重新加载…」
 * 一帧都画不出来，而且**没人关窗** ⇒ 440×600 的 popup 被 Chrome 填成空白新标签页。
 *
 * 现在收尾是：写盘 → 显示结果 → 停 800ms → 发 `update/reload` 给 SW（关窗 + reload）。
 *
 * 为什么用源码断言：这两个动作的**行为**已由 `update.handler.test.ts` 的
 * `handleUpdateReload` 一组覆盖；这里要防的是**入口里又出现一句 `runtime.reload()`**
 * —— 那种回退不会让任何行为测试变红（页面照样"更新成功"），只会让用户再次看到空白页。
 */
describe('更新窗口：收尾交给 SW（不许自己 reload）', () => {
  it('★★★ 入口里不许直接调 runtime.reload()', () => {
    expect(ENTRY_CODE, '页面自己 reload ⇒ 没人关窗 ⇒ 空白新标签页').not.toContain(
      'runtime.reload()',
    );
  });

  it('★★ 必须发 update/reload，并且是 fire-and-forget（不 await）', () => {
    expect(ENTRY_LITERALS).toContain("sendMessage({ type: 'update/reload' })");
    // `void` 前缀就是 fire-and-forget 的写法：窗口马上要没，等应答没有意义
    expect(ENTRY_CODE).toContain('void requestReload();');
  });

  it('★★ 发之前必须停一拍，否则"已写入 N 个文件"一帧都画不出来', () => {
    expect(ENTRY_CODE).toContain('UPDATE_SETTLE_MS');
    // 顺序：先 await 停留，再 requestReload —— 反过来等于没停留
    const settleIdx = ENTRY_CODE.indexOf('setTimeout(resolve, UPDATE_SETTLE_MS)');
    const reloadIdx = ENTRY_CODE.indexOf('void requestReload();');
    expect(settleIdx).toBeGreaterThan(-1);
    expect(reloadIdx).toBeGreaterThan(settleIdx);
  });

  it('★ 成功态要说清"写了几个文件"，并提示刷新才生效', () => {
    expect(ENTRY_LITERALS).toContain('已写入 ');
    expect(ENTRY_LITERALS).toContain('正在重新加载扩展');
    expect(ENTRY_LITERALS, '用户需要知道"刷新后才生效"').toContain('刷新后才生效');
  });
});
