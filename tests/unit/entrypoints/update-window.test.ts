// @vitest-environment jsdom

/**
 * 更新窗口（`entrypoints/update/main.ts`）的行为测试。
 *
 * ## 2026-11-17 重构后，这扇窗改成了"单点渲染"
 *
 * 状态都在 `WindowState` 里，`renderWindow()` 是**唯一**写 DOM 的地方。
 * 所以这里测的也是它：给定一组状态（未选目录 / 就绪 / 忙碌 / 失败 / 完成），
 * 六个区块（版本行 / 步骤行 / 主按钮 / 进度 / 状态行 / 详情）该长什么样。
 *
 * ## 断言按**语义**选，不按字符选
 *
 * 用 `.step.ok` / `.step.bad` / `#start.disabled` / `#logbox.open` / `#start.textContent`
 * 这些稳定锚点，**不**断言序号字符（"1" / "✓" / "!"）的具体值 —— 那是版式，
 * 版式会变，语义不会。
 *
 * ## 入口怎么测
 *
 * 它 `import` 时就会 `document.getElementById(...)` 并 `void boot()` ——
 * 所以必须先摆好 DOM、再动态 import（每个用例 `vi.resetModules()` 重跑一遍）。
 * 磁盘 / 解压 / 计划三块全部 mock：这一版测的是**渲染与判据**，不是解压器。
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
  <div id="step">
    <span id="step-n">1</span>
    <p id="step-t1"></p>
    <p id="step-t2"></p>
    <button id="pick-dir" type="button"></button>
  </div>
  <button id="start" type="button" disabled>立即更新</button>
  <progress id="bar" hidden></progress>
  <p id="status" hidden></p>
  <details id="howto"><summary></summary><p></p></details>
  <details id="logbox"><summary></summary><pre id="log"></pre></details>
`;

/**
 * `fs-access` 走 IndexedDB / File System Access，jsdom 都没有 —— 整块替换。
 *
 * `vi.hoisted` 是为了让 `vi.mock` 的工厂（会被提到文件顶部）拿得到可变的桩。
 */
const fsMock = vi.hoisted(() => ({
  manifest: { name: 'Pluma', version: '1.0.0' } as { name: string | null; version: string },
  manifestError: null as Error | null,
  permission: 'granted' as PermissionState,
  storedDir: null as { name: string } | null,
  manifestReads: 0,
  /** 解压出来的 manifest 版本（step 7 的版本校验用） */
  zipVersion: '1.2.0',
  /** `writeFiles` 是否抛错（模拟写入失败） */
  writeError: null as Error | null,
  /** 「进行中」那一帧的快照：在 writeFiles 的进度回调里抓 */
  midFlight: null as { barHidden: boolean; status: string; startDisabled: boolean } | null,
}));

vi.mock('@platform/update/fs-access', () => ({
  readStoredDir: async () => fsMock.storedDir,
  ensureWritable: async () => fsMock.permission,
  pickInstallDir: async () => ({ name: 'pluma-1.0.0' }),
  readDirManifest: async () => {
    fsMock.manifestReads += 1;
    if (fsMock.manifestError) throw fsMock.manifestError;
    return fsMock.manifest;
  },
  readDirManifestVersion: async () => fsMock.manifest.version,
  storeDir: async () => undefined,
  writeFiles: async (
    _dir: unknown,
    _writes: unknown,
    onProgress?: (p: { index: number; total: number }) => void,
  ) => {
    onProgress?.({ index: 1, total: 2 });
    // 「进行中」那一帧只存在几十毫秒，不在这里抓就再也看不到
    fsMock.midFlight = {
      barHidden: (document.getElementById('bar') as HTMLProgressElement).hidden,
      status: document.getElementById('status')?.textContent ?? '',
      startDisabled: (document.getElementById('start') as HTMLButtonElement).disabled,
    };
    onProgress?.({ index: 2, total: 2 });
    if (fsMock.writeError) throw fsMock.writeError;
    return { files: 2, bytes: 10 };
  },
}));

/** 解压器与写入计划与"能不能更新"无关，这里只关心渲染 */
vi.mock('@core/update/zip', () => ({ readZip: async () => [] }));
vi.mock('@core/update/plan', () => ({
  planWrites: () => ({ writes: [], rejected: [] }),
  readManifestVersion: () => fsMock.zipVersion,
}));

function statusWith(over: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    currentVersion: '1.0.0',
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
 * 摆好 DOM + 桩后台，把入口整个跑一遍。
 *
 * @param status `null` ⇒ 后台回错（读不到状态）
 * @param options.manifestName 运行时 `getManifest().name` —— 目录校验的判据就是它
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
      getManifest: () => ({
        name: options.manifestName ?? 'Pluma',
        version: status?.currentVersion ?? '0.0.0',
      }),
      reload: vi.fn(),
    },
    storage: { local: { get: async () => ({}), set: async () => undefined } },
  });
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    headers: { get: () => '0' },
    arrayBuffer: async () => new ArrayBuffer(8),
  }));

  vi.resetModules();
  await import('@/entrypoints/update/main');
  // `boot()` 是 fire-and-forget：等它把版本行写完
  await vi.waitFor(() => {
    expect(document.getElementById('version-line')?.textContent ?? '').not.toBe('');
  });
}

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const startBtn = (): HTMLButtonElement => $('start') as HTMLButtonElement;
const step = (): HTMLElement => $('step');
const t1 = (): string => $('step-t1').textContent ?? '';
const t2 = (): string => $('step-t2').textContent ?? '';
const versionLine = (): string => $('version-line').textContent ?? '';
const statusLine = (): HTMLElement => $('status');
const logBox = (): HTMLDetailsElement => $('logbox') as HTMLDetailsElement;

beforeEach(() => {
  vi.unstubAllGlobals();
  fsMock.manifest = { name: 'Pluma', version: '1.0.0' };
  fsMock.manifestError = null;
  fsMock.permission = 'granted';
  fsMock.storedDir = null;
  fsMock.manifestReads = 0;
  fsMock.zipVersion = '1.2.0';
  fsMock.writeError = null;
  fsMock.midFlight = null;
});

describe('主按钮：文案恒定，状态只通过 enabled/disabled 表达', () => {
  /**
   * ⚠️ 窗口里**只有一个动作**，所以文案永远叫「立即更新」。
   * 改成"先选目录"之类的会让用户以为出现了新动作（用户明确要求过）。
   */
  it('★★ 未选目录 ⇒ 主按钮 disabled，但文案仍是「立即更新」', async () => {
    await bootWith(statusWith());

    expect(startBtn().disabled).toBe(true);
    expect(startBtn().textContent).toBe('立即更新');
    expect(step().classList.contains('ok')).toBe(false);
    expect(step().classList.contains('bad')).toBe(false);
    expect(t1()).toBe('选择扩展目录');
  });

  it('★★ 就绪（目录校验通过 + 可写 + 有新版）⇒ 可用，文案不变', async () => {
    fsMock.storedDir = { name: 'pluma-1.0.0' };
    await bootWith(statusWith());

    await vi.waitFor(() => {
      expect(startBtn().disabled).toBe(false);
    });
    expect(startBtn().textContent).toBe('立即更新');
    expect(step().classList.contains('ok')).toBe(true);
    expect(t1()).toBe('pluma-1.0.0');
    expect(t2()).toContain('当前 v1.0.0');
    expect(t2()).toContain('可写入');
  });

  /**
   * 不可写 ⇒ 点不动。这条是变异靶子：把判据里的 `!current.writable` 删掉必红。
   */
  it('★★ 目录不可写 ⇒ 主按钮 disabled，且步骤行说明原因', async () => {
    fsMock.storedDir = { name: 'pluma-1.0.0' };
    fsMock.permission = 'denied';
    await bootWith(statusWith());

    await vi.waitFor(() => {
      expect(t2()).toContain('未授予写入权限');
    });
    expect(startBtn().disabled, '不可写却还能点 —— 点下去必然在写盘那一步炸').toBe(true);
  });

  it('★ 已经是目标版本（latest === current）⇒ disabled，副行说出来', async () => {
    fsMock.manifest = { name: 'Pluma', version: '1.2.0' };
    fsMock.storedDir = { name: 'pluma-1.2.0' };
    await bootWith(statusWith({ currentVersion: '1.2.0', latestVersion: '1.2.0' }));

    await vi.waitFor(() => {
      expect(t2()).toContain('已经是目标版本');
    });
    expect(startBtn().disabled).toBe(true);
  });

  /**
   * 降级场景：本地 1.2.0 / 线上 1.1.0。
   * 判据走 `isNewerThan`，**不是**字符串不等（2026-11-17 收敛的那条）。
   */
  it('★★ 本地比线上新 ⇒ disabled（不许降级安装）', async () => {
    fsMock.manifest = { name: 'Pluma', version: '1.2.0' };
    fsMock.storedDir = { name: 'pluma-1.2.0' };
    await bootWith(statusWith({ currentVersion: '1.2.0', latestVersion: '1.1.0' }));

    await vi.waitFor(() => {
      expect(step().classList.contains('ok')).toBe(true);
    });
    expect(startBtn().disabled).toBe(true);
  });
});

describe('目录校验：选错当场说，不等下载完', () => {
  /**
   * 判据是 `chrome.runtime.getManifest().name`，**不是硬编码的「Pluma」**。
   */
  it('★★ 名字对不上 ⇒ 步骤行标 bad 并说出它读到的名字', async () => {
    fsMock.manifest = { name: 'Other Extension', version: '9.9.9' };
    fsMock.storedDir = { name: 'other' };
    await bootWith(statusWith());

    await vi.waitFor(() => {
      expect(t2()).toContain('不是 Pluma');
    });
    expect(t2()).toContain('Other Extension');
    expect(step().classList.contains('bad')).toBe(true);
    expect(startBtn().disabled).toBe(true);
  });

  it('★★ 判据来自运行时：运行时改名叫 PlumaX，同名目录必须判为正确', async () => {
    fsMock.manifest = { name: 'PlumaX', version: '1.0.0' };
    fsMock.storedDir = { name: 'plumax' };
    await bootWith(statusWith(), { manifestName: 'PlumaX' });

    await vi.waitFor(() => {
      expect(step().classList.contains('ok')).toBe(true);
    });
    expect(t2(), '硬编码「Pluma」时这里会误判成"不是 Pluma"').not.toContain('不是 Pluma');
  });

  it('★★ 目录里没有 manifest.json ⇒ 步骤行标 bad 并说清原因', async () => {
    fsMock.manifestError = new Error('所选目录里没有 manifest.json —— 选到别的地方了');
    fsMock.storedDir = { name: 'wrong-dir' };
    await bootWith(statusWith());

    await vi.waitFor(() => {
      expect(t2()).toContain('没有 manifest.json');
    });
    expect(step().classList.contains('bad')).toBe(true);
    expect(startBtn().disabled).toBe(true);
  });

  /**
   * 文案恒定还得靠**代码**保证：任何人只要写一句
   * `startBtn.textContent = '先选目录'`，用户就会以为出现了新动作。
   */
  it('★★ 代码里不许给主按钮动态改文案（文案只存在于 HTML）', () => {
    expect(ENTRY_CODE).not.toContain('startBtn.textContent');
    expect(ENTRY_CODE).not.toContain('start.textContent');
  });

  it('★ 没有已存目录 ⇒ 开窗不读盘（选项都还没给，读什么）', async () => {
    await bootWith(statusWith());

    expect(fsMock.manifestReads).toBe(0);
    expect(t1()).toBe('选择扩展目录');
  });
});

describe('状态行与详情：一条信息只说一处', () => {
  it('★ 有新版且空闲 ⇒ 状态行不占位（hidden）', async () => {
    fsMock.storedDir = { name: 'pluma-1.0.0' };
    await bootWith(statusWith());

    await vi.waitFor(() => {
      expect(startBtn().disabled).toBe(false);
    });
    expect(statusLine().hidden).toBe(true);
    expect(statusLine().textContent).toBe('');
  });

  /**
   * 「没有可更新的版本」这句话来自改版前的 `say(...)` —— 信息不能丢，
   * 只是换了渲染位置（状态行）。不显示它的话，用户面对一个灰按钮无从下手。
   */
  it('★ 没有可装的更新 ⇒ 状态行告诉用户下一步', async () => {
    await bootWith(statusWith({ latestVersion: null }));

    expect(statusLine().hidden).toBe(false);
    expect(statusLine().textContent).toContain('没有可更新的版本');
    expect(statusLine().textContent).toContain('检查更新');
  });

  /**
   * 详情默认收起 —— 里面是「解压出 27 个条目」这类噪音，占三分之一窗口。
   * **只有失败时**自动展开（用户要排障）。
   *
   * 变异验证：删掉 `logBox.open = current.phase === 'failed'` → 本条必红。
   */
  it('★★ 失败 ⇒ 详情自动展开', async () => {
    fsMock.storedDir = { name: 'pluma-1.0.0' };
    fsMock.writeError = new Error('磁盘满了');
    await bootWith(statusWith());

    await vi.waitFor(() => {
      expect(startBtn().disabled).toBe(false);
    });
    startBtn().click();

    await vi.waitFor(() => {
      expect(logBox().open).toBe(true);
    });
    expect(statusLine().textContent).toContain('更新失败');
    // 失败后**可以重试**：busy 已复位、目录依然合法（下载失败这类问题是瞬时的）。
    // 只有目录不可写 / 没有目标版本才该继续灰着。
    expect(startBtn().disabled).toBe(false);
  });

  it('★★ 空闲时详情收起（不许一上来就把日志摊开）', async () => {
    fsMock.storedDir = { name: 'pluma-1.0.0' };
    await bootWith(statusWith());

    await vi.waitFor(() => {
      expect(startBtn().disabled).toBe(false);
    });
    expect(logBox().open).toBe(false);
  });

  it('★ 进行中 ⇒ 进度条可见、状态行有文字、主按钮 disabled', async () => {
    fsMock.storedDir = { name: 'pluma-1.0.0' };
    await bootWith(statusWith());

    await vi.waitFor(() => {
      expect(startBtn().disabled).toBe(false);
    });
    startBtn().click();

    await vi.waitFor(() => {
      expect(fsMock.midFlight).not.toBeNull();
    });
    // 抓到的"进行中"那一帧
    expect(fsMock.midFlight?.barHidden, '写入过程中该看见进度').toBe(false);
    expect(fsMock.midFlight?.status).not.toBe('');
    expect(fsMock.midFlight?.startDisabled).toBe(true);
  });

  it('★ 完成 ⇒ 状态行说"已写入 N 个文件…"、进度收起、详情收起', async () => {
    fsMock.storedDir = { name: 'pluma-1.0.0' };
    await bootWith(statusWith());

    await vi.waitFor(() => {
      expect(startBtn().disabled).toBe(false);
    });
    startBtn().click();

    await vi.waitFor(
      () => {
        expect(statusLine().textContent).toContain('已写入');
      },
      { timeout: 3000 },
    );
    expect(statusLine().textContent).toContain('正在重新加载扩展');
    expect($('bar').hidden).toBe(true);
    expect(logBox().open).toBe(false);
  });
});

describe('版本行：四态（与面板同一口径）', () => {
  it('有新版 ⇒ `vX → vY · 体积`', async () => {
    await bootWith(statusWith());
    expect(versionLine()).toBe('v1.0.0 → v1.2.0 · 283 KB');
  });

  it('比过了、不新 ⇒ 已是最新', async () => {
    await bootWith(statusWith({ latestVersion: '1.0.0' }));
    expect(versionLine()).toBe('当前 v1.0.0 · 已是最新');
  });

  it('从没查过 ⇒ 还没检查过（不是"已是最新"）', async () => {
    await bootWith(statusWith({ latestVersion: null }));
    expect(versionLine()).toBe('当前 v1.0.0 · 还没检查过');
  });

  it('读不到状态 ⇒ 读不到版本信息', async () => {
    await bootWith(null);
    expect(versionLine()).toBe('读不到版本信息');
  });
});

/**
 * 收尾：**不再由页面自己 reload**（2026-11-17 真机 bug）。
 *
 * 页面自己 `chrome.runtime.reload()` 有两个必然后果：那句话一帧都画不出来，
 * 而且**没人关窗** ⇒ 440×600 的 popup 被 Chrome 填成空白新标签页。
 *
 * 为什么用源码断言：行为已由 `update.handler.test.ts` 的 `handleUpdateReload` 覆盖；
 * 这里要防的是**入口里又出现一句 `runtime.reload()`** —— 那种回退不会让任何行为
 * 测试变红（页面照样"更新成功"），只会让用户再次看到空白页。
 */
describe('收尾交给 SW（不许自己 reload）', () => {
  it('★★★ 入口里不许直接调 runtime.reload()', () => {
    expect(ENTRY_CODE, '页面自己 reload ⇒ 没人关窗 ⇒ 空白新标签页').not.toContain(
      'runtime.reload()',
    );
  });

  it('★★ 必须发 update/reload，并且是 fire-and-forget（不 await）', () => {
    expect(ENTRY_LITERALS).toContain("sendMessage({ type: 'update/reload' })");
    expect(ENTRY_CODE).toContain('void requestReload();');
  });

  it('★★ 发之前必须停一拍，否则"已写入 N 个文件"一帧都画不出来', () => {
    const settleIdx = ENTRY_CODE.indexOf('setTimeout(resolve, UPDATE_SETTLE_MS)');
    const reloadIdx = ENTRY_CODE.indexOf('void requestReload();');
    expect(settleIdx).toBeGreaterThan(-1);
    expect(reloadIdx).toBeGreaterThan(settleIdx);
  });
});
