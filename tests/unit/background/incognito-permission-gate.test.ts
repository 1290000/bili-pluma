/**
 * 回归闸：**权限读到 false 时必须拦在 `create()` 之前**（2026-11-15，task-46 —— 口径反转）
 *
 * ## 这个文件曾经守的是**相反的**规则（历史必须留着，别删）
 *
 * 2026-11-12（task-32）这里守的是「权限读 false **不许**拦住建窗」，
 * 依据是 diag 里 22 次读取**跨实例**的统计：`true` 10 / `false` 12、
 * 翻转 15 次、来自 21 个不同 SW 实例，而 Edge 侧权限看起来是开着的。
 * 结论是「读数会抖动、不可靠 ⇒ 改成先试再判」。
 *
 * ## 那个前提被推翻的证据（task-43 / task-46 真机复核）
 *
 * 按 **SW 实例分组**重看同一批日志：实例 `wo1xrs` 连续
 * `isAllowedIncognitoAccess=false` **90/90** 条、
 * `probe/instance incognito=false` **90/90** 条，**一条 true 都没有**。
 * 用户本人也确认「在 InPrivate 中允许」当时是**关着的**。
 *
 * ⇒ 当年那份"翻转"混进了两个不同的事实：权限真的没开 + 不同实例的读数被
 * 当成了同一实例的时间序列。**读数本身没有抖动。**
 *
 * ## 不拦的代价（本文件要守住的 bug）
 *
 * 权限关着仍然 `create({incognito:true, url:'chrome-extension://…/login-window.html'})`
 * ⇒ 无痕分区里**不存在这个扩展** ⇒ 那个 URL 无主体可加载 ⇒
 * `ERR_BLOCKED_BY_CLIENT`（用户截图）⇒ 用户看到一张废页，
 * 而 `create()` 跨分区必然返回 `undefined`，最后落进 `assumed` 报成成功。
 *
 * ## 现在的三组守卫
 *
 * 1. 权限读 false ⇒ `create` **一次都不许调用**，返回 `incognito-disabled`
 * 2. `create` 抛 incognito 错误 ⇒ 仍然是 `incognito-disabled`（第二道闸没被删）
 * 3. 源码级：`allowed` 的**唯一**合法用途是「`diag` 记录 + 一个提前返回」，
 *    不许再长出别的分支
 *
 * 🔁 反向验证：把 `login-window.ts` 里
 * ```ts
 * if (!allowed) { return { ok: false, reason: 'incognito-disabled' }; }
 * ```
 * 删掉 → 第 1 组与第 3 组同时变红（实测见 task-46 交付说明）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface FakeStorage {
  bag: Record<string, unknown>;
}

const store: FakeStorage = { bag: {} };

/** `create` 的行为由每个用例自己装（这里只留一个可替换的钩子） */
let createImpl: () => Promise<unknown> = () => Promise.resolve(undefined);

function installChrome(opts: { allowed?: boolean; inIncognitoContext?: boolean } = {}): void {
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
      /** ⚠️ 本文件的**主题**：这个值决定要不要建无痕窗（2026-11-15 起是真闸） */
      isAllowedIncognitoAccess: () => Promise.resolve(opts.allowed ?? true),
      inIncognitoContext: opts.inIncognitoContext ?? false,
    },
    windows: {
      getAll: () => Promise.resolve([{ id: 1 }]),
      create: vi.fn(() => createImpl()),
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
  createImpl = () => Promise.resolve(undefined);
  mod.forgetLoginWindow();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('★★★ 权限读 false 必须拦在 create 之前（task-46 回归闸）', () => {
  it('★★ 权限读 false → create() 一次都不许调用，返回 incognito-disabled', async () => {
    installChrome({ allowed: false });
    createImpl = () => Promise.resolve(undefined);

    const r = await mod.openLoginWindow();

    const created = (
      globalThis as unknown as { chrome: { windows: { create: { mock: { calls: unknown[][] } } } } }
    ).chrome.windows.create;
    expect(
      created.mock.calls.length,
      '权限关着还去 create 无痕窗 —— 无痕分区里没有本扩展，那个 URL 必然 ERR_BLOCKED_BY_CLIENT',
    ).toBe(0);
    expect(r).toEqual({ ok: false, reason: 'incognito-disabled' });
  });

  it('★★ 权限读 false + create 若被调用会抛普通错误 → 仍必须是 incognito-disabled', async () => {
    /**
     * 这条保证**判据来源**是权限读数本身，而不是"create 恰好抛了个什么错"。
     * 旧版本（task-32）在这一格断言 `unknown`；现在闸门在 create 之前，
     * create 根本不该被调用，所以结果必须是 incognito-disabled。
     */
    installChrome({ allowed: false });
    createImpl = () => Promise.reject(new Error('No current window'));

    const r = await mod.openLoginWindow();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('incognito-disabled');
  });
});

describe('★★ create 抛 incognito 错误仍然是第二道闸（失败路径没被删）', () => {
  it('★★ 权限读 true 但 create 抛 incognito 权限错误 → incognito-disabled', async () => {
    /** 权限**开着**却仍被拒 ⇒ 说明这条判据来自 create 本身，与预读无关（两道闸互为兜底） */
    installChrome({ allowed: true });
    createImpl = () =>
      Promise.reject(new Error('You do not have permission to use incognito mode'));

    const r = await mod.openLoginWindow();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('incognito-disabled');
  });

  it('权限读 true + create 成功 → 照常 ok（正面回归，闸门没做成永久关闭）', async () => {
    installChrome({ allowed: true });
    createImpl = () => Promise.resolve(undefined);
    const r = await mod.openLoginWindow();
    expect(r.ok).toBe(true);
  });
});

describe('★★★ 源码级：`allowed` 只许用于记录 + 一个提前返回', () => {
  /**
   * 行为用例能守"这次构造下拦住了"，但守不住"有人又加了一条 `if (allowed)` 分支
   * 把闸门绕过去"。这里剥注释后**逐个 `allowed` 出现点**检查形状。
   *
   * ⚠️ 必须剥注释：函数体上方那段大注释里写满了 `isAllowedIncognitoAccess`
   * 和 `allowed`，不剥就会**假绿**（注释里已经"出现过"了）。
   */
  it('★★ 剥注释后，`allowed` 的出现点只许是声明 / diag / 那一个提前返回', () => {
    const src = readFileSync(join(process.cwd(), 'src/background/login-window.ts'), 'utf8');
    /**
     * ⚠️ 2026-11-15：判定体从 `openLoginWindow()` 挪到了
     * `openLoginWindowOnce()`（外层只做 in-flight 去重，见 P0 并发修复）。
     * 本条守的是**判定逻辑**，所以切判定体那一层 —— 切外层会把断言变成空壳。
     */
    const start = src.indexOf('async function openLoginWindowOnce');
    expect(start, '找不到 openLoginWindowOnce（判定体）').toBeGreaterThan(-1);

    /** 从函数起点按花括号配平切出函数体 */
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
    expect(body.length, '切片为空，配平坏了').toBeGreaterThan(200);

    const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const allowedLines = codeOnly
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\ballowed\b/.test(l));
    expect(allowedLines.length, '一个 allowed 都没找到 —— 切片或剥注释坏了').toBeGreaterThan(0);

    for (const line of allowedLines) {
      const okShape =
        /^const\s+allowed\s*=/.test(line) ||
        /^await\s+diag\(/.test(line) ||
        /^\w*\s*String\(allowed\)/.test(line) ||
        /^if\s*\(\s*!allowed\s*\)\s*\{\s*$/.test(line);
      expect(
        okShape,
        `\`allowed\` 被用进了计划外的分支（只许"记录 + 一个提前返回"）：${line}`,
      ).toBe(true);
    }

    /** 那个提前返回**必须**存在，且必须返回 incognito-disabled */
    expect(
      codeOnly,
      '`if (!allowed)` 提前返回不见了 —— 权限关着又会去 create 无痕窗（本 bug 的原文）',
    ).toMatch(/if\s*\(\s*!allowed\s*\)\s*\{[\s\S]{0,200}?reason:\s*'incognito-disabled'/);
  });
});
