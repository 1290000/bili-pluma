/**
 * task-47 判据 2 探针（v2）—— 修掉 v1 的**探针自身缺陷**
 *
 * ## v1 错在哪（必须记下来）
 *
 * v1 每次 `it` 都换一个新 `chrome.stub`，但 `login-window.ts` 的模块级变量
 * `currentWindowId` **是模块状态，跨用例存活**。第 2 条"确定打开"用例把
 * `{ id: 7, incognito: true }` 塞进去之后，`currentWindowId = 7` 就留在那儿，
 * 于是后续用例一进门就 `chrome.windows.update(7, { focused: true })` 成功
 * → 返回 `already-open`。
 *
 * ⇒ v1 报的「权限 false 却没拦住建窗」**是我探针的假红，不是产品缺陷**。
 *   这正是本卡要防的那类假象的反向版本：**探针脏了，会把好的说成坏的**。
 *
 * v2 的对策：**每个用例自己显式重置模块状态**（`forgetLoginWindow()`），
 * 并在每条用例开头断言状态确实是干净的 —— 不靠"测试文件按顺序跑"这种隐式前提。
 */
import { describe, expect, it, vi } from 'vitest';

type Handler = (
  msg: { type?: string; [k: string]: unknown },
  sender: unknown,
  sendResponse: (r: unknown) => void,
) => boolean | undefined;

let registeredHandler: Handler | null = null;

const spied = {
  create: vi.fn(),
  getAll: vi.fn(),
};

function installChrome(opts: { allowed: boolean; createImpl?: () => Promise<unknown> }): void {
  const storageBag: Record<string, unknown> = {};
  spied.create.mockReset();
  spied.getAll.mockReset();
  spied.getAll.mockResolvedValue([{ id: 1 }]);
  spied.create.mockImplementation(() =>
    opts.createImpl ? opts.createImpl() : Promise.resolve(undefined as unknown),
  );

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
      create: spied.create,
      update: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      onRemoved: { addListener: () => {} },
      onCreated: { addListener: () => {} },
    },
    tabs: {
      query: () => Promise.resolve([]),
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      onReplaced: { addListener: () => {} },
      onCreated: { addListener: () => {} },
    },
    runtime: {
      getURL: (p: string) => `chrome-extension://fake${p}`,
      onMessage: {
        addListener: (fn: Handler) => {
          registeredHandler = fn;
        },
      },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    action: { onClicked: { addListener: () => {} } },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    declarativeNetRequest: {
      getSessionRules: () => Promise.resolve([]),
      updateSessionRules: () => Promise.resolve(),
    },
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

(globalThis as unknown as { defineBackground: unknown }).defineBackground = (fn: () => void) => {
  fn();
  return fn;
};

installChrome({ allowed: true });
await import('../../../entrypoints/background');
const lw = await import('../../../src/background/login-window');
const { describeLoginOutcome, ASSUMED_TEXT } = await import(
  '../../../src/content/panel/login-outcome'
);

/**
 * 每个用例的起点都必须干净：清掉模块级 `currentWindowId`。
 * 不这么做，前一条用例的状态会污染后一条（v1 就是这么翻车的）。
 */
function resetModuleState(): void {
  lw.forgetLoginWindow();
}

async function dispatchLoginOpen(): Promise<Record<string, unknown>> {
  expect(registeredHandler, 'onMessage 处理器没抓到 —— 入口没加载成功').not.toBeNull();
  const handler = registeredHandler as Handler;
  return await new Promise((resolve) => {
    const ret = handler({ type: 'login/open' }, {}, (r) => resolve(r as Record<string, unknown>));
    expect(ret, 'login/open 必须返回 true（异步 sendResponse）').toBe(true);
  });
}

type Reply = { type?: string; opened?: boolean; reason?: string };

describe('★★★ 判据 2：assumed 的端到端文案', () => {
  it('★★★ assumed（权限 true + create 返回 undefined）→ 不许说「已打开」，也不许说「打不开」', async () => {
    installChrome({ allowed: true, createImpl: () => Promise.resolve(undefined) });
    resetModuleState();

    const reply = (await dispatchLoginOpen()) as Reply;
    console.log('REPLY assumed = ' + JSON.stringify(reply));

    // ① background 侧：不许说成功
    expect(reply.opened, 'assumed 仍然返回 opened:true —— 面板会说「已打开」').not.toBe(true);

    // ② 面板侧：把**真实返回**原样送进文案函数
    const outcome = describeLoginOutcome(reply);
    console.log('TEXT assumed = ' + outcome.text);
    expect(outcome.text, 'assumed 的文案在断言窗口已打开').not.toContain('已打开');
    expect(
      outcome.text,
      'assumed 被说成「打不开」—— 把"没确认"讲成了"确定失败"',
    ).not.toContain('打不开');
  });

  it('★★ 端到端对照：确定打开（create 返回窗口对象）→ 才允许说「已打开」', async () => {
    installChrome({
      allowed: true,
      createImpl: () => Promise.resolve({ id: 7, incognito: true } as unknown),
    });
    resetModuleState();
    expect(spied.create.mock.calls.length, 'control 的 create 计数器没归零').toBe(0);

    const reply = (await dispatchLoginOpen()) as Reply;
    console.log('REPLY confirmed = ' + JSON.stringify(reply));
    expect(spied.create.mock.calls.length, 'control 里 create 没被调用 ⇒ 探针死了').toBe(1);
    expect(reply.opened, '拿到窗口对象时必须 opened:true').toBe(true);
    expect(describeLoginOutcome(reply).text, '确定打开时文案反而没说打开').toContain('已打开');
  });

  it('★★ 端到端：权限 false → 面板必须说"权限没开"，不是笼统失败', async () => {
    installChrome({ allowed: false });
    resetModuleState();
    expect(spied.create.mock.calls.length, 'control 的 create 计数器没归零').toBe(0);

    const reply = (await dispatchLoginOpen()) as Reply;
    console.log('REPLY disabled = ' + JSON.stringify(reply));
    /**
     * ⚠️ 探针 v2 的第二处自我修正：`create` 在这个用例里**确实被调用了一次**，
     * 但那是 `entrypoints/background.ts` 为 `incognito-disabled` 弹的**说明页**
     * （`need-incognito.html`），不是扫码窗（`login-window.html`）。
     * 判据 1 说的是"扫码窗一次都不许建"，所以这里必须**按 URL 过滤**，
     * 而不是数总数 —— 数总数会把一个正确的行为判成 bug。
     */
    const windowCreates = spied.create.mock.calls.filter((c) => {
      const arg = (c[0] ?? {}) as { url?: string; incognito?: boolean };
      return (arg.url ?? '').includes('login-window.html') || arg.incognito === true;
    });
    console.log('WINDOW_CREATES disabled = ' + JSON.stringify(windowCreates));
    expect(windowCreates.length, '权限 false 仍然建了扫码窗（incognito:true / login-window.html）').toBe(0);
    expect(reply.opened).toBe(false);
    expect(reply.reason).toBe('incognito-disabled');
    const text = describeLoginOutcome(reply).text;
    console.log('TEXT disabled = ' + text);
    expect(text, '权限没开时没说清要去哪开').toContain('InPrivate');
  });

  it('★★ ASSUMED_TEXT 不许变成不可达死代码', async () => {
    const candidates: Reply[] = [
      { type: 'login/open:ok', opened: false, reason: 'assumed' },
      { type: 'login/open:ok', opened: true, reason: 'assumed' },
      { type: 'login/open:ok', opened: false, confirmed: false, reason: 'assumed' } as never,
    ];
    const produced = candidates.map((c) => describeLoginOutcome(c).text);
    console.log('CANDIDATE_TEXTS ' + JSON.stringify(produced));
    expect(
      produced.some((t) => t === ASSUMED_TEXT),
      `ASSUMED_TEXT 没有任何输入能产出 ⇒ 死代码。实际输出：${JSON.stringify(produced)}`,
    ).toBe(true);
  });
});
