/**
 * `tabIds` 多标签页合并 —— 步骤 4 的**核心证据**（2026-11-11）。
 *
 * ## 为什么这条测试是步骤 4 的命门
 *
 * `dnr.ts` 是全仓**风险最高**、且**无法用真实浏览器在 Vitest 里跑**的文件。
 * 但"规则表长什么样"这件事是 (规则 input, 规则 output) 的纯映射 ——
 * 用一份**内存版 `chrome.declarativeNetRequest`** 就能完整验证，
 * 不需要真浏览器。两个 PoC 脚本验的是"规则真的在浏览器里生效"，
 * 本文件验的是"我们交给浏览器的那张表是对的"。**两者不可互相替代。**
 *
 * ## 守的到底是什么
 *
 * 旧实现：`TAB_RULE_BASE + (tabId % TAB_RULE_SPAN)` → **一个标签页一条规则**。
 * 新实现：一条规则 + `condition.tabIds` 数组 → **O(页面类型数)**。
 *
 * 规则数不降的后果不是"慢"，是**撞 session 规则上限 5000 后一条都加不进去**
 * （实测 `poc/probe/dnr-initiator/RESULT.md` Q3.1），
 * 而撞上限时取流**静默回落到页面身份**，界面无任何报错。
 *
 * ## 反向验证
 *
 * 本文件的每条关键断言都配了一个"改回一 tab 一规则"的对照说明。
 * 实跑记录见任务报告（把 `tabRuleIdForKind` 换回 `TAB_RULE_BASE + tabId % SPAN`
 * 之后，`3 个标签页 → 1 条规则` 这条会变成 3 条，断言红）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 内存版规则表 */
let sessionRules: chrome.declarativeNetRequest.Rule[] = [];

/** 记录 `updateSessionRules` 被调了几次（用于验证"幂等时不重建"） */
let updateCalls = 0;

vi.mock('@platform/storage/credential-store', () => ({
  readPersistedCredential: () => Promise.resolve(null),
  hasPersistedCredential: () => Promise.resolve(false),
  persistCredential: () => Promise.resolve(),
  removeCredential: () => Promise.resolve(),
}));

vi.mock('@platform/storage/streaming-identity-store', () => ({
  readStreamingIdentity: () => Promise.resolve('extension' as const),
  writeStreamingIdentity: () => Promise.resolve(),
  STREAMING_IDENTITY_STORAGE_KEY: 'pluma:streaming-identity',
}));

/** 最小 `chrome` 替身：只实现 dnr.ts 用到的三个方法 */
const chromeMock = {
  declarativeNetRequest: {
    getSessionRules: () => Promise.resolve(sessionRules.map((r) => ({ ...r }))),
    updateSessionRules: (opts: {
      removeRuleIds?: number[];
      addRules?: chrome.declarativeNetRequest.Rule[];
    }) => {
      updateCalls += 1;
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
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
    },
  },
  tabs: { query: () => Promise.resolve([]) },
};

// `dnr.ts` 在模块作用域里直接用全局 `chrome`，所以必须在 import 之前挂上
(globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

import { installTabRule, removeTabRule } from '@platform/http/dnr';

beforeEach(() => {
  sessionRules = [];
  updateCalls = 0;
});

/** 取标签页规则（20000 段） */
function tabRules(): chrome.declarativeNetRequest.Rule[] {
  return sessionRules.filter((r) => r.id >= 20000 && r.id < 30000);
}

describe('核心证据：同类型的 N 个标签页共用 1 条规则', () => {
  it('打开 3 个普通视频页 → 规则数 = 1（不是 3）', async () => {
    /**
     * ⚠️ **反向验证的锚点**：把 `tabRuleIdForKind()` 改回
     * `TAB_RULE_BASE + (tabId % TAB_RULE_SPAN)`，这条会变成 `3` 而失败。
     */
    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(102, 'CK=ext', 'video');
    await installTabRule(103, 'CK=ext', 'video');

    expect(tabRules()).toHaveLength(1);
    expect(tabRules()[0]?.condition.tabIds).toEqual([101, 102, 103]);
  });

  it('video 与 pgc 各一条 —— 规则数 = O(页面类型数) = 2', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(102, 'CK=ext', 'video');
    await installTabRule(201, 'CK=ext', 'pgc');
    await installTabRule(202, 'CK=ext', 'pgc');

    expect(tabRules()).toHaveLength(2);
    const videoRule = tabRules().find((r) => r.condition.urlFilter?.includes('wbi/playurl'));
    const pgcRule = tabRules().find((r) => r.condition.urlFilter?.includes('pgc/player'));
    expect(videoRule?.condition.tabIds).toEqual([101, 102]);
    expect(pgcRule?.condition.tabIds).toEqual([201, 202]);
  });

  it('开 50 个视频页 → 仍然 1 条规则', async () => {
    // 旧实现这里是 50 条，逼近 session 上限 5000 的情形下会先撞满
    for (let i = 1; i <= 50; i += 1) {
      await installTabRule(1000 + i, 'CK=ext', 'video');
    }
    expect(tabRules()).toHaveLength(1);
    expect(tabRules()[0]?.condition.tabIds).toHaveLength(50);
  });
});

describe('合并时不许挤掉同类型的其它标签页', () => {
  it('后到的标签页加入 tabIds，先到的仍在', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(102, 'CK=ext', 'video');

    /**
     * ⚠️ 这一条防的是最容易写出的错误：合并时写成 `tabIds: [tabId]`。
     * 那样 101 会被挤出去，它的取流**在无提示的情况下**回到页面身份，
     * 画质掉了而 popup 一切正常 —— 典型的"能骗过用户的 bug"。
     */
    expect(tabRules()[0]?.condition.tabIds).toContain(101);
    expect(tabRules()[0]?.condition.tabIds).toContain(102);
  });

  it('同一个标签页重复报到 → tabIds 不重复', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(101, 'CK=ext', 'video');

    expect(tabRules()[0]?.condition.tabIds).toEqual([101]);
  });

  it('tabIds 保持升序（便于人工核对诊断输出）', async () => {
    await installTabRule(300, 'CK=ext', 'video');
    await installTabRule(100, 'CK=ext', 'video');
    await installTabRule(200, 'CK=ext', 'video');

    expect(tabRules()[0]?.condition.tabIds).toEqual([100, 200, 300]);
  });
});

describe('幂等：完全一致时不动规则表', () => {
  it('同一 tab 重复报到且什么都没变 → 不调 updateSessionRules', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    const callsAfterFirst = updateCalls;

    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(101, 'CK=ext', 'video');

    /**
     * 反复重建规则是"标签页从后台恢复时卡一下"的直接来源之一
     * —— 每次 update 都会让浏览器规则表重算并触发所有站点重评估。
     */
    expect(updateCalls).toBe(callsAfterFirst);
  });

  it('⚠️ 新标签页带着**相同 Cookie** 报到时，必须仍被加入（幂等判断不能只看 Cookie）', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    const before = updateCalls;

    await installTabRule(102, 'CK=ext', 'video');

    /**
     * 旧实现只比对 Cookie + urlFilter —— 合并之后那样会漏掉一个真实场景：
     * 101 先报到，102 后报到，两者 Cookie 一样、urlFilter 一样，
     * 于是被判定成"完全一致，跳过重建" → **102 永远进不了 tabIds** →
     * 102 的取流不换身份，画质静默回落。
     *
     * 所以幂等判断必须**同时**看"这个 tab 在不在列表里"。
     */
    expect(updateCalls).toBeGreaterThan(before);
    expect(tabRules()[0]?.condition.tabIds).toContain(102);
  });
});

describe('摘除单个标签页 —— 只摘它，不动别的', () => {
  it('3 个 tab 里摘掉 1 个 → 规则还在，只剩另外 2 个', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(102, 'CK=ext', 'video');
    await installTabRule(103, 'CK=ext', 'video');

    await removeTabRule(102);

    expect(tabRules()).toHaveLength(1);
    expect(tabRules()[0]?.condition.tabIds).toEqual([101, 103]);
  });

  it('摘掉最后一个 tab → 整条规则删除（不许留空 tabIds）', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    await removeTabRule(101);

    expect(tabRules()).toHaveLength(0);
  });

  it('⚠️ 摘完不属于任何 tab 的 id → 什么都不做', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    const before = updateCalls;

    await removeTabRule(999);

    // 先查再删：不必触发一次规则表重算
    expect(updateCalls).toBe(before);
    expect(tabRules()[0]?.condition.tabIds).toEqual([101]);
  });

  it('video 与 pgc 并存时，摘 video 的 tab 不许动 pgc 的规则', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    await installTabRule(201, 'CK=ext', 'pgc');

    await removeTabRule(101);

    expect(tabRules()).toHaveLength(1);
    // pgc 的 ID = TAB_RULE_BASE(20000) + kind 下标(`video`=0, `pgc`=1) = 20001
    expect(tabRules()[0]?.id).toBe(20001);
  });
});

describe('规则内容本身', () => {
  it('标签页规则 priority 2 高于全局路径规则的 1', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    // 标签页规则必须压过全局规则，否则局部页面的取流身份会被全局那条盖掉
    expect(tabRules()[0]?.priority).toBe(2);
  });

  it('只代理 GET 的 xmlhttprequest（与白名单的方法边界一致）', async () => {
    await installTabRule(101, 'CK=ext', 'video');
    const c = tabRules()[0]?.condition;
    expect(c?.requestMethods).toEqual(['get']);
    expect(c?.resourceTypes).toEqual(['xmlhttprequest']);
  });

  it('Cookie 头是 set 操作，值为传入的整串', async () => {
    await installTabRule(101, 'SESSDATA=a; bili_jct=b; DedeUserID=1', 'video');
    const h = tabRules()[0]?.action?.requestHeaders?.[0];
    expect(h?.header).toBe('cookie');
    expect(h?.operation).toBe('set');
    expect(h?.value).toBe('SESSDATA=a; bili_jct=b; DedeUserID=1');
  });
});
