// @vitest-environment node

/**
 * 退出取流账号：**保留总开关状态，但必须清干净规则**（2026-11-12，task-10）。
 *
 * ## 用户裁决（原话）
 *
 * > 「可以保留这个开关原本的状态，但是因为退出了扩展账号所以这个开关
 * > 即便是开着也是没有用了，所以整个开关应变为灰色不可点击」
 *
 * ## 两件事，缺一不可
 *
 * | # | 要求 | 做错了会怎样 |
 * | --- | --- | --- |
 * | 1 | **不改 `ENABLED_KEY`** | 退出一次账号，用户的开关设置被永久改掉 |
 * | 2 | **三类规则全清空** | **安全事故**：带着已删除账号的 Cookie 继续发请求 |
 *
 * 第 2 条是本文件的核心 —— 它比第 1 条重要得多。
 *
 * ## ⚠️ 为什么必须显式测"推荐流那一段（11000）"
 *
 * `removeAllPathRules()` **只删 10000 段**（`dnr.ts` 的过滤器是
 * `id >= PATH_RULE_BASE && id < PATH_RULE_BASE + PATH_RULE_SPAN`），
 * 推荐流规则在 **11000 段**，两者"互不清除"（`dnr.ts` 的注释原话）。
 *
 * 所以"清了路径规则"**不等于**"清干净了"。只清路径 → 退出账号后
 * 推荐流那条规则会带着已删除账号的 Cookie 继续对 `feed/rcmd` 发请求。
 *
 * ## 反向验证
 *
 * 把 handler 改回 `await disableProxy()` → 第 1 条必红（开关被写成 false）。
 * 把 `clearAllRules()` 里删掉任意一行 → 对应的"该段清零"断言必红。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /**
   * 模拟 `chrome.storage.local` 的持久层。
   *
   * 关键：**它跨调用保留** —— 因为本卡要断言的正是"退出账号**没有**改写它"。
   * 每次用例前重置。
   */
  store: {} as Record<string, unknown>,
  /** 模拟 session 规则表：id → 规则 */
  rules: new Map<number, { id: number; priority?: number }>(),
  removeCredential: vi.fn(async () => undefined),
  clearHealth: vi.fn(async () => undefined),
  clearStats: vi.fn(async () => undefined),
  clearPrimaryProfile: vi.fn(async () => undefined),
  clearCachedSummary: vi.fn(async () => undefined),
}));

/**
 * 只 mock 存储层与"外部副作用"，**不 mock `dnr.ts`** ——
 * 本卡要验的正是 `dnr.ts` 里那个新函数 `clearAllRules()` 真的清了三段规则。
 *
 * `chrome.declarativeNetRequest.updateSessionRules` 用内存规则表模拟：
 * `/q2` 那套真机验证脚本测的是浏览器行为，这里是逻辑层。
 */
vi.mock('@platform/storage/credential-store', () => ({
  removeCredential: () => mocks.removeCredential(),
  readPersistedCredential: async () => null,
}));
vi.mock('@platform/storage/health-store', () => ({ clearHealth: () => mocks.clearHealth() }));
vi.mock('@platform/storage/stats-store', () => ({ clearStats: () => mocks.clearStats() }));
vi.mock('@platform/storage/primary-profile-store', () => ({
  clearPrimaryProfile: () => mocks.clearPrimaryProfile(),
}));
vi.mock('../../../src/background/handlers/account.handler', () => ({
  clearCachedSummary: () => mocks.clearCachedSummary(),
}));

/**
 * ⚠️ 只替换 `chrome.storage.local` 与 `declarativeNetRequest` 两个面，
 * `dnr.ts` 的**真实实现**照常加载（`removeAllPathRules` 等私有函数由它自己用）。
 */
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (k in mocks.store) out[k] = mocks.store[k];
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        Object.assign(mocks.store, obj);
      },
    },
  },
  declarativeNetRequest: {
    getSessionRules: async () => [...mocks.rules.values()],
    updateSessionRules: async (arg: { addRules?: { id: number }[]; removeRuleIds?: number[] }) => {
      for (const id of arg.removeRuleIds ?? []) mocks.rules.delete(id);
      for (const r of arg.addRules ?? []) mocks.rules.set(r.id, r);
    },
    updateDynamicRules: async () => undefined,
    getDynamicRules: async () => [],
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
});

const { handleAccountRemove } =
  await import('../../../src/background/handlers/account-remove.handler');

/** 规则 ID 段（与 `dnr.ts` 一致；这里写常量是为了**不 import 私有常量**） */
const PATH_BASE = 10_000;
const FEED_ID = 11_000;
const TAB_BASE = 20_000;

/** 造一份"正在代理中"的规则表：路径 / 推荐流 / 标签页各一条 */
function seedRules(): void {
  mocks.rules.clear();
  mocks.rules.set(PATH_BASE + 0, { id: PATH_BASE + 0, priority: 1 });
  mocks.rules.set(PATH_BASE + 1, { id: PATH_BASE + 1, priority: 1 });
  mocks.rules.set(FEED_ID, { id: FEED_ID, priority: 1 });
  mocks.rules.set(TAB_BASE + 0, { id: TAB_BASE + 0, priority: 2 });
}

function ruleIdsIn(base: number, span = 1000): number[] {
  return [...mocks.rules.keys()].filter((id) => id >= base && id < base + span);
}

beforeEach(() => {
  mocks.store = {};
  mocks.removeCredential.mockClear();
  mocks.clearHealth.mockClear();
  mocks.clearStats.mockClear();
  mocks.clearPrimaryProfile.mockClear();
  mocks.clearCachedSummary.mockClear();
  seedRules();
});

describe('★★★ 退出账号**不改**总开关的持久值（task-10 第 1 条）', () => {
  it('★★★ 开关原本是 true → 退出后仍然是 true', async () => {
    /**
     * 这是用户裁决的核心：「保留这个开关原本的状态」。
     *
     * 反例：把 handler 改回 `await disableProxy()` → `dnr.ts` 会
     * `storage.local.set({pluma:proxy-enabled: false})` → 本条必红。
     */
    mocks.store['pluma:proxy-enabled'] = true;

    const res = await handleAccountRemove();

    expect(res.type).toBe('account/remove:ok');
    expect(mocks.store['pluma:proxy-enabled'], '退出账号把用户的开关设置改掉了').toBe(true);
  });

  it('★★ 开关原本是 false → 退出后仍然是 false（不是被"为了保险"写成别的）', async () => {
    mocks.store['pluma:proxy-enabled'] = false;

    await handleAccountRemove();

    expect(mocks.store['pluma:proxy-enabled']).toBe(false);
  });

  it('★★ 开关键**根本没有被写过**（不只是值恰好相同）', async () => {
    /**
     * 更强的判据：若实现照旧调 `disableProxy()`，即使原值就是 `false`，
     * "值"断言也会绿 —— 所以这里额外断言**没有发生写操作**。
     *
     * 做法：把原值设成一个"如果被写就一定会变"的对象哨兵。
     */
    const sentinel = { untouched: true };
    mocks.store['pluma:proxy-enabled'] = sentinel;

    await handleAccountRemove();

    expect(mocks.store['pluma:proxy-enabled'], '有人把开关键重写了（值没变，但写动作发生了）').toBe(
      sentinel,
    );
  });
});

describe('★★★ 退出账号必须清干净三类规则（安全底线，不许省）', () => {
  it('★★★ 全局路径规则清零（10000 段）', async () => {
    expect(ruleIdsIn(PATH_BASE), '构造前提：应该有路径规则').not.toHaveLength(0);

    await handleAccountRemove();

    expect(ruleIdsIn(PATH_BASE), '路径规则没清 —— 带着已删凭据继续注入').toHaveLength(0);
  });

  it('★★★ 推荐的规则清零（11000 段）—— `removeAllPathRules()` 覆盖不到它', async () => {
    /**
     * ## 这条是本卡最容易漏的一条
     *
     * `removeAllPathRules()` 的过滤器是 `id >= 10000 && id < 11000`，
     * **碰不到 11000 段**。只调它 = 推荐流规则带着已删除账号的 Cookie 继续发请求。
     *
     * 反例：把 `clearAllRules()` 里的 `removeFeedAccountRule()` 删掉 → 本条必红。
     */
    expect(mocks.rules.has(FEED_ID), '构造前提：应该有推荐流规则').toBe(true);

    await handleAccountRemove();

    expect(
      mocks.rules.has(FEED_ID),
      '推荐流规则没清 —— 它带着已删除账号的 Cookie 继续对 feed/rcmd 发请求',
    ).toBe(false);
  });

  it('★★★ 标签页规则清零（20000 段）', async () => {
    expect(ruleIdsIn(TAB_BASE), '构造前提：应该有标签页规则').not.toHaveLength(0);

    await handleAccountRemove();

    expect(ruleIdsIn(TAB_BASE), '标签页规则没清 —— 刷新后画质仍不回落').toHaveLength(0);
  });

  it('★★★ 三类规则**全部**为空（一条断言看住整体）', async () => {
    /**
     * 把三段合起来断言，是因为**任何一段残留效果都一样**：
     * 带着已删除账号的 Cookie 继续发请求。
     * 分开写会让人以为"我只改了这一处，另外两处没动所以没问题"。
     */
    await handleAccountRemove();

    expect({
      路径: ruleIdsIn(PATH_BASE).length,
      推荐流: ruleIdsIn(11_000).length,
      标签页: ruleIdsIn(TAB_BASE).length,
    }).toEqual({ 路径: 0, 推荐流: 0, 标签页: 0 });
  });

  it('★★ 清规则发生在**删凭据之前**（避免"规则在、凭据没了"的可用中间态）', async () => {
    const order: string[] = [];
    mocks.removeCredential.mockImplementation(async () => {
      // 记录删凭据那一刻规则表的状态：必须已经是空的
      order.push(`rulesAtCredentialRemoval=${mocks.rules.size}`);
    });

    await handleAccountRemove();

    expect(order[0], '删凭据时规则还在 —— 那是"规则带着死凭据"的可用态').toBe(
      'rulesAtCredentialRemoval=0',
    );
  });
});

describe('★ 其余清理照旧（不回归）', () => {
  it('★ 凭据 / 健康 / 统计 / 摘要 / 主账号档案 都清了', async () => {
    await handleAccountRemove();

    expect(mocks.removeCredential).toHaveBeenCalledTimes(1);
    expect(mocks.clearHealth).toHaveBeenCalledTimes(1);
    expect(mocks.clearStats).toHaveBeenCalledTimes(1);
    expect(mocks.clearCachedSummary).toHaveBeenCalledTimes(1);
    expect(mocks.clearPrimaryProfile).toHaveBeenCalledTimes(1);
  });

  it('★ 成功时返回 `account/remove:ok`', async () => {
    const res = await handleAccountRemove();
    expect(res.type).toBe('account/remove:ok');
  });

  it('★ 某一步失败 → 返回 `account/remove:err` 且带 detail', async () => {
    mocks.clearStats.mockRejectedValueOnce(new Error('统计清不掉'));

    const res = await handleAccountRemove();

    expect(res.type).toBe('account/remove:err');
    expect(res.type === 'account/remove:err' ? res.detail : '').toContain('统计清不掉');
  });
});
