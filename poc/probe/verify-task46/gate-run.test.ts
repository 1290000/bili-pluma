/**
 * task-47 验收探针 —— verifier 独立写的运行期证据（不改任何源码）
 *
 * 目的：判据 1 / 判据 2 的**运行期**证据。不采信 engineer 的测试输出。
 *
 * ## 为什么不用 `toHaveBeenCalledTimes(0)` 单打独斗
 *
 * 一个没被 mock 上的 `create`，和一个"真的没被调用"的 `create`，
 * `toHaveBeenCalledTimes(0)` 的输出**长得一模一样**（task-42 踩过）。
 * 所以本探针用**计数器 + 强制 control-true**：
 *   - 每组用例跑完都必须证明计数器能变
 *   - control-true 那一组 create 必须 === 1
 * 任一条不成立 ⇒ 整组结论作废，不输出"0 次"。
 */
import { describe, expect, it, vi } from 'vitest';

interface CreateCall {
  url?: string;
  incognito?: boolean;
}

/**
 * create 计数器 —— 挂在**最底层那个 `chrome.windows.create`** 上。
 *
 * 判据（Lead m03723 追加）：先确认 `openLoginWindow()` 里是直调还是有 wrapper。
 * 已读实现：`src/background/login-window.ts:309` 就是
 *   `created = await chrome.windows.create({ … })`
 * —— **直调，没有中间层**。所以直接挂 `chrome.windows.create` 即可代表真实调用。
 * 本文件末尾有一条 `★★ 直调证明` 的源码级断言把这个前提钉住：
 * 若将来有人加了 wrapper，那条断言会先红，不会让计数器悄悄失去代表性。
 */
const createCalls: CreateCall[] = [];

/** 每次安装 chrome stub 时重置，供第 3 层断言"副作用有没有发生" */
const spied = {
  getAll: vi.fn(() => Promise.resolve([{ id: 1 }])),
};

function installChrome(opts: { allowed: boolean; createImpl?: () => Promise<unknown> }): void {
  createCalls.length = 0;
  spied.getAll.mockClear();
  const storageBag: Record<string, unknown> = {};
  const chromeStub = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: storageBag[key] }),
        set: (items: Record<string, unknown>) => {
          Object.assign(storageBag, items);
          return Promise.resolve();
        },
        remove: (key: string) => {
          delete storageBag[key];
          return Promise.resolve();
        },
      },
    },
    extension: {
      isAllowedIncognitoAccess: () => Promise.resolve(opts.allowed),
      inIncognitoContext: false,
    },
    windows: {
      getAll: spied.getAll,
      create: vi.fn((arg: CreateCall) => {
        createCalls.push(arg);
        return opts.createImpl ? opts.createImpl() : Promise.resolve(undefined);
      }),
      update: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    },
    tabs: { query: () => Promise.resolve([]) },
    runtime: { getURL: (p: string) => `chrome-extension://fake${p}` },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
}

vi.mock('@platform/storage/diag-store', () => ({
  diag: () => Promise.resolve(),
  readDiag: () => Promise.resolve([]),
  instanceId: () => 'probe',
  DIAG_KEY: 'pluma:diag',
  DIAG_LIMIT: 30,
}));

const mod = await import('../../../src/background/login-window');

function createMock(): { mock: { calls: unknown[][] } } {
  const c = (globalThis as unknown as { chrome: { windows: { create: unknown } } }).chrome.windows
    .create;
  return c as { mock: { calls: unknown[][] } };
}

describe('★★★ 判据 1：权限 false → create 一次都不许被调（含四层防假绿）', () => {
  it('★★ 权限 false → create === 0，且返回 incognito-disabled', async () => {
    installChrome({ allowed: false });

    // 第 2 层：先证明探针真的是 mock（否则后面的 0 恒真）
    expect(vi.isMockFunction(createMock()), 'create 不是 mock —— 计数恒 0，本用例作废').toBe(true);

    const r = await mod.openLoginWindow();

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('incognito-disabled');
    // 第 1 层：调用次数 0
    expect(createMock().mock.calls.length, '权限 false 仍然调了 create').toBe(0);
  });

  it('★★★ 反面对照：权限 true → create === 1（证明计数器确实能变）', async () => {
    installChrome({ allowed: true });
    const r = await mod.openLoginWindow();
    // 第 4 层：计数器必须能变。若这条变成 0，说明整个探针是死的，
    // 上面那条"0 次"也就一文不值。
    expect(createMock().mock.calls.length, 'control-true 没让计数器变 ⇒ 计数器无效').toBe(1);
    expect(createCalls.length).toBe(1);
    expect(createCalls[0]?.incognito, 'create 必须带 incognito:true').toBe(true);
    expect(createCalls[0]?.url).toContain('login-window.html');
    expect(r.ok).toBe(true);
  });

  it('★★ 闸门在 create 之前的副作用也不许发生（第 3 层）', async () => {
    installChrome({ allowed: false });
    await mod.openLoginWindow();
    // 权限闸门排在 probeExistingLoginWindow / getAll / create 之前
    // ⇒ getAll 也不该被调用。若 getAll 被调了而 create 没有，
    // 说明 create 是死在别的原因（异常被吞等），不是闸门拦的。
    expect(
      spied.getAll.mock.calls.length,
      '权限 false 时 getAll 被调了 —— 闸门没排在它之前',
    ).toBe(0);
    expect(createMock().mock.calls.length, '权限 false 仍然调了 create').toBe(0);
  });

  it('★★ 第 3 层自身的 control：权限 true 时 getAll 必须被调用', async () => {
    installChrome({ allowed: true });
    await mod.openLoginWindow();
    // getAll 在 openLoginWindow 里被调两次（create 前数一次、create 后数一次）
    // —— 具体次数不是本卡判据，这里只证明"它在动"。
    expect(
      spied.getAll.mock.calls.length,
      'control-true 时 getAll 一次都没被调 ⇒ 上面那条 getAll===0 恒真',
    ).toBeGreaterThan(0);
  });
});

describe('★★ 探针前提：create 是直调，没有 wrapper（counter 的代表性）', () => {
  it('★★ 源码级：openLoginWindow 里 chrome.windows.create 是直接调用', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/background/login-window.ts'), 'utf8');
    const start = src.indexOf('export async function openLoginWindow');
    expect(start, '找不到 openLoginWindow').toBeGreaterThan(-1);
    const open = src.indexOf('{', start);
    let depth = 0;
    let i = open;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = src.slice(open, i + 1);
    expect(body.length).toBeGreaterThan(500);
    // 直调：必须出现 chrome.windows.create(
    expect(body, '没有直接调用 chrome.windows.create').toMatch(/chrome\.windows\.create\s*\(/);
    // 没有本地 wrapper：不许出现 function createXxx / const createXxx = 包住它
    expect(
      body,
      '出现了本地 wrapper 包住 create —— 计数器可能挂错了层',
    ).not.toMatch(/(?:function\s+\w*[Cc]reate\w*\s*\(|const\s+\w*[Cc]reate\w*\s*=\s*(?:async\s*)?\()/);
  });
});
