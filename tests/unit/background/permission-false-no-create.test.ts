// @vitest-environment node

/**
 * 守卫：**权限读到 false 时绝不许再 create 无痕窗口**（task-46，P0）
 *
 * ## 这张测试要守住的 bug（真机已确证，不是推测）
 *
 * 用户没开「在 InPrivate 中允许」→ `openLoginWindow()` 仍执行
 * `chrome.windows.create({incognito:true, url:'chrome-extension://…/login-window.html'})`
 * → 无痕分区里**不存在这个扩展** → 那个 URL 无主体可加载 →
 * 渲染成 `ERR_BLOCKED_BY_CLIENT`（用户截图）→ `create()` 跨分区必然返回 `undefined`
 * → 落进情况 3 兜底 `{ok:true, reason:'assumed'}` → 面板显示「已尝试打开扫码窗口」。
 *
 * ⇒ **用户看到一张必然打不开的废页，代码却报了成功。**
 *
 * ## 取证（task-43 / task-46）
 *
 * 同一 SW 实例 `wo1xrs`：`isAllowedIncognitoAccess=false` **90/90** 条、
 * `probe/instance incognito=false` **90/90** 条，一条 true 都没有。
 * 用户本人确认当时权限是关着的。⇒ task-32 当年「读数会翻转、不可靠」的前提是错的
 * （那是把多个实例的读数混成了一条时间序列）。
 *
 * ## 两种测法，按被测对象分开（不混用）
 *
 * 1. `openLoginWindow()` 在 `src/background/login-window.ts` 里**导出了**，
 *    而且不依赖 WXT 全局 ⇒ **真跑它**，用内存版 `chrome` 断言行为。
 * 2. `handleLoginOpen()` 在 `entrypoints/background.ts` 里**没有导出**，
 *    那个文件顶层还要调 WXT 的 `defineBackground()`（单测环境不存在）。
 *    ⇒ 按 `need-incognito-create-diag.test.ts` 立的规矩：**剥注释后做机械断言**。
 *    它只用来守「某段代码必须/不许存在」这种结构性判据，不测取值逻辑。
 *
 * ## 反向验证（RV）
 *
 * 把 `login-window.ts` 里的 `if (!allowed) { return … }` 删掉
 * ⇒ 第 1 例（`windows.create` 未被调用）与第 3 例（不早退）同时变红。
 * 把 `assumed` 分支改回 `opened: true` ⇒ P0-2 那条静态断言变红。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStorage {
  bag: Record<string, unknown>;
}

const store: FakeStorage = { bag: {} };
let allowed = true;
let createResult: unknown = undefined;

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
      isAllowedIncognitoAccess: () => Promise.resolve(allowed),
      inIncognitoContext: false,
    },
    windows: {
      getAll: () => Promise.resolve([{ id: 1 }]),
      create: vi.fn(() => Promise.resolve(createResult)),
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
  allowed = true;
  createResult = undefined;
  // `currentWindowId` 是模块级状态，跨测试要清掉
  mod.forgetLoginWindow();
  installChrome();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('★ P0-1：权限 false ⇒ 在 create 之前就返回（真跑 openLoginWindow）', () => {
  it('isAllowedIncognitoAccess=false 时 windows.create 一次都不许被调用', async () => {
    allowed = false;

    const res = await mod.openLoginWindow();

    expect(
      chrome.windows.create,
      '权限关着还去 create 无痕窗 —— 那正是 ERR_BLOCKED_BY_CLIENT 那张废页的来源',
    ).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, reason: 'incognito-disabled' });
  });

  it('对照：权限 true 时 create 照常调用（不能把闸门做成永久关闭）', async () => {
    allowed = true;
    createResult = { id: 42, incognito: true };

    const res = await mod.openLoginWindow();

    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  it('权限 false 时也不许被心跳改判成 already-open（早退在探测之前）', async () => {
    allowed = false;
    // 即便心跳活着，权限关着也不该早退
    await mod.writeLoginHeartbeat('alive');

    const res = await mod.openLoginWindow();

    expect(res.reason).toBe('incognito-disabled');
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });
});

/**
 * 剥注释再断言 —— 直接用正则匹配会命中文档里引用的旧代码（**假红/假绿都踩过**）。
 * 拷自 `need-incognito-create-diag.test.ts:53-82` 的状态机（那里已论证过为什么
 * 不能用单条正则跨块匹配）。
 */
function stripComments(s: string): string {
  const out: string[] = [];
  let i = 0;
  let inBlock = false;
  while (i < s.length) {
    if (!inBlock && s[i] === '/' && s[i + 1] === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (inBlock && s[i] === '*' && s[i + 1] === '/') {
      inBlock = false;
      i += 2;
      continue;
    }
    if (inBlock) {
      i++;
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    out.push(s[i] ?? '');
    i++;
  }
  return out.join('');
}

const BG_SRC = stripComments(
  readFileSync(
    fileURLToPath(new URL('../../../entrypoints/background.ts', import.meta.url)),
    'utf8',
  ),
);

/** 取 `assumed` 那个分支的源码（到 `incognito-disabled` 分支之前） */
function assumedBranch(): string {
  const start = BG_SRC.indexOf("if (result.reason === 'assumed')");
  expect(start, '找不到 assumed 分支 —— 代码结构变了，请更新本测试').toBeGreaterThan(-1);
  const end = BG_SRC.indexOf("if (result.ok || result.reason === 'already-open')", start);
  expect(end, '找不到 assumed 分支的结尾').toBeGreaterThan(start);
  return BG_SRC.slice(start, end);
}

describe('★ P0-2：assumed 不许冒充成功（静态断言 handleLoginOpen）', () => {
  it('assumed 分支必须回 opened: false（不许再把"没确认"报成"已打开"）', () => {
    /**
     * 🔁 反向验证：把 `opened: false` 改回 `opened: true` → 本条必红。
     */
    const branch = assumedBranch();
    expect(branch, 'assumed 还是 opened: true —— 用户看到废页而面板说已打开').toContain(
      'opened: false',
    );
    expect(branch, 'assumed 分支里不许出现 opened: true').not.toContain('opened: true');
  });

  it('assumed 必须带 confirmed: false（区分「确定开了」与「猜它开了」）', () => {
    expect(assumedBranch()).toContain('confirmed: false');
  });

  it('assumed 仍然必须调 markLoginReady（抑制另一实例误弹说明页，别顺手删）', () => {
    /**
     * 「我们没确认」和「确定没开」是两件事：后者才该弹说明页。
     * 删掉这句会让两个实例都弹说明页 —— 又回到「开了权限还看到红字」。
     */
    expect(assumedBranch(), 'markLoginReady 被删了 —— 说明页会必然弹出').toContain(
      'await markLoginReady()',
    );
  });

  it('旧的「三合一成功条件」必须消失（它让 assumed 混进了成功分支）', () => {
    /**
     * 旧代码：`if (result.ok || result.reason === 'already-open' || result.reason === 'assumed')`
     * 这一句就是 bug 的落点 —— `assumed` 和「确实开了」走了同一条路。
     */
    expect(BG_SRC, '三合一成功条件又回来了').not.toMatch(
      /result\.ok\s*\|\|\s*result\.reason === 'already-open'\s*\|\|\s*result\.reason === 'assumed'/,
    );
  });
});
