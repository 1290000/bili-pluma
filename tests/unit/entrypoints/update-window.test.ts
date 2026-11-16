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

/**
 * `fs-access` 那一侧全走 IndexedDB / File System Access，jsdom 都没有 —— 整块替换。
 *
 * ⚠️ 用 `vi.hoisted` 是因为 `vi.mock` 的工厂会被提到文件顶部，
 * 拿不到普通的模块级变量；而下面的用例要能改"这个目录里到底是什么"。
 */
const fsMock = vi.hoisted(() => ({
  /** `readDirManifest` 的返回值（用例里改） */
  manifest: { name: 'Pluma', version: '1.1.0' } as { name: string | null; version: string },
  /** 非 null ⇒ `readDirManifest` 抛这个错（模拟"选到别的地方了"） */
  manifestError: null as Error | null,
  /** `ensureWritable` 的返回值 */
  permission: 'granted' as PermissionState,
  /** 非 null ⇒ `readStoredDir` 返回它（模拟"上次已经选过目录"） */
  storedDir: null as { name: string } | null,
  /** `readDirManifest` 被调了几次 */
  manifestReads: 0,
}));

vi.mock('@platform/update/fs-access', () => ({
  readStoredDir: async () => fsMock.storedDir,
  ensureWritable: async () => fsMock.permission,
  pickInstallDir: async () => ({ name: 'pluma-1.1.0' }),
  readDirManifest: async () => {
    fsMock.manifestReads += 1;
    if (fsMock.manifestError) throw fsMock.manifestError;
    return fsMock.manifest;
  },
  readDirManifestVersion: async () => fsMock.manifest.version,
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

/**
 * 摆好 DOM + 桩后台，然后把入口整个跑一遍。
 *
 * @param options.manifestName 运行时 `getManifest().name` —— 目录校验的判据就是它，
 *   所以这里必须可改：用它和"目录里的 name"对比，才能证明判据是**动态**的。
 */
async function bootWith(
  status: UpdateStatusView | null,
  options: { manifestName?: string } = {},
): Promise<void> {
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
      // ⚠️ `name` 必须有：目录校验的判据是"目录里的 name === 运行时的 name"，
      // 少了它所有目录都会被判成"不是 Pluma"
      getManifest: () => ({
        name: options.manifestName ?? 'Pluma',
        version: status?.currentVersion ?? '0.0.0',
      }),
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
  fsMock.manifest = { name: 'Pluma', version: '1.1.0' };
  fsMock.manifestError = null;
  fsMock.permission = 'granted';
  fsMock.storedDir = null;
  fsMock.manifestReads = 0;
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
/**
 * 选目录**当场**校验（2026-11-17）。
 *
 * ## 改之前是什么样
 *
 * 选完目录后其实已经读了 `manifest.json`，但只 `appendLog()` 写进日志，
 * `#dir-line` 仍显示「目录：xxx（可写）」—— **"可写"不等于"选对了"**。
 * 用户要等到"下载完 + 写入"才发现选错，而那时候的报错完全看不出是目录的问题。
 *
 * 现在把结论写在用户正在看的那一行上，并区分三种情形：
 * 读不到 manifest / 名字不是 Pluma / 正常（可能还附"已经是目标版本"）。
 */
describe('选目录当场校验：选错了不许等到下载完', () => {
  function dirLine(): HTMLElement {
    return document.getElementById('dir-line') as HTMLElement;
  }

  /** 点「选择扩展目录」并等目录行写出结论 */
  async function pickAndWaitFor(expected: RegExp): Promise<void> {
    (document.getElementById('pick-dir') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(dirLine().textContent ?? '').toMatch(expected);
    });
  }

  it('★ 选到正确的目录 ⇒ 说出该目录当前版本，且不是警告态', async () => {
    fsMock.manifest = { name: 'Pluma', version: '1.0.0' };
    await bootWith(statusWith({ currentVersion: '1.0.0', latestVersion: '1.1.0' }));

    await pickAndWaitFor(/该目录当前是 v1\.0\.0/);
    expect(dirLine().textContent).toContain('（可写）');
    expect(dirLine().textContent, '正确目录却报了错').not.toContain('⚠️');
    expect(dirLine().classList.contains('warn')).toBe(false);
  });

  /**
   * ## 「不是 Pluma」这一支
   *
   * 判据是 `chrome.runtime.getManifest().name`，**不是硬编码的 'Pluma'**。
   * 这条用例把运行时的 name 改成别的值来证明判据是动态的 ——
   * 见下面那条"判据来自运行时"的用例。
   *
   * 变异验证：删掉 `info.name !== expectedName` 那一支 → 本条必红。
   */
  it('★★ 选到别的扩展的目录（name 对不上）⇒ 明确说"不是 Pluma"', async () => {
    fsMock.manifest = { name: 'Other Extension', version: '9.9.9' };
    await bootWith(statusWith());

    await pickAndWaitFor(/不是 Pluma/);
    // 把它读到的名字摆出来，用户能自己对照
    expect(dirLine().textContent).toContain('Other Extension');
    expect(dirLine().classList.contains('warn')).toBe(true);
  });

  /**
   * 判据来自**运行时**的 manifest 名字。
   *
   * 若有人把 `chrome.runtime.getManifest().name` 写成硬编码 `'Pluma'`，
   * 那么"把运行时名字改成别的值"之后，一个**名字正确**的目录会被误判成"不是 Pluma"。
   * 这条用例用"运行时叫 PlumaX、目录里叫 PlumaX"来证明它跟着运行时走，
   * 而不是跟着字面量走。
   */
  it('★★ 判据来自运行时：运行时改名叫 PlumaX，同名目录必须判为正确', async () => {
    fsMock.manifest = { name: 'PlumaX', version: '1.1.0' };
    await bootWith(statusWith(), { manifestName: 'PlumaX' });

    await pickAndWaitFor(/该目录当前是 v1\.1\.0/);
    expect(
      dirLine().textContent,
      '把判据写成硬编码的「Pluma」时，这条会误判成"不是 Pluma"',
    ).not.toContain('不是 Pluma');
  });

  it('★★ 目录里没有 manifest.json ⇒ 说清原因，且不许说"可写"', async () => {
    fsMock.manifestError = new Error('所选目录里没有 manifest.json —— 选到别的地方了');
    await bootWith(statusWith());

    await pickAndWaitFor(/没有 manifest\.json/);
    expect(dirLine().textContent, '选错目录却还说可写，等于让人放心地错下去').not.toContain('可写');
    expect(dirLine().classList.contains('warn')).toBe(true);
  });

  it('★ 目录版本已经是目标版本 ⇒ 追一句"已经是目标版本"', async () => {
    fsMock.manifest = { name: 'Pluma', version: '1.2.0' };
    await bootWith(statusWith({ currentVersion: '1.2.0', latestVersion: '1.2.0' }));

    await pickAndWaitFor(/已经是目标版本/);
  });

  /**
   * 重开窗口时**不重新读盘**：只在"已经读过"时才渲染版本号。
   *
   * 为什么这条重要：`refreshDirLine()` 在窗口打开时会跑一次。若它也去读 manifest，
   * 那么"上次选好的目录这次读失败"（比如用户把目录挪走了）就会把目录行染红 ——
   * 而用户什么都没做错，也没打算现在更新。校验只发生在"选目录"那个动作里。
   */
  it('★ 重开窗口：不重读 manifest（目录行只说目录与权限，不带版本）', async () => {
    fsMock.storedDir = { name: 'pluma-1.1.0' };
    await bootWith(statusWith());

    await vi.waitFor(() => {
      expect(dirLine().textContent).toContain('pluma-1.1.0');
    });
    expect(dirLine().textContent).toContain('（可写）');
    expect(dirLine().textContent, '没读过就不该编一个版本号出来').not.toMatch(/v\d+\.\d+\.\d+/);
    expect(fsMock.manifestReads, '重开窗口不该去读盘').toBe(0);
  });

  it('★ 目录版本不是目标版本 ⇒ 不许提前许诺"将升级到"（用户还没点更新）', async () => {
    fsMock.manifest = { name: 'Pluma', version: '1.0.0' };
    await bootWith(statusWith({ currentVersion: '1.0.0', latestVersion: '1.2.0' }));

    await pickAndWaitFor(/该目录当前是 v1\.0\.0/);
    expect(dirLine().textContent).not.toContain('已经是目标版本');
    expect(dirLine().textContent).not.toContain('将升级');
  });
});

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
