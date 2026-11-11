/**
 * `switchStreamingIdentity` **不许碰总开关**（2026-11-11，修的真 bug）。
 *
 * ## 修之前是什么样
 *
 * ```ts
 * await installPathRules(cookie);
 * await chrome.storage.local.set({ [ENABLED_KEY]: true });   // ← 无条件打开
 * ```
 *
 * 用户**关掉总开关** → 切身份 `extension → page → extension` → 回到 `extension`
 * 时开关被**重新置为 true**。**用户从没表示要重新开启代理，他只是切换了身份。**
 *
 * ## 为什么这是"严重"而不是"小瑕疵"
 *
 * 总开关是用户对「是否让扩展介入」的**唯一控制点**。
 * **任何非用户操作引起它的变化都是错的。**
 *
 * 它与 `disableProxy()` 注释里记的那个 bug（"界面说停了、实际还在代理"）
 * 是**同一类不一致，方向相反**：那次是界面说停、实际在转；
 * 这次是界面（在用户下次打开时）说开着、而用户以为自己关着。
 *
 * ## 反向验证
 *
 * 把 `set({ [ENABLED_KEY]: true })` 加回 `switchStreamingIdentity` →
 * 本文件「切身份不许改开关」一组必然变红。已在任务报告里贴过实测输出。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 内存版 storage.local */
let storage: Record<string, unknown> = {};
/** 内存版规则表 */
let sessionRules: chrome.declarativeNetRequest.Rule[] = [];

/** 记录对 `ENABLED_KEY` 的**写**次数 —— 本文件的全部断言都围绕它 */
let enabledWrites = 0;

let mockCredential: { sessdata: string; biliJct: string; dedeUserId: string } | null = {
  sessdata: 's',
  biliJct: 'j',
  dedeUserId: '100',
};

const ENABLED_KEY = 'pluma:proxy-enabled';

vi.mock('@platform/storage/credential-store', () => ({
  readPersistedCredential: () => Promise.resolve(mockCredential),
}));

vi.mock('@platform/storage/streaming-identity-store', () => ({
  readStreamingIdentity: () => Promise.resolve(storage['pluma:streaming-identity'] ?? 'extension'),
  writeStreamingIdentity: (v: string) => {
    storage['pluma:streaming-identity'] = v;
    return Promise.resolve();
  },
  STREAMING_IDENTITY_STORAGE_KEY: 'pluma:streaming-identity',
}));

const chromeMock = {
  declarativeNetRequest: {
    getSessionRules: () => Promise.resolve(sessionRules.map((r) => ({ ...r }))),
    updateSessionRules: (opts: {
      removeRuleIds?: number[];
      addRules?: chrome.declarativeNetRequest.Rule[];
    }) => {
      const removing = new Set(opts.removeRuleIds ?? []);
      const kept = sessionRules.filter((r) => !removing.has(r.id));
      const added = opts.addRules ?? [];
      const addedIds = new Set(added.map((r) => r.id));
      sessionRules = [...kept.filter((r) => !addedIds.has(r.id)), ...added.map((r) => ({ ...r }))];
      return Promise.resolve();
    },
  },
  storage: {
    local: {
      get: (key: string) => Promise.resolve({ [key]: storage[key] } as Record<string, unknown>),
      set: (obj: Record<string, unknown>) => {
        if (ENABLED_KEY in obj) enabledWrites += 1;
        storage = { ...storage, ...obj };
        return Promise.resolve();
      },
    },
  },
  tabs: { query: () => Promise.resolve([]) },
};

(globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

import { switchStreamingIdentity } from '@platform/http/dnr';

beforeEach(() => {
  storage = {};
  sessionRules = [];
  enabledWrites = 0;
  mockCredential = { sessdata: 's', biliJct: 'j', dedeUserId: '100' };
});

describe('切身份**永不**写总开关（核心断言）', () => {
  it('★ 开关关着 → 切 extension → 开关仍然是 false，且**一次都没被写**', async () => {
    storage[ENABLED_KEY] = false;

    await switchStreamingIdentity('extension');

    /**
     * ⚠️ 这是本文件最重要的一条。
     * 修之前这里会是 `true`（被无条件置真），用户以为自己还关着。
     */
    expect(storage[ENABLED_KEY]).toBe(false);
    // 连"写了一次但值相同"也不接受：写操作本身是噪音，且判断条件将来会改错
    expect(enabledWrites).toBe(0);
  });

  it('★ 开关开着 → 切 page → 开关仍是 true（切身份不改变"要不要用"）', async () => {
    storage[ENABLED_KEY] = true;

    await switchStreamingIdentity('page');

    expect(storage[ENABLED_KEY]).toBe(true);
    expect(enabledWrites).toBe(0);
  });

  it('★ 开关关着 + 无凭据 → 切 extension → 不许把开关**关成** false（本来就是 false，也不许写）', async () => {
    /**
     * 修之前的另一处：凭据丢失分支里有
     * `set({ [ENABLED_KEY]: false })`，同样是不该有的副作用。
     */
    storage[ENABLED_KEY] = false;
    mockCredential = null;

    await switchStreamingIdentity('extension');

    expect(storage[ENABLED_KEY]).toBe(false);
    expect(enabledWrites).toBe(0);
  });

  it('★ 开关开着 + 无凭据 → 切 extension → 开关**保持** true，不被改成 false', async () => {
    /**
     * 用户没关，就没理由替他关。
     * 没装上规则由 `page/activate` / 诊断去如实反映，不是静默改用户设置的理由。
     */
    storage[ENABLED_KEY] = true;
    mockCredential = null;

    await switchStreamingIdentity('extension');

    expect(storage[ENABLED_KEY]).toBe(true);
    expect(enabledWrites).toBe(0);
  });
});

describe('仍然要做的事：清规则、写身份', () => {
  it('切到 page → 两类规则都清空，身份被写入', async () => {
    sessionRules = [
      { id: 10000, priority: 1, action: {}, condition: {} } as never,
      { id: 20000, priority: 2, action: {}, condition: { tabIds: [1] } } as never,
    ];

    await switchStreamingIdentity('page');

    expect(sessionRules).toEqual([]);
    expect(storage['pluma:streaming-identity']).toBe('page');
  });

  it('切到 extension → 装回全局路径规则，身份被写入', async () => {
    await switchStreamingIdentity('extension');

    const pathRules = sessionRules.filter((r) => r.id >= 10000 && r.id < 11000);
    expect(pathRules.length).toBeGreaterThan(0);
    expect(storage['pluma:streaming-identity']).toBe('extension');
  });

  it('切到 extension 且无凭据 → 不装规则，也不抛', async () => {
    mockCredential = null;
    await expect(switchStreamingIdentity('extension')).resolves.toBe(false);
    expect(sessionRules).toEqual([]);
  });

  it('返回值：page 模式返回 false（不需要代理）', async () => {
    await expect(switchStreamingIdentity('page')).resolves.toBe(false);
  });

  it('返回值：extension + 有凭据返回 true', async () => {
    await expect(switchStreamingIdentity('extension')).resolves.toBe(true);
  });
});
