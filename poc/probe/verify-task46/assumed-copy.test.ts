/**
 * task-47 判据 2 探针 —— `assumed` 真的到不了「已打开」文案吗？
 *
 * ## 为什么要"端到端"而不是只测 describeLoginOutcome
 *
 * 只测 `describeLoginOutcome({ opened: true, reason: 'assumed' })` 是**测了个寂寞**：
 * 那个形状今天到底会不会从 `handleLoginOpen()` 出来，才是判据 2 的全部内容。
 * 所以本探针从**真实的 `handleLoginOpen()`** 出发（加载 `entrypoints/background.ts`，
 * 截获它注册的 `chrome.runtime.onMessage` 处理器），喂它一个真实的 `login/open` 消息，
 * 再把它**真实返回的对象**原样送进 `describeLoginOutcome()`。
 * 中间没有任何手写的应答字面量。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Handler = (
  msg: { type?: string; [k: string]: unknown },
  sender: unknown,
  sendResponse: (r: unknown) => void,
) => boolean | undefined;

let registeredHandler: Handler | null = null;

function installChrome(opts: { allowed: boolean; createImpl?: () => Promise<unknown> }): void {
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
      getAll: () => Promise.resolve([{ id: 1 }]),
      create: vi.fn(() =>
        opts.createImpl ? opts.createImpl() : Promise.resolve(undefined as unknown),
      ),
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

/** WXT 的全局注入 —— 让入口模块能加载，并把 onMessage 处理器抓出来 */
(globalThis as unknown as { defineBackground: unknown }).defineBackground = (fn: () => void) => {
  fn();
  return fn;
};

// 先装好 chrome stub 再 import —— 入口模块在**模块求值期**就会读
// `chrome.storage.local` / `chrome.runtime.onMessage`，晚一步就是 ReferenceError。
installChrome({ allowed: true });
await import('../../../entrypoints/background');
const { describeLoginOutcome } = await import('../../../src/content/panel/login-outcome');

async function dispatchLoginOpen(): Promise<Record<string, unknown>> {
  expect(registeredHandler, 'onMessage 处理器没抓到 —— 入口没加载成功').not.toBeNull();
  const handler = registeredHandler as Handler;
  return await new Promise((resolve) => {
    const ret = handler({ type: 'login/open' }, {}, (r) => resolve(r as Record<string, unknown>));
    expect(ret, 'login/open 必须返回 true（异步 sendResponse）').toBe(true);
  });
}

describe('★★★ 判据 2：assumed 不许让面板说「已打开」，也不许说「打不开」', () => {
  it('★★★ assumed：handleLoginOpen 的返回里 opened !== true，且面板文案既不是"已打开"也不是"打不开"', async () => {
    // 权限 true + create 返回 undefined = split 模式下的常态 ⇒ 走 assumed
    installChrome({ allowed: true, createImpl: () => Promise.resolve(undefined) });
    const reply = await dispatchLoginOpen();

    // ① background 侧：不许说成功
    expect(reply.opened, 'assumed 仍然返回 opened:true —— 面板会说「已打开」').not.toBe(true);

    // ② 面板侧：把这个**真实返回**原样送进文案函数
    const outcome = describeLoginOutcome(reply as { type?: string; opened?: boolean; reason?: string });

    // 不许说「已打开」
    expect(outcome.text, 'assumed 的文案在断言窗口已打开').not.toContain('已打开');
    // 也不许说「打不开」—— 我们只是没确认，不是确定失败
    expect(outcome.text, 'assumed 被说成「打不开」—— 把"没确认"讲成了"确定失败"').not.toContain(
      '打不开',
    );
  });

  it('★★ 端到端对照：确定打开（create 返回窗口对象）→ 才允许说「已打开」', async () => {
    installChrome({
      allowed: true,
      createImpl: () =>
        Promise.resolve({ id: 7, incognito: true } as unknown),
    });
    const reply = await dispatchLoginOpen();
    expect(reply.opened, '拿到窗口对象时必须 opened:true').toBe(true);
    const outcome = describeLoginOutcome(reply as { type?: string; opened?: boolean; reason?: string });
    expect(outcome.text, '确定打开时文案反而没说打开').toContain('已打开');
  });

  it('★★ 端到端：权限 false → 面板必须说"权限没开"，不是笼统失败', async () => {
    installChrome({ allowed: false });
    const reply = await dispatchLoginOpen();
    // ⚠️ 探针只**读** reply，不修正它 —— 打印出来，失败时能看清全貌
    console.log('LOGIN_OPEN_REPLY ' + JSON.stringify(reply));
    expect(reply.opened).toBe(false);
    expect(reply.reason).toBe('incognito-disabled');
    const outcome = describeLoginOutcome(reply as { type?: string; opened?: boolean; reason?: string });
    expect(outcome.text, '权限没开时没说清要去哪开').toContain('InPrivate');
  });
});

describe('★★ 面板侧别处的假设：assumed 相关文本有没有变成死代码', () => {
  it('★★ ASSUMED_TEXT 必须仍然能被某个输入产出（不许变成不可达）', async () => {
    const { ASSUMED_TEXT } = await import('../../../src/content/panel/login-outcome');
    const candidates: { type?: string; opened?: boolean; reason?: string }[] = [
      { type: 'login/open:ok', opened: false, reason: 'assumed' },
      { type: 'login/open:ok', opened: true, reason: 'assumed' },
      { type: 'login/open:ok', opened: false, confirmed: false, reason: 'assumed' } as never,
    ];
    const produced = candidates.map((c) => describeLoginOutcome(c).text);
    expect(
      produced.some((t) => t === ASSUMED_TEXT),
      `ASSUMED_TEXT 已经没有任何输入能产出 ⇒ 死代码。三种候选输入的实际输出：${JSON.stringify(produced)}`,
    ).toBe(true);
  });
});
