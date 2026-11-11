/**
 * `tabIds` 合并 × 取流身份切换 —— **交叉处单独验一次**（2026-11-11）。
 *
 * ## 为什么要单独测这一组
 *
 * 两件事是**不同时间**做的：
 *   - `tabIds` 多标签页合并（步骤 4 的核心交付）
 *   - `switchStreamingIdentity()` 的身份切换与"不写 `ENABLED_KEY`"（之后才改）
 *
 * 它们交在同一个函数上，而**交叉处的行为没人验过**。本文件补这个缝。
 *
 * ## 已知设计限制（不是 bug，但必须写下来）
 *
 * `switchStreamingIdentity()` 会 `removeAllTabRules()` 清掉所有标签页规则，
 * 然后**只重建全局路径规则**。标签页规则要等各页面重新报到
 * （`page/activate`）才会装回来。
 *
 * 而 `page/activate` 的触发点是**页面加载**（`entrypoints/content.ts:1838`），
 * **切身份不会让它重发** —— 背景里没有任何"通知所有标签页重新报到"的机制。
 *
 * ### ⚠️ 影响面：**比初判小得多**（2026-11-11 复核修正）
 *
 * 初判写的是"对 PGC 页影响较大，因为页面不发 playurl" —— **这个判断错了**。
 * 逐条核对后（见下面 `全局路径规则覆盖两种取流` 那组）：
 *
 * | 页面 | 取流请求由谁发 | 路径 | 在**全局**路径规则里吗 |
 * | --- | --- | --- | --- |
 * | 普通视频页 | 页面自己 | `/x/player/wbi/playurl` | ✅ 在 |
 * | PGC（番剧）页 | 主世界 `pgc-fetch.ts` 的 `fetch(credentials:'include')` | `/pgc/player/web/playurl` | ✅ **也在** |
 *
 * **两种取流请求都是 `GET` + `xmlhttprequest` + 白名单路径**，与全局路径规则的
 * condition 完全吻合。所以**切身份后，两类页面的取流当场就能正确换 Cookie**。
 *
 * 标签页规则（priority 2）提供的只是**同一条路径上的更高优先级副本**，
 * 清掉它不改变结果 —— 它是 ADR 0010 时代"页面自己发、我们预测不到完整 URL"
 * 的历史产物，而全局规则早就覆盖了同样的路径。
 *
 * **所以这个限制的真实后果是：切换后规则表少了一条冗余规则，用户体验上没有可见差异。**
 * 唯一需要 `page/activate` 重建的是**诊断页的规则计数**（`ruleCount` 会短暂变小）。
 *
 * ### 为什么仍要保留这组测试
 *
 * 因为**将来若有人把某条取流路径从全局规则里移走、只靠标签页规则**，
 * 这个"无差异"的结论立刻就不成立了。这组测试就是那个结论的锚点。
 *
 * ## 为什么不在本文件里"修好它"
 *
 * 要修得让 `switchStreamingIdentity` 之后**主动让所有 B站标签页重新报到**，
 * 那要么发广播消息、要么遍历 tabs 发消息 —— 是**新链路**，
 * 且与"标签页规则该由页面自己决定 kind"的现有设计冲突
 * （background 猜不出某个标签页是 `video` 还是 `pgc`）。
 *
 * 本文件的作用是把**当前真实行为**钉住：将来有人改了这里，
 * 会立刻看到"切换后标签页规则为 0"这个事实被改变，从而必须重新评估。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let storage: Record<string, unknown> = {};
let sessionRules: chrome.declarativeNetRequest.Rule[] = [];

let mockCredential: { sessdata: string; biliJct: string; dedeUserId: string } | null = {
  sessdata: 's',
  biliJct: 'j',
  dedeUserId: '100',
};

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
        storage = { ...storage, ...obj };
        return Promise.resolve();
      },
    },
  },
  tabs: { query: () => Promise.resolve([]) },
};

(globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

import { installTabRule, removeTabRule, switchStreamingIdentity } from '@platform/http/dnr';

beforeEach(() => {
  storage = {};
  sessionRules = [];
  mockCredential = { sessdata: 's', biliJct: 'j', dedeUserId: '100' };
});

/** 标签页规则（20000 段） */
function tabRules(): chrome.declarativeNetRequest.Rule[] {
  return sessionRules.filter((r) => r.id >= 20000 && r.id < 30000);
}

/** 全局路径规则（10000 段） */
function pathRules(): chrome.declarativeNetRequest.Rule[] {
  return sessionRules.filter((r) => r.id >= 10000 && r.id < 11000);
}

describe('切换身份会清掉标签页规则 —— 已知设计限制，此处钉住真实行为', () => {
  it('★ 切换后 tab 规则为 0（要靠页面重新报到才回来）', async () => {
    // 三个视频页共用一条规则
    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(102, 'CK=ext', 'video');
    await installTabRule(103, 'CK=ext', 'video');
    expect(tabRules()).toHaveLength(1);
    expect(tabRules()[0]?.condition.tabIds).toEqual([101, 102, 103]);

    await switchStreamingIdentity('extension');

    /**
     * ⚠️ **这是当前的真实行为**，不是期望。
     *
     * 若将来有人实现了"切身份后让所有标签页重新报到"，这条会红 ——
     * **那时应该更新本条而不是删掉它**，因为"切换后画质会短暂回落"
     * 这个副作用届时才真正消失。
     */
    expect(tabRules()).toHaveLength(0);
  });

  it('切换后**全局路径规则**被按新身份重建（这层不能丢）', async () => {
    await switchStreamingIdentity('extension');
    // 全局层是切换后唯一还在工作的代理手段 —— 丢了就是"切完完全没代理"
    expect(pathRules().length).toBeGreaterThan(0);
  });

  it('切到 page 后两层规则都为空', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    await switchStreamingIdentity('page');

    expect(tabRules()).toHaveLength(0);
    expect(pathRules()).toHaveLength(0);
  });

  it('切回 extension 后，页面重新报到能重新合并 tabIds', async () => {
    /**
     * 模拟"切换 → 用户刷新页面 → 三个页面陆续重新报到"。
     * 这条验证的是：`tabIds` 合并逻辑在**规则被清空之后**仍能正确重建，
     * 不会因为"规则 ID 段残留状态"而错乱。
     */
    await installTabRule(101, 'CK=ext', 'video');
    await switchStreamingIdentity('page');
    await switchStreamingIdentity('extension');

    expect(tabRules()).toHaveLength(0); // 切回来时仍是 0

    // 三个页面重新报到
    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(102, 'CK=ext', 'video');
    await installTabRule(103, 'CK=ext', 'video');

    // 仍然合并成一条，且三个 tabId 都在
    expect(tabRules()).toHaveLength(1);
    expect(tabRules()[0]?.condition.tabIds).toEqual([101, 102, 103]);
  });

  it('切换后 removeTabRule 对已清空的状态是幂等的（不抛、不误删）', async () => {
    await switchStreamingIdentity('page');
    await expect(removeTabRule(101)).resolves.toBeUndefined();
    expect(tabRules()).toHaveLength(0);
  });
});

describe('★ 全局路径规则覆盖两种取流 —— 决定"本轮不修"是否成立', () => {
  /**
   * ## 这组是全文件的**判据核心**
   *
   * Lead 的要求：「切身份后普通视频页当场是否正常？如果普通视频页也受影响，
   * 影响面大得多，需要重新评估'本轮不修'的决策。」
   *
   * 复核结论：**不仅普通视频页正常，PGC 页也正常** —— 因为两者的取流请求
   * 都是 `GET` + 白名单路径，被**全局**路径规则命中，与标签页规则无关。
   *
   * 补充证据（代码位置）：
   *   - 普通视频：页面自己发 `/x/player/wbi/playurl`
   *   - PGC：`src/content/isolated/pgc-fetch.ts:55-58`
   *     `fetch(url, { method: 'GET', credentials: 'include' })`，
   *     注释明写"页面内 `fetch(credentials:'include')` 正是被 DNR 规则命中的那种请求"
   */

  const VIDEO_PATH = '/x/player/wbi/playurl';
  const PGC_PATH = '/pgc/player/web/playurl';

  it('★ 普通视频取流路径在**全局**路径规则里', async () => {
    await switchStreamingIdentity('extension');
    const filters = pathRules().map((r) => r.condition.urlFilter);
    expect(filters).toContain(VIDEO_PATH);
  });

  it('★ PGC 取流路径**也**在全局路径规则里（这是我初判错的地方）', async () => {
    await switchStreamingIdentity('extension');
    const filters = pathRules().map((r) => r.condition.urlFilter);
    expect(filters).toContain(PGC_PATH);
  });

  it('★ 切换身份后，两种取流路径**仍然**被全局规则覆盖', async () => {
    /**
     * 这条直接回答 Lead 的问题：切身份后当场，两类页面都不受影响。
     * 若这条红了，说明"本轮不修"的前提不成立 —— 必须重新评估。
     */
    await installTabRule(101, 'CK=ext', 'video');
    await switchStreamingIdentity('extension');

    const filters = pathRules().map((r) => r.condition.urlFilter);
    expect(filters, `切换后普通视频页失去覆盖：${filters.join(',')}`).toContain(VIDEO_PATH);
    expect(filters, `切换后 PGC 页失去覆盖：${filters.join(',')}`).toContain(PGC_PATH);
  });

  it('全局规则的 condition 与标签页规则一致（GET + xmlhttprequest + bilibili 域）', async () => {
    /**
     * 为什么必须一致：`pgc-fetch.ts` 用 `fetch(credentials:'include')` 发 GET，
     * 只有 condition 三者全对上才会被命中。
     * 任一条件放宽或收紧都会让"全局规则覆盖两种取流"这个结论失效。
     */
    await switchStreamingIdentity('extension');
    const r = pathRules().find((x) => x.condition.urlFilter === PGC_PATH);
    expect(r, '找不到 PGC 的全局路径规则').toBeDefined();
    expect(r?.condition.requestMethods).toEqual(['get']);
    expect(r?.condition.resourceTypes).toEqual(['xmlhttprequest']);
    expect(r?.condition.requestDomains).toEqual(expect.arrayContaining(['api.bilibili.com']));
  });

  it('标签页规则是**更高优先级的同路径副本**（所以清掉它不改变结果）', async () => {
    // 先把全局路径规则装好（真实场景里它由 enableProxy / 重建时装上）
    await switchStreamingIdentity('extension');
    await installTabRule(101, 'CK=ext', 'video');

    const tabRule = tabRules().find((r) => r.condition.urlFilter === VIDEO_PATH);
    const pathRule = pathRules().find((r) => r.condition.urlFilter === VIDEO_PATH);

    expect(tabRule, '找不到标签页规则').toBeDefined();
    expect(pathRule, '找不到全局路径规则').toBeDefined();
    // 标签页规则优先级更高，但两者覆盖的是**同一条路径**
    expect(tabRule?.priority).toBeGreaterThan(pathRule?.priority ?? 0);
    expect(tabRule?.condition.urlFilter).toBe(pathRule?.condition.urlFilter);
  });
});

describe('切换身份与 tabIds 合并互不污染', () => {
  it('video 与 pgc 两条规则，切换后都被清掉（不是只清一条）', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(201, 'CK=ext', 'pgc');
    expect(tabRules()).toHaveLength(2);

    await switchStreamingIdentity('extension');

    // 两类都清 —— 若只清一类，那条陈旧的会用**旧身份**继续生效
    expect(tabRules()).toHaveLength(0);
  });

  it('切换后重建的路径规则用的是**新的** Cookie 值', async () => {
    /**
     * 这是切换的全部意义：换身份 = 换取流凭据。
     * 若重建时用错值（例如从缓存拿了旧的），界面说切了而实际没切。
     */
    storage['pluma:streaming-identity'] = 'page';
    await switchStreamingIdentity('page');

    mockCredential = { sessdata: 'SESSDATA-NEW', biliJct: 'b', dedeUserId: '200' };
    await switchStreamingIdentity('extension');

    const values = pathRules().map((r) => r.action?.requestHeaders?.[0]?.value ?? '');
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(v).toContain('SESSDATA-NEW');
    }
  });
});
