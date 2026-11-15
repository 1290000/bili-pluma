/**
 * 扫码窗口心跳探测（task-24，方案 A）
 *
 * ## 这张测试要守住的核心 bug
 *
 * `openLoginWindow()` 原来判断"扫码窗口已开着"的唯一依据是 `currentWindowId`，
 * 而它在 `incognito: "split"` 下**永远拿不到**（`create()` 返回 `undefined`，
 * 一律走 `assumed` 兜底）。⇒ 用户第二次点扫码时，既不开新窗也不给提示，
 * **视觉上什么都没发生** —— 这就是用户报的「完全没反应」。
 *
 * 修法：由扫码窗口页面周期写心跳到 `chrome.storage.local`（跨分区共享），
 * 普通实例读它 + 90 秒 TTL 判断"还开着"。
 *
 * ## 为什么这些断言这样写
 *
 * 用**内存版 `chrome.storage.local`** 模拟真实存储，不 mock 被测函数 ——
 * 这样测到的是真实实现，包括过期判定、异常兜底这些容易写错的地方。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStorage {
  bag: Record<string, unknown>;
}

const store: FakeStorage = { bag: {} };

function installChrome(opts: { inIncognitoContext?: boolean } = {}): void {
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
      inIncognitoContext: opts.inIncognitoContext ?? false,
    },
    windows: {
      getAll: () => Promise.resolve([{ id: 1 }]),
      create: vi.fn(() => Promise.resolve(undefined)),
      update: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    },
    tabs: { query: () => Promise.resolve([]) },
    runtime: { getURL: (p: string) => `chrome-extension://fake${p}` },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
}

// `diag` 走真实实现会写 storage 并串行化，这里替换成空实现，
// 避免探测测试被日志写入干扰（日志本身另有测试）
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
  installChrome();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('心跳读写与过期', () => {
  it('写完能读回，且在 TTL 内', async () => {
    await mod.writeLoginHeartbeat('inst-1');
    const beat = await mod.readLoginHeartbeat();
    expect(beat).not.toBeNull();
    expect(beat?.instance).toBe('inst-1');
  });

  it('心跳超过 TTL 后读作 null（关窗后不能永远误判"还开着"）', async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await mod.writeLoginHeartbeat('inst-1');
    expect(await mod.readLoginHeartbeat()).not.toBeNull();

    // 前进到 TTL 之后 1ms
    vi.setSystemTime(now + mod.LOGIN_HEARTBEAT_TTL_MS + 1);
    expect(await mod.readLoginHeartbeat()).toBeNull();
  });

  it('恰好等于 TTL 边界时仍然有效（不早退）', async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await mod.writeLoginHeartbeat('inst-1');

    vi.setSystemTime(now + mod.LOGIN_HEARTBEAT_TTL_MS);
    expect(await mod.readLoginHeartbeat()).not.toBeNull();
  });

  it('clear 之后立刻读不到（不用等 TTL）', async () => {
    await mod.writeLoginHeartbeat('inst-1');
    await mod.clearLoginHeartbeat();
    expect(await mod.readLoginHeartbeat()).toBeNull();
  });

  it('心跳里带未来时间戳（时钟回拨）时读作 null，不当作"还活着"', async () => {
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = { at: Date.now() + 60_000, instance: 'x' };
    expect(await mod.readLoginHeartbeat()).toBeNull();
  });

  it('存储里是脏数据时读作 null 而不是抛错', async () => {
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = { at: 'not-a-number' };
    expect(await mod.readLoginHeartbeat()).toBeNull();
  });

  it('TTL 必须显著大于心跳间隔（配置自洽，防止正常节流被误判成"关了"）', () => {
    expect(mod.LOGIN_HEARTBEAT_TTL_MS).toBeGreaterThanOrEqual(mod.LOGIN_HEARTBEAT_INTERVAL_MS * 3);
  });
});

describe('probeExistingLoginWindow：分区分流', () => {
  it('普通实例读到活的心跳 → 返回心跳', async () => {
    installChrome({ inIncognitoContext: false });
    await mod.writeLoginHeartbeat('inst-1');

    const beat = await mod.probeExistingLoginWindow();
    expect(beat?.instance).toBe('inst-1');
  });

  it('普通实例没有心跳 → null（然后调用方会去 create）', async () => {
    installChrome({ inIncognitoContext: false });
    expect(await mod.probeExistingLoginWindow()).toBeNull();
  });

  it('无痕实例即使能看到自己的心跳也**不探测**', async () => {
    // 这一条是整个方案的安全闸：split 下两个实例都收到 action.onClicked。
    // 若无痕实例也去探测，它会读到自己写的心跳 → 返回 already-open →
    // **永远不创建窗口**，首次点击就再也开不出扫码窗口。
    installChrome({ inIncognitoContext: true });
    await mod.writeLoginHeartbeat('from-incognito');

    const beat = await mod.probeExistingLoginWindow();
    expect(beat).toBeNull();
  });
});

describe('openLoginWindow：第二次点击不再静默', () => {
  it('心跳活着时返回 already-open，且**不调用** windows.create', async () => {
    installChrome({ inIncognitoContext: false });
    await mod.writeLoginHeartbeat('alive');

    const res = await mod.openLoginWindow();

    expect(res.reason).toBe('already-open');
    expect(res.ok).toBe(true);
    // 关键：不许再开一个窗口（用户会看到两个二维码）
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('心跳过期后照常开窗（关窗后必须还能重新打开）', async () => {
    installChrome({ inIncognitoContext: false });
    // 直接写入一个**过期**的心跳，而不是用假时钟推进：
    // `openLoginWindow()` 里有真实的 `setTimeout(400)` 等待，
    // 开假时钟会让它一直等 → 测试超时。这里只关心"过期后不返回 already-open"。
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = {
      at: Date.now() - mod.LOGIN_HEARTBEAT_TTL_MS - 1000,
      instance: 'stale',
    };

    const res = await mod.openLoginWindow();

    expect(res.reason).not.toBe('already-open');
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('无痕实例不因心跳而跳过建窗（否则首次点击就开不出窗口）', async () => {
    installChrome({ inIncognitoContext: true });

    const res = await mod.openLoginWindow();

    expect(res.reason).not.toBe('already-open');
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('权限读到 false 时**在探测之前**就返回 incognito-disabled（2026-11-15 task-46 口径）', async () => {
    /**
     * ## ⚠️ 口径反转了（第二次），请勿按旧注释改回去
     *
     * - 2026-11-12（task-32）：本条断言「权限读 false **不**报 incognito-disabled，
     *   照常探测、照常建窗」，理由是 22 次**跨实例**读取里 true 10 / false 12、翻转 15 次。
     * - 2026-11-15（task-46）：按 **SW 实例分组**重看同一批日志，实例 `wo1xrs` 连续
     *   `isAllowedIncognitoAccess=false` **90/90** 条、`probe/instance incognito=false`
     *   **90/90** 条，一条 true 都没有；用户本人也确认权限当时是**关着的**。
     *   ⇒ 那个"翻转"是把「权限真的没开」和「不同实例的读数」混成了一条时间序列。
     *   不拦的代价是：权限关着仍 `create({incognito:true})` ⇒ 无痕分区没有本扩展
     *   ⇒ `ERR_BLOCKED_BY_CLIENT` 废页 ⇒ `create()` 返回 undefined ⇒ 报 `assumed`「成功」。
     *
     * 本条现在守的是**顺序**：权限闸门在探测**之前**。
     * 心跳活着也必须先被权限拦下 —— 否则窗口根本没建，却因为别处残留的心跳
     * 被改判成 `already-open`，用户还是看不到窗口。
     */
    installChrome({ inIncognitoContext: false });
    await mod.writeLoginHeartbeat('alive');
    (
      chrome as unknown as { extension: { isAllowedIncognitoAccess: () => Promise<boolean> } }
    ).extension.isAllowedIncognitoAccess = () => Promise.resolve(false);

    const res = await mod.openLoginWindow();
    expect(res.reason, '权限关着必须报 incognito-disabled（不是 assumed / already-open）').toBe(
      'incognito-disabled',
    );
    /** 心跳活着也不许改判：窗口没建，already-open 是谎报 */
    expect(res.reason).not.toBe('already-open');
    /** 而且一次 create 都不许发生 */
    expect(chrome.windows.create, '权限关着还去建无痕窗').not.toHaveBeenCalled();
  });

  it('closeLoginWindow 清掉心跳，让另一分区立刻知道窗口没了', async () => {
    installChrome({ inIncognitoContext: false });
    await mod.writeLoginHeartbeat('alive');

    await mod.closeLoginWindow();

    expect(await mod.readLoginHeartbeat()).toBeNull();
  });
});

describe('isIncognitoInstance 兜底', () => {
  it('API 抛错时当作普通实例（false），不抛到调用方', async () => {
    installChrome({ inIncognitoContext: false });
    Object.defineProperty(
      (globalThis as unknown as { chrome: Record<string, unknown> }).chrome['extension'] as object,
      'inIncognitoContext',
      {
        get() {
          throw new Error('not supported');
        },
      },
    );
    await mod.writeLoginHeartbeat('inst-1');

    // 不向外抛错即可；读不读得到心跳不是这一条要断言的重点
    await expect(mod.probeExistingLoginWindow()).resolves.toBeDefined();
  });
});
