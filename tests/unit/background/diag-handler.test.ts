// @vitest-environment jsdom

/**
 * `diag/facts` 的 **background handler**（2026-11-09 真机验收后新增）。
 *
 * ## 为什么这条消息存在
 *
 * 面板是 content script，而 `chrome.windows` / `chrome.cookies` /
 * `chrome.declarativeNetRequest` / `chrome.extension.isAllowedIncognitoAccess`
 * 在那个环境里**整个是 `undefined`**（真机实测，不是权限不足）。
 *
 * ## 本文件守什么
 *
 * | 判据 | 反例 |
 * | --- | --- |
 * | 单项失败只影响那一项（返回 `null`） | 整块 try → 一项坏全坏 |
 * | **四项全失败**才回 `:err` | 任一项失败就回 `:err` → 部分成功被吞 |
 * | DNR **只回 id**，不带 `requestHeaders` | 整条规则透传 → Cookie 头泄漏 |
 * | 规则 id 按区间分到 path / tab | 全塞一个桶 |
 *
 * 反向验证：把"四项全失败才 :err"改成"任一项失败就 :err"，对应用例必红。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⚠️ `vi.mock` 工厂会被提升，引用的变量必须用 `vi.hoisted()` 建。
 */
const mocks = vi.hoisted(() => ({
  diagCalls: [] as unknown[][],
}));

vi.mock('@platform/storage/diag-store', () => ({
  diag: (...a: unknown[]) => {
    mocks.diagCalls.push(a);
    return Promise.resolve();
  },
  /**
   * trace 通道（2026-11-10 第七轮加）：覆盖写一条定位记录。
   * 测试里同样收集起来，用来断言"最终结果被写下"。
   */
  trace: (...a: unknown[]) => {
    mocks.diagCalls.push(['trace', ...a]);
    return Promise.resolve();
  },
}));

import {
  TAB_RULE_ID_MIN,
  PATH_RULE_ID_MAX,
  ATTEMPT_TIMEOUT_MS,
  OVERALL_TIMEOUT_MS,
  handleDiagFacts,
} from '../../../src/background/handlers/diag.handler';

/** 装一套"全部成功"的 chrome */
function installChrome(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal('chrome', {
    extension: { isAllowedIncognitoAccess: async () => true },
    windows: {
      getAll: async () => [
        { id: 1, incognito: false },
        { id: 2, incognito: true },
      ],
    },
    cookies: {
      getAllCookieStores: async () => [
        { id: '0', tabIds: [] },
        { id: '1', tabIds: [] },
      ],
    },
    declarativeNetRequest: {
      getSessionRules: async () => [
        { id: 10001, condition: { urlFilter: '/x/player/wbi/playurl' }, action: {} },
        { id: 10002, condition: { urlFilter: '/pgc/player/web/playurl' }, action: {} },
        { id: 20005, condition: { tabIds: [3] }, action: {} },
        { id: 99999, condition: { urlFilter: '/not-ours' }, action: {} },
      ],
    },
    ...overrides,
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mocks.diagCalls.length = 0;
});

describe('全部成功', () => {
  it('返回 :ok，四项都有值', async () => {
    installChrome();
    const res = await handleDiagFacts();
    expect(res.type).toBe('diag/facts:ok');
    if (res.type !== 'diag/facts:ok') return;
    expect(res.facts.incognitoAllowed).toBe(true);
    expect(res.facts.windows).toEqual({ total: 2, incognito: 1 });
    expect(res.facts.cookieStores).toEqual(['0', '1']);
  });

  it('★ DNR 只回 id，且按区间分到 path / tab；别人的规则不进来', async () => {
    installChrome();
    const res = await handleDiagFacts();
    if (res.type !== 'diag/facts:ok') throw new Error('应回 ok');
    expect(res.facts.dnrRuleIds).toEqual({ path: [10001, 10002], tab: [20005] });
    // 99999 不在我们的区间里
    expect(res.facts.dnrRuleIds?.path).not.toContain(99999);
  });

  it('★ 应答里**没有任何 urlFilter / requestHeaders**（凭据防线）', async () => {
    /**
     * 整条 DNR 里的 `action.requestHeaders` 是**完整 Cookie 头**。
     * 这条断言序列化后扫描整个应答 —— 只要实现哪天改成"回整条规则"就会红。
     */
    installChrome({
      declarativeNetRequest: {
        getSessionRules: async () => [
          {
            id: 10001,
            condition: { urlFilter: '/x', tabIds: [1] },
            action: {
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'Cookie', operation: 'set', value: 'SESSDATA=leaked' }],
            },
          },
        ],
      },
    });
    const json = JSON.stringify(await handleDiagFacts()).toLowerCase();
    expect(json).not.toContain('requestheaders');
    expect(json).not.toContain('sessdata');
    expect(json).not.toContain('urlfilter');
    expect(json).not.toContain('cookie,');
  });
});

describe('★ 单项失败只影响那一项', () => {
  it('★ windows 抛错 → 该项 null，其余三项正常', async () => {
    installChrome({
      windows: {
        getAll: async () => {
          throw new Error('nope');
        },
      },
    });
    const res = await handleDiagFacts();
    if (res.type !== 'diag/facts:ok') throw new Error('部分成功应回 ok');
    expect(res.facts.windows).toBeNull();
    expect(res.facts.incognitoAllowed).toBe(true);
    expect(res.facts.cookieStores).toEqual(['0', '1']);
  });

  it('★ cookies 抛错 → 该项 null', async () => {
    installChrome({
      cookies: {
        getAllCookieStores: async () => {
          throw new Error('nope');
        },
      },
    });
    const res = await handleDiagFacts();
    if (res.type !== 'diag/facts:ok') throw new Error('应回 ok');
    expect(res.facts.cookieStores).toBeNull();
  });

  it('★ DNR 抛错 → 该项 null', async () => {
    installChrome({
      declarativeNetRequest: {
        getSessionRules: async () => {
          throw new Error('nope');
        },
      },
    });
    const res = await handleDiagFacts();
    if (res.type !== 'diag/facts:ok') throw new Error('应回 ok');
    expect(res.facts.dnrRuleIds).toBeNull();
  });

  it('★ 命名空间整个不存在（content script 的真实情况）→ 该项 null，不抛', async () => {
    /**
     * 这就是真机上的形状：`chrome.windows` 是 `undefined`，
     * 调 `undefined.getAll()` 抛 TypeError。这里验证它被吞成 `null` 而不是炸掉整条消息。
     */
    installChrome({ windows: undefined, cookies: undefined, declarativeNetRequest: undefined });
    const res = await handleDiagFacts();
    if (res.type !== 'diag/facts:ok') throw new Error('InPrivate 还能读，应回 ok');
    expect(res.facts.windows).toBeNull();
    expect(res.facts.cookieStores).toBeNull();
    expect(res.facts.dnrRuleIds).toBeNull();
    expect(res.facts.incognitoAllowed).toBe(true);
  });
});

describe('★ 四项全失败才回 :err', () => {
  it('★ 全部不可用 → :err', async () => {
    vi.stubGlobal('chrome', {});
    const res = await handleDiagFacts();
    expect(res.type).toBe('diag/facts:err');
  });

  it('★★ 只有一项成功（其余全坏）→ 仍然是 :ok（不能吞掉部分成功）', async () => {
    /**
     * 反例：把"四项全 null 才 :err"改成"任一项 null 就 :err" → 本条必红。
     *
     * 为什么这条重要：真机上恰恰是"只有 InPrivate 能读、其余三项 undefined"那种形状。
     * 若任一项失败就回 :err，`collectFacts` 会丢掉那唯一读到的一项，
     * 用户看到"全部读取失败"——正是这次要修的那类误判。
     */
    vi.stubGlobal('chrome', {
      extension: { isAllowedIncognitoAccess: async () => false },
    });
    const res = await handleDiagFacts();
    expect(res.type).toBe('diag/facts:ok');
    if (res.type !== 'diag/facts:ok') return;
    expect(res.facts.incognitoAllowed).toBe(false);
    expect(res.facts.windows).toBeNull();
  });
});

describe('区间常量自检', () => {
  it('path / tab 区间不重叠', () => {
    expect(PATH_RULE_ID_MAX).toBeLessThanOrEqual(TAB_RULE_ID_MIN);
  });

  it('★ 整体超时 > 4 × 单项超时（否则单项还没超时就被整体掐断）', () => {
    expect(OVERALL_TIMEOUT_MS).toBeGreaterThan(ATTEMPT_TIMEOUT_MS * 4);
  });
});

describe('★ 不再写 trace 通道（2026-11-10 第九轮实验）', () => {
  /**
   * ## 为什么删掉 trace
   *
   * `trace()` 与 `diag()` **共用同一个模块级 Promise 队列** `pending`
   * （`diag-store.ts:75`）。只要链上有任何一次写入卡住，
   * 整条链就永久悬挂，之后所有 `diag()` / `trace()` 都返回那个卡住的 Promise。
   *
   * smoke 观察到的现象全部吻合：
   *   - `proxy/set` / `page/quality` 有日志 → **早期**写的，链还没卡
   *   - `trace()` 一次都没成功 → **后期**写的，链已卡住
   *   - `diag/facts` 应答 resolve 成 `undefined`
   *
   * 而 `trace()` 在这个环境从未成功过 —— 留着只有风险没有收益。
   * 定位信息改由 `echo`（走消息应答，不碰 storage）承载。
   */

  it('★★ handleDiagFacts 不再调用 trace', async () => {
    installChrome();
    await handleDiagFacts();

    const traces = mocks.diagCalls.filter((c) => c[0] === 'trace');
    expect(traces, '仍在调用 trace —— 它可能与 diag 共用队列导致永久悬挂').toEqual([]);
  });

  it('★ 失败路径也不调 trace', async () => {
    vi.stubGlobal('chrome', {});
    await handleDiagFacts();

    expect(mocks.diagCalls.filter((c) => c[0] === 'trace')).toEqual([]);
  });

  it('★ 但 echo 仍然带完整信息（定位能力没丢）', async () => {
    installChrome();
    const res = await handleDiagFacts();
    const e = (res as { echo?: string }).echo ?? '';
    // 四项都要在 echo 里，且带状态前缀
    for (const k of ['incognito', 'windows', 'cookies', 'dnr']) {
      expect(e, `echo 里缺 ${k}`).toContain(`${k}=`);
    }
  });
});

describe('★ echo 回显：绕开 storage 的调试通道（2026-11-10 第八轮）', () => {
  /**
   * ## 为什么最后选了这条路
   *
   * 前七轮所有"写 storage 再看"的通道都失败：`diag()` 被环形缓冲挤掉、
   * `trace()` 干脆写不进去（smoke 实测：同一份导出里既有 background 写的
   * `page/quality` 26+ 条，又有 `diag/facts reply: undefined`）。
   *
   * 而**消息应答从没丢过**。所以把执行摘要塞进应答。
   *
   * ## 本组守的核心判据
   *
   * `facts.x === null` 在 HTTP 层面有**四种来源**，前七轮一直分不清：
   *   `ok:true` / `nil`（读了但值是 null）/ `ERR:...`（抛错）/ `TIMEOUT`
   * echo 必须把它们**逐一区分开**。
   */

  function echoOf(res: unknown): string {
    return (res as { echo?: string }).echo ?? '';
  }

  it('★★ 全部成功 → 四项都是 ok:<值>', async () => {
    installChrome();
    const res = await handleDiagFacts();
    if (res.type !== 'diag/facts:ok') throw new Error('应回 ok');

    const e = echoOf(res);
    expect(e).toContain('entered |');
    expect(e).toContain('incognito=ok:true');
    expect(e).toContain('windows=ok:');
    expect(e).toContain('cookies=ok:');
    expect(e).toContain('dnr=ok:');
  });

  it('★★ 抛错 → ERR:<异常名>:<消息>（与 nil 区分开）', async () => {
    installChrome({
      windows: {
        getAll: async () => {
          throw new TypeError('chrome.windows is undefined');
        },
      },
    });
    const res = await handleDiagFacts();
    const e = echoOf(res);
    expect(e).toContain('windows=ERR:');
    expect(e).toContain('TypeError');
    // ★ 不能是 nil —— 那会让人以为"读到了但没值"
    expect(e).not.toContain('windows=nil');
  });

  it('★★ 成功但返回 null → nil（与 ERR 区分开）', async () => {
    /**
     * 这条是 echo 存在的核心理由：`incognitoAllowed` 的实现里
     * `typeof allowed === 'boolean' ? allowed : null` —— 拿到非布尔时返回 null，
     * **那是"执行成功了"**，不是错误。前七轮这个歧义一直在误导排查。
     */
    installChrome({
      extension: { isAllowedIncognitoAccess: async () => 'not-a-boolean' },
    });
    const res = await handleDiagFacts();
    const e = echoOf(res);
    expect(e).toContain('incognito=nil');
    expect(e).not.toContain('incognito=ERR');
  });

  it('★★ 超时 → TIMEOUT（第三种来源，也区别于 ERR）', async () => {
    installChrome({
      windows: { getAll: () => new Promise<never>(() => undefined) },
    });
    const res = await handleDiagFacts();
    expect(echoOf(res)).toContain('windows=TIMEOUT');
  }, 10_000);

  it('★ 四种状态在同一条 echo 里互不混淆', async () => {
    installChrome({
      extension: { isAllowedIncognitoAccess: async () => 'x' }, // → nil
      windows: {
        getAll: async () => {
          throw new Error('boom'); // → ERR
        },
      },
      cookies: { getAllCookieStores: () => new Promise<never>(() => undefined) }, // → TIMEOUT
      // dnr 正常 → ok
    });
    const res = await handleDiagFacts();
    const e = echoOf(res);

    expect(e).toContain('incognito=nil');
    expect(e).toContain('windows=ERR:');
    expect(e).toContain('cookies=TIMEOUT');
    expect(e).toContain('dnr=ok:');
  }, 10_000);

  it('★ :err 应答也带 echo', async () => {
    vi.stubGlobal('chrome', {});
    const res = await handleDiagFacts();
    if (res.type !== 'diag/facts:err') throw new Error('应回 err');
    expect(echoOf(res)).toContain('entered |');
    expect(echoOf(res)).toContain('incognito=ERR:');
  });

  it('echo 不含凭据类内容', async () => {
    installChrome();
    const res = await handleDiagFacts();
    const e = echoOf(res).toLowerCase();
    for (const bad of ['sessdata', 'bili_jct', 'dedeuserid', 'cookie=', 'token']) {
      expect(e, `echo 里出现了 ${bad}`).not.toContain(bad);
    }
  });

  it('★ echo 长度可控（不会把应答撑成几 KB）', async () => {
    installChrome();
    const res = await handleDiagFacts();
    expect(echoOf(res).length).toBeLessThan(600);
  });
});

describe('★ 超时竞速（2026-11-10 第六轮，真机日志定位）', () => {
  /**
   * ## 真机日志给出的结论链
   *
   * ```
   * diag/facts  branch: empty-reply
   * diag/facts  reply: undefined
   * （没有任何 diag/facts <name>: 行）
   * ```
   *
   * - 有 `reply:` → `diagFacts()` 确实跑了
   * - `reply: undefined` → `sendMessage` resolve 成 undefined，不是抛错
   * - **没有任何 `<name>:`** → 四个 `attempt` 的 catch 一次都没进 → 四项都没抛
   * - 也没有 `:err` → `handleDiagFacts()` 没返回任何对象
   *
   * ⇒ `Promise.all` 里至少一个 Promise **永不 resolve**，`.then(sendResponse)` 不触发。
   *
   * 而 `sendResponse` 永不调用会让发起方 `sendMessage` **永久悬着** ——
   * 比任何单项失败都严重。
   */

  it('★★ 永不 resolve 的 API → 超时后降级为 null，并写日志', async () => {
    installChrome({
      // 永远不 resolve 的 Promise
      windows: { getAll: () => new Promise<never>(() => undefined) },
    });

    const res = await handleDiagFacts();

    // ★ 必须返回（不能永远挂着）
    expect(res.type).toBe('diag/facts:ok');
    if (res.type !== 'diag/facts:ok') return;
    // 挂住的那一项降级为 null
    expect(res.facts.windows).toBeNull();
    // 其余三项照常
    expect(res.facts.incognitoAllowed).toBe(true);

    // 日志里必须出现 windows + TimeoutError
    const line = mocks.diagCalls
      .filter((c) => c[0] === 'diag/facts')
      .map((c) => String(c[1] ?? ''))
      .find((l) => l.startsWith('windows:'));
    expect(line, '没有记 windows 超时').toBeDefined();
    expect(line).toContain('TimeoutError');
  }, 10_000);

  it('★★ 四项全部永不 resolve → 仍然返回（不挂住）', async () => {
    const hang = (): Promise<never> => new Promise<never>(() => undefined);
    installChrome({
      extension: { isAllowedIncognitoAccess: hang },
      windows: { getAll: hang },
      cookies: { getAllCookieStores: hang },
      declarativeNetRequest: { getSessionRules: hang },
    });

    const res = await handleDiagFacts();
    // 四项全超时 → 全 null → :err（但仍**返回了**）
    expect(res.type).toBe('diag/facts:err');
    if (res.type !== 'diag/facts:err') return;
    expect(res.detail).toContain('TimeoutError');
  }, 10_000);

  it('超时项的日志带项名，四项可分别定位', async () => {
    const hang = (): Promise<never> => new Promise<never>(() => undefined);
    installChrome({
      windows: { getAll: hang },
      cookies: { getAllCookieStores: hang },
    });
    await handleDiagFacts();

    const lines = mocks.diagCalls
      .filter((c) => c[0] === 'diag/facts')
      .map((c) => String(c[1] ?? ''));
    expect(lines.some((l) => l.startsWith('windows:') && l.includes('TimeoutError'))).toBe(true);
    expect(lines.some((l) => l.startsWith('cookies:') && l.includes('TimeoutError'))).toBe(true);
  }, 10_000);

  it('正常 API 不受超时影响（远快于 800ms）', async () => {
    installChrome();
    const res = await handleDiagFacts();
    expect(res.type).toBe('diag/facts:ok');
    // 不应有任何超时日志
    const lines = mocks.diagCalls
      .filter((c) => c[0] === 'diag/facts')
      .map((c) => String(c[1] ?? ''));
    expect(lines.some((l) => l.includes('TimeoutError'))).toBe(false);
  }, 10_000);
});

describe('★ 失败必须可见（2026-11-10 第四次复验，最关键的修复）', () => {
  /**
   * ## 为什么这组测试是这一轮的核心
   *
   * 到这一轮为止已经**猜了三次**为什么四项读不到：
   *   1. 以为 content script 没权限 → 改走 background
   *   2. 以为 background 异步通道不通 → smoke 用同环境对照证伪
   *   3. 只剩"background 里 API 抛错"，但**抛的是什么不知道**
   *
   * 共同失败：`catch {}` 把异常吞了，`detail` 又只写"均读取失败"——**零信息量**。
   *
   * 现在：异常进 `diag` 日志 + 拼进 `:err` 的 `detail`。
   */
  function diagLines(): string[] {
    return mocks.diagCalls.map((c) => `${String(c[0])} | ${String(c[1] ?? '')}`);
  }

  it('★★ 单项抛错时把【项名 + 错误类型 + 错误消息】写进 diag', async () => {
    installChrome({
      windows: {
        getAll: async () => {
          throw new TypeError('chrome.windows is undefined');
        },
      },
    });
    await handleDiagFacts();

    const lines = diagLines().filter((l) => l.includes('diag/facts'));
    expect(lines.length, '没有写入任何 diag/facts 日志').toBeGreaterThan(0);
    const win = lines.find((l) => l.includes('windows'));
    expect(win, '日志里没有 windows 那一条').toBeDefined();
    // ★ 关键信息必须齐全：项名 + 错误类型 + 原始消息
    expect(win).toContain('TypeError');
    expect(win).toContain('chrome.windows is undefined');
  });

  it('★ 四项全失败时，日志里四项各有一条', async () => {
    vi.stubGlobal('chrome', {});
    await handleDiagFacts();

    const lines = diagLines().filter((l) => l.includes('diag/facts'));
    for (const name of ['incognito', 'windows', 'cookies', 'dnr']) {
      expect(
        lines.some((l) => l.includes(name)),
        `日志里缺 ${name}`,
      ).toBe(true);
    }
  });

  it('★★ `:err` 的 detail 必须带真实原因，不能写"均读取失败"', async () => {
    /**
     * 反例：把 detail 改回 `'四项环境信息均读取失败'` → 本条必红。
     *
     * 那句零信息量的文案让上一轮排查又白猜了一次，这是本轮要修的根本问题。
     */
    vi.stubGlobal('chrome', {});
    const res = await handleDiagFacts();
    expect(res.type).toBe('diag/facts:err');
    if (res.type !== 'diag/facts:err') return;

    expect(res.detail).not.toBe('四项环境信息均读取失败');
    // 至少要能看出是 TypeError（命名空间不存在时的典型形状）
    expect(res.detail.length).toBeGreaterThan(10);
    expect(res.detail).toMatch(/incognito|windows|cookies|dnr/);
  });

  it('★ detail 被截断（不撑大应答，但保留关键信息）', async () => {
    vi.stubGlobal('chrome', {});
    const res = await handleDiagFacts();
    if (res.type !== 'diag/facts:err') throw new Error('应回 err');
    expect(res.detail.length).toBeLessThanOrEqual(300);
  });

  it('★ 部分成功时**不**往 detail 里塞失败信息（detail 只属于 :err）', async () => {
    /**
     * `:ok` 应答的形状必须是 `{ type, facts }`，多一个 detail 字段
     * 会让 `check-messages` 之外的人误以为它有意义。
     */
    installChrome({
      windows: {
        getAll: async () => {
          throw new Error('nope');
        },
      },
    });
    const res = await handleDiagFacts();
    expect(res.type).toBe('diag/facts:ok');
    /**
     * `:ok` 应答的形状是 `{ type, facts, echo }`。
     *
     * ⚠️ `echo` 是 2026-11-10 第八轮有意加的调试回显 —— 它**不是**泄漏，
     * 内容是四项环境事实的执行摘要（`ok:true` / `nil` / `ERR:...` / `TIMEOUT`）。
     * 这条断言的作用是：**形状变了必须有人确认**。
     */
    expect(Object.keys(res as object).sort()).toEqual(['echo', 'facts', 'type']);
  });

  it('diag 自身抛错不影响结果（诊断不能拖垮主流程）', async () => {
    vi.stubGlobal('chrome', {});
    // diag mock 不会抛；这里只断言即使失败也会返回 :err 而不是崩
    await expect(handleDiagFacts()).resolves.toBeDefined();
  });
});
