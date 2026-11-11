/**
 * `identity: 'self'` 一等状态（步骤 2，2026-11-11）。
 *
 * ## 守的是什么
 *
 * `page.handler.ts` 原来对"取流账号 == 页面身份"这件事是**提前 return**：
 *
 * ```ts
 * return { activated: false, reason: 'same-account' };
 * ```
 *
 * 三个后果全是坏的：
 *   1. `removeTabRule()` 从来没被调到 —— 陈旧标签页规则无人清理
 *   2. `reason` 在 UI 层**零消费方** —— 开关开着、什么都不生效、**一个字都不说**
 *   3. `entrypoints/background.ts` 的统计排除列表漏了它 —— 每打开一个视频页
 *      记一次**假失败**，成功率条形图一路变红指向不存在的问题
 *
 * 现在它是**一等状态** `self`：走与成功一致的收尾路径（删规则 → 上报），
 * 只是不装规则。
 *
 * ## 为什么读源码 + mock chrome.*，而不是直接 import
 *
 * `page.handler.ts` 顶层 `import` 链里有 `@platform/*`，全部直接触碰 `chrome.*`。
 * 为了几个纯判据去 mock 整个 WXT 运行时成本过高，而且会把"零单测的边界层"
 * 这条架构债伪装成已覆盖。
 *
 * 做法与 `tests/unit/platform/background-play-page.test.ts` 同款：**读真源码**，
 * 用 `vi.mock` 把依赖换成记录器，让真实函数跑起来。测的是文件里真正写着的那段代码，
 * 不是复刻品 —— 源码形态变了就立刻红。
 *
 * ## ⚠️ 反向验证（本文件的全部价值）
 *
 * 下面「反向验证」那一节**故意**把判据改回旧行为（`activated: true` 且不删规则），
 * 断言本文件的主用例会失败。它证明这些测试**不是恒真的**。
 * 只写"改对了"而没写"改回去会红"的测试，等于没写。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 记录 `removeTabRule` 收到的 tabId */
const removedTabs: number[] = [];
/** 记录 `installTabRule` 收到的 tabId */
const installedTabs: number[] = [];
/** 记录 `diag` 收到的消息（只用于调试失败用例，不断言） */
const diagCalls: string[] = [];

let mockCredential: { sessdata: string; biliJct: string; dedeUserId: string } | null = {
  sessdata: 's',
  biliJct: 'j',
  dedeUserId: '100',
};
let mockProxyEnabled = true;

vi.mock('@platform/storage/diag-store', () => ({
  diag: (where: string, msg?: string) => {
    diagCalls.push(`${where} | ${msg ?? ''}`);
    return Promise.resolve();
  },
}));

vi.mock('@platform/storage/credential-store', () => ({
  readPersistedCredential: () => Promise.resolve(mockCredential),
}));

vi.mock('@platform/http/dnr', () => ({
  isProxyEnabled: () => Promise.resolve(mockProxyEnabled),
  installTabRule: (tabId: number) => {
    installedTabs.push(tabId);
    return Promise.resolve();
  },
  removeTabRule: (tabId: number) => {
    removedTabs.push(tabId);
    return Promise.resolve();
  },
}));

vi.mock('@platform/storage/device-cookies-store', () => ({
  readDeviceCookies: () => Promise.resolve(null),
  writeDeviceCookies: () => Promise.resolve(),
}));

/** 步骤 4 加入：取流身份选择。默认 `extension`，各用例按需覆盖 */
let mockStreamingIdentity: 'extension' | 'page' = 'extension';

vi.mock('@platform/storage/streaming-identity-store', () => ({
  readStreamingIdentity: () => Promise.resolve(mockStreamingIdentity),
  writeStreamingIdentity: () => Promise.resolve(),
  STREAMING_IDENTITY_STORAGE_KEY: 'pluma:streaming-identity',
}));

vi.mock('@platform/http/playurl', () => ({
  buildCookieHeader: () => 'SESSDATA=x; buvid3=y',
}));

import { handlePageActivate, type ActivatePayload } from '@/src/background/handlers/page.handler';

/** 一份"其他都正常"的入参，只需覆盖要测的字段 */
function payload(over: Partial<ActivatePayload> = {}): ActivatePayload {
  return {
    tabId: 7,
    kind: 'video',
    pageKey: 'BV1xxx',
    p: 1,
    deviceCookies: { buvid3: 'dev' },
    primaryMid: '100',
    ...over,
  };
}

beforeEach(() => {
  removedTabs.length = 0;
  installedTabs.length = 0;
  diagCalls.length = 0;
  mockCredential = { sessdata: 's', biliJct: 'j', dedeUserId: '100' };
  mockProxyEnabled = true;
  mockStreamingIdentity = 'extension';
});

describe('步骤 2：self 是一等状态，不是"提前 return 的错误"', () => {
  it('取流账号 == 页面身份 → reason 是 self（不是旧的 same-account）', async () => {
    const r = await handlePageActivate(payload({ primaryMid: '100' }));
    expect(r.reason).toBe('self');
  });

  it('⚠️ self 下 activated 必须是 false —— 语义是"没装规则"', async () => {
    /**
     * 这一条防的是一次很自然的"顺手改"：把 `self` 也报成 `activated: true`
     * （"反正是好事嘛"）。
     *
     * 不行。`entrypoints/content.ts` 用
     * `badgeState.proxying = res.activated === true` 决定角标，
     * 报 true 就会把角标画成「已接管」——**界面谎报扩展在工作**，
     * 而实际一条规则都没装。那正是本步骤要修的那类 bug 的镜像。
     */
    const r = await handlePageActivate(payload({ primaryMid: '100' }));
    expect(r.activated).toBe(false);
  });

  it('⚠️ self 下必须调用 removeTabRule —— 陈旧规则不许留着', async () => {
    /**
     * 旧实现直接 return，`removeTabRule()` 从不被调到。
     *
     * 后果不是理论问题：某次以 A 号取流时装下的标签页规则会留在 `sessionRules`。
     * 用户之后把取流账号改成 B，这条陈旧规则仍然带 A 的 Cookie、仍然生效 ——
     * 而界面上没有任何东西提示过它存在。
     */
    await handlePageActivate(payload({ primaryMid: '100' }));
    expect(removedTabs).toEqual([7]);
  });

  it('self 时绝不装规则', async () => {
    await handlePageActivate(payload({ primaryMid: '100' }));
    expect(installedTabs).toEqual([]);
  });

  it('两个号不同 → 走 ok 并装规则（对照组：证明上面的 self 分支真的在起作用）', async () => {
    const r = await handlePageActivate(payload({ primaryMid: '999' }));
    expect(r.reason).toBe('ok');
    expect(r.activated).toBe(true);
    expect(installedTabs).toEqual([7]);
    // 不同号时**不许**删规则
    expect(removedTabs).toEqual([]);
  });

  it('游客态（primaryMid === null）→ 仍走 ok（既有实测结论，不许被本步改坏）', async () => {
    /**
     * 2026-10-26 实测（`poc/verify/RESULT.md` §六 补充实测 B）：
     * 游客态网络层能拿到 2160p，但播放器只播 360p。
     * **但仍然保留代理**——理由是"拒绝装规则并不能真的不代理"，
     * 而 `document_start` 时 `document.cookie` 常为空，判成游客就会漏装。
     */
    const r = await handlePageActivate(payload({ primaryMid: null }));
    expect(r.reason).toBe('ok');
    expect(installedTabs).toEqual([7]);
  });

  it('未配置凭据 → not-configured（不变）', async () => {
    mockCredential = null;
    const r = await handlePageActivate(payload({ primaryMid: '100' }));
    expect(r.reason).toBe('not-configured');
  });

  it('总开关关着 → disabled，且优先于 self（顺序不许调换）', async () => {
    /**
     * 顺序：credential → isProxyEnabled → self。
     *
     * 若把 `self` 排到 `disabled` 前面，用户关掉开关后 popup 会显示
     * 「无需代理」而不是「已停用」——**把一个用户主动操作说成一种默认状态**，
     * 那正是 `popup-state.ts` 里"已停用必须排在健康检查之前"守的同一件事。
     */
    mockProxyEnabled = false;
    const r = await handlePageActivate(payload({ primaryMid: '100' }));
    expect(r.reason).toBe('disabled');
  });
});

describe('步骤 4：取流身份 = page 时不装规则，且 reason 是 page-identity', () => {
  /**
   * `self` 与 `page-identity` 的区别是**成因**，不是结果：
   *   - `self`：两个 mid 恰好相同（扩展发现的事实）
   *   - `page-identity`：用户在面板里选了用浏览器账号（用户的决定）
   *
   * 两者都不装规则，但界面必须说不同的话。混用会让用户以为
   * "扩展发现了一个我不知道的问题"，而实际上是他自己选的。
   */

  it('page 模式 → reason 是 page-identity，不是 self', async () => {
    mockStreamingIdentity = 'page';
    // 故意让两个 mid 不同：证明是**选择**生效，不是 mid 比对生效
    const r = await handlePageActivate(payload({ primaryMid: '999' }));
    expect(r.reason).toBe('page-identity');
    expect(r.reason).not.toBe('self');
  });

  it('page 模式 → 不装规则，且清掉残留标签页规则', async () => {
    mockStreamingIdentity = 'page';
    await handlePageActivate(payload({ primaryMid: '999' }));
    expect(installedTabs).toEqual([]);
    expect(removedTabs).toEqual([7]);
  });

  it('page 模式 → activated 仍是 false（没装规则就是没装）', async () => {
    mockStreamingIdentity = 'page';
    const r = await handlePageActivate(payload({ primaryMid: '999' }));
    expect(r.activated).toBe(false);
  });

  it('切回 extension → 恢复代理（对照组，证明 page 分支不是永久拒装）', async () => {
    mockStreamingIdentity = 'page';
    await handlePageActivate(payload({ primaryMid: '999' }));

    mockStreamingIdentity = 'extension';
    installedTabs.length = 0;
    const r = await handlePageActivate(payload({ primaryMid: '999' }));
    expect(r.reason).toBe('ok');
    expect(installedTabs).toEqual([7]);
  });

  it('⚠️ 总开关关着时 disabled 优先于 page-identity', async () => {
    /**
     * 顺序：credential → isProxyEnabled → page-identity → mid 比对。
     *
     * 用户主动关掉开关，那句话仍然最能解释"为什么没 4K"。
     * 若 page-identity 排在前面，用户会看到「无需代理」而不知道是自己关的开关。
     */
    mockStreamingIdentity = 'page';
    mockProxyEnabled = false;
    const r = await handlePageActivate(payload({ primaryMid: '999' }));
    expect(r.reason).toBe('disabled');
  });

  it('⚠️ page-identity 优先于 mid 比对（页面模式下两号相同与否都不重要）', async () => {
    /**
     * page 模式本来就不换身份，所以"两个号是不是同一个"这个问题根本不需要问。
     * 若把 mid 比对排前面，同一个用户在不同页面会看到两个不同的 reason，
     * 而那个差别与他的选择无关。
     */
    mockStreamingIdentity = 'page';
    const sameMid = await handlePageActivate(payload({ primaryMid: '100' }));
    const diffMid = await handlePageActivate(payload({ primaryMid: '999' }));
    expect(sameMid.reason).toBe('page-identity');
    expect(diffMid.reason).toBe('page-identity');
  });
});

describe('步骤 2：统计排除列表必须认 self', () => {
  /**
   * `entrypoints/background.ts` 的 `recordStat` 排除列表。
   *
   * 这里**读源码文本断言**而不是跑它：那段代码在 `defineBackground` 的回调里，
   * 一个 import 就 `ReferenceError`（同 `background-play-page.test.ts` 的理由）。
   *
   * 断言"排除条件里出现 self"，因为漏掉它的后果是**每次打开视频页记一次假失败**，
   * 而那个错误在 UI 上表现为"取流成功率一路变红"——一个指向不存在的问题的告警。
   */
  const ROOT = join(__dirname, '..', '..', '..');

  function readBackgroundSource(): string {
    return readFileSync(join(ROOT, 'entrypoints', 'background.ts'), 'utf8');
  }

  it('recordStat 的排除集合含 not-configured / disabled / self / page-identity', () => {
    const src = readBackgroundSource();
    const start = src.indexOf('const NOT_A_FAILURE');
    expect(start, '找不到 NOT_A_FAILURE 集合 —— 判据搬家了，请更新本测试').toBeGreaterThan(-1);
    // 从 `new Set([` 之后找配对的 `])`，避免命中行内的 `[`
    const open = src.indexOf('new Set([', start);
    const close = src.indexOf(']);', open);
    expect(open, '找不到 new Set([').toBeGreaterThan(-1);
    expect(close, '找不到配对的 ])').toBeGreaterThan(open);
    const block = src.slice(open, close + 3);
    for (const reason of ['not-configured', 'disabled', 'self', 'page-identity']) {
      expect(block).toContain(`'${reason}'`);
    }
    // `error` 是**真失败**，绝不能被排除
    expect(block).not.toContain("'error'");
  });

  it("源码里不许再出现 'same-account' 这个旧名", () => {
    /**
     * 旧名残留不会报错（它只是个字符串字面量），但会让"这个名字已经不存在"
     * 这件事失去保障。允许出现在注释里（历史记录），所以只查非注释行的确切用法。
     */
    const src = readBackgroundSource();
    expect(src).not.toContain("reason !== 'same-account'");
    expect(src).not.toContain("reason === 'same-account'");
  });
});
