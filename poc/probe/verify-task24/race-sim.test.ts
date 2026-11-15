// @vitest-environment node

/**
 * verifier 独立写的**场景模拟**（不改产品代码，只 import 它）。
 *
 * 目的：把 task-24 的四个重点里能用"真实执行代码"回答的那部分答出来 ——
 * 不靠读注释推理。三个场景：
 *
 *  S1 双实例正常态：无痕实例写心跳、普通实例探测 → 必须 already-open
 *  S2 🔴 inIncognitoContext 恒 false：无痕实例也探测 → 会不会读到自己写的 → 永不建窗？
 *  S3 时序：首次点击时窗口还没加载完（无心跳）→ 必须走 create
 *
 * ⚠️ 这里用的是同一份 storage bag + 可切换的 inIncognitoContext 来模拟
 * "同一扩展在两个分区里的两个 SW 实例"。它们是**两个不同的 JS 模块实例**吗？
 * 不是 —— 但 `login-window.ts` 的跨分区协调**本来就只走 storage.local**
 * （文件头铁律 2：「跨实例协调：只信 chrome.storage.local，不信内存变量」），
 * 唯一的内存变量 `currentWindowId` 在 split 下恒为 null。所以单模块 +
 * 切换 context 与真机的双实例在**这条链路上等价**。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStorage {
  bag: Record<string, unknown>;
}

const store: FakeStorage = { bag: {} };

/** 当前"哪个分区"在跑 —— 模拟切换实例 */
let currentIncognitoContext = false;
const createMock = vi.fn(() => Promise.resolve(undefined));

function installChrome(): void {
  const chromeStub = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: store.bag[key] }),
        set: (items: Record<string, unknown>) => {
          Object.assign(store.bag, items);
          return Promise.resolve();
        },
        remove: (key: string) => {
          delete store.bag[key];
          return Promise.resolve();
        },
      },
    },
    extension: {
      isAllowedIncognitoAccess: () => Promise.resolve(true),
      get inIncognitoContext(): boolean {
        return currentIncognitoContext;
      },
    },
    windows: {
      getAll: () => Promise.resolve([{ id: 1 }]),
      create: createMock,
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
  instanceId: () => 'test',
  DIAG_KEY: 'pluma:diag',
  DIAG_LIMIT: 30,
}));

const mod = await import('../../../src/background/login-window');

beforeEach(() => {
  store.bag = {};
  currentIncognitoContext = false;
  createMock.mockClear();
  createMock.mockImplementation(() => Promise.resolve(undefined));
  installChrome();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('S1 双实例正常态（inIncognitoContext 可靠）', () => {
  it('无痕实例写心跳后，普通实例探测 → already-open，且不重复建窗', async () => {
    // 无痕分区实例（扫码窗口页面所在的实例）
    currentIncognitoContext = true;
    const probeInIncog = await mod.probeExistingLoginWindow();
    expect(probeInIncog, '无痕实例必须跳过探测').toBeNull();
    await mod.writeLoginHeartbeat('incog-inst');

    // 普通分区实例
    currentIncognitoContext = false;
    const r = await mod.openLoginWindow();
    expect(r).toEqual({ ok: true, reason: 'already-open' });
    expect(createMock, '已开着的窗口不许再建一个').not.toHaveBeenCalled();
  });

  it('首次点击（无心跳）→ 走 create，返回 assumed', async () => {
    const r = await mod.openLoginWindow();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, reason: 'assumed' });
  });
});

describe('S2 🔴 inIncognitoContext 恒为 false 时的失败模式', () => {
  it('无痕实例"看不到自己是无痕" → 写入心跳后下一次点击直接 already-open（窗口开不出来）', async () => {
    // 模拟 API 恒 false：无痕实例自认为也是普通实例
    currentIncognitoContext = false;
    // 扫码窗口页面在无痕实例里写心跳（这是真机上确实会发生的事）
    await mod.writeLoginHeartbeat('incog-inst');

    // 无痕实例自己也收到 action.onClicked，于是它调 openLoginWindow()
    const r = await mod.openLoginWindow();

    // 结果：它读到自己刚写的心跳 → already-open → 不建窗
    expect(r).toEqual({ ok: true, reason: 'already-open' });
    expect(createMock, '🔴 这就是失败模式：无痕实例自己没有 create').not.toHaveBeenCalled();
  });

  it('🔴 更糟：首次点击时窗口已开着（上一个会话残留心跳）→ 直接 already-open', async () => {
    currentIncognitoContext = false;
    await mod.writeLoginHeartbeat('stale-but-fresh');
    const r = await mod.openLoginWindow();
    expect(r.reason).toBe('already-open');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('✅ 心跳过期后仍能恢复（TTL 是唯一的恢复路径）', async () => {
    // 不用 fake timers：storage stub 是 Promise，fake timers 会在 microtask 上死等。
    // 直接把"很久以前"的心跳写进 bag。
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = {
      at: Date.now() - mod.LOGIN_HEARTBEAT_TTL_MS - 1000,
      instance: 'dead',
    };
    const r = await mod.openLoginWindow();
    expect(r).toEqual({ ok: true, reason: 'assumed' });
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe('S3 时序竞态', () => {
  it('窗口刚 create、页面还没加载完（无心跳）→ 立即再点一次仍走 create', async () => {
    const r1 = await mod.openLoginWindow();
    expect(r1.reason).toBe('assumed');
    // 页面还没写心跳（加载中）
    const r2 = await mod.openLoginWindow();
    expect(r2.reason, '此时还没有心跳，探测必然读不到').toBe('assumed');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('页面写完心跳后立刻探测到（窗口被强杀时 unload 清不掉，只能等 TTL）', async () => {
    await mod.openLoginWindow();
    await mod.writeLoginHeartbeat('incog-inst'); // 页面首帧写一次
    currentIncognitoContext = false;
    const r = await mod.openLoginWindow();
    expect(r.reason).toBe('already-open');
  });
});
