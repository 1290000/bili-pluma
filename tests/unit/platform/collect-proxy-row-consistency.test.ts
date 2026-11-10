// @vitest-environment jsdom

/**
 * 诊断第 6 项「播放代理总开关」的 `ok` 口径（2026-11-10）。
 *
 * ## 这个文件守什么
 *
 * `collect.ts` 第 6 项原来把「开关开着但 `ruleCount` 为 0」判成 **不一致状态** 并标红：
 *
 * ```ts
 * const consistent = !proxy.enabled || !ruleCountKnown || proxy.ruleCount > 0;
 * ```
 *
 * 这与 `src/core/ui/popup-state.ts:295-315` **直接矛盾**。用户 2026-10-29 已实测否决：
 *
 * > 「番剧页从别的页面切回来 popup 里面就会显示开关开着但规则没装上，请关闭再开启一次，
 * > 可问题是播放已经成功的被接管了，不用再重新开关一次」
 *
 * 后果是同一个界面里两处说法相反：诊断浮层顶部报红「代理开了但全局规则没装上」，
 * 而画质区同时显示「已接管」。
 *
 * ## 为什么 `ruleCount` 不能参与 `ok` 判定（三条，均已核实）
 *
 * 1. **本实例视角，不是全局视角。** `wxt.config.ts` 是 `incognito: "split"`，
 *    普通/无痕是两个独立 SW 进程；`enabled` 在 `storage.local`（共享），
 *    而 `sessionRules` 是**实例内存**。两者天然可能不同源。
 * 2. **计数口径与生效规则不是一回事。** `ruleCount` 只数 10000 段路径规则，
 *    而番剧页实际生效的是 20000 段标签页规则（随 `page/activate` 异步重建）。
 * 3. **用户已明确否决报警。** 理由见 `popup-state.ts:295-315`。
 *
 * ## 判据
 *
 * | `enabled` | `ruleCount` | 第 6 项 `ok` |
 * | --- | --- | --- |
 * | `true` | `0` | **`true`（不报警）** |
 * | `true` | `3` | `true` |
 * | `true` | `-1`（读不到） | `true`（读不到 ≠ 没生效） |
 * | `false` | 任意 | **`false`（报「代理已关闭」）** |
 *
 * ## 覆盖到 `collectFacts()` 产出的行，而不是只看中间变量
 *
 * 中间变量改了但 `put()` 传错了参数，测试照样绿 —— 所以这里一律走真实
 * `collectFacts()`，从返回的 rows 里找那一行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectFacts, tipFor } from '@platform/diagnostics/collect';

/** 总开关行；`collectFacts()` 无条件 `put()` 它，正常必然存在 */
const PROXY_ROW = '播放代理总开关';

interface ProxyReply {
  enabled: boolean;
  ruleCount: number;
}

/**
 * 装一套最小 chrome。
 *
 * @param proxy  `proxy/status` 的应答内容
 * @param dnr    第 7 项拿到的规则 id；`null` = 读不到（走"不产出行"的中性分支）
 */
function installChrome(proxy: ProxyReply, dnr: { path: number[]; tab: number[] } | null): void {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (m: { type?: string }) => {
        if (m.type === 'proxy/status') {
          return { type: 'proxy/status:ok', hasCredential: true, ...proxy };
        }
        if (m.type === 'diag/facts') {
          return {
            type: 'diag/facts:ok',
            facts: {
              incognitoAllowed: true,
              windows: { total: 1, incognito: 0 },
              cookieStores: ['0'],
              dnrRuleIds: dnr,
            },
          };
        }
        return { type: 'stats/recent:ok', buckets: [] };
      },
      getManifest: () => ({ version: '0.0.0-test', incognito: 'split' }),
    },
    storage: { local: { get: async () => ({}) } },
  });
}

beforeEach(() => {
  installChrome({ enabled: true, ruleCount: 3 }, { path: [10001], tab: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 取总开关那一行 */
async function proxyRow(): Promise<{ label: string; value: string; ok?: boolean }> {
  const rows = await collectFacts({ pageView: null });
  const row = rows.find((r) => r.label === PROXY_ROW);
  expect(row, `没有产出「${PROXY_ROW}」行`).toBeDefined();
  return row as { label: string; value: string; ok?: boolean };
}

describe('★ 第 6 项：`enabled` 是唯一判据，`ruleCount` 只作信息展示', () => {
  it('★★ 核心（修复前红）：enabled=true + ruleCount=0 → ok 必须为 true，不报警', async () => {
    installChrome({ enabled: true, ruleCount: 0 }, { path: [], tab: [] });

    const row = await proxyRow();

    /**
     * 这是本任务的核心断言。
     *
     * 修复前：`consistent = !enabled || !known || ruleCount > 0`
     *   → `false || false || false` = **false** → 标红 → 与 popup 的「已接管」矛盾。
     */
    expect(row.ok, '开关开着时不该因为本实例 0 条规则就标红').toBe(true);
    expect(row.value).not.toContain('不一致');
  });

  it('enabled=true + ruleCount=0 时，文案要说明"本实例视角"，不能让人误读成没生效', async () => {
    installChrome({ enabled: true, ruleCount: 0 }, { path: [], tab: [] });
    const row = await proxyRow();

    // 数值仍然如实展示（它是诊断信息），只是不再决定颜色
    expect(row.value).toContain('0');
    expect(row.value).toContain('本实例');
  });

  it('enabled=true + ruleCount=3（基线）→ ok:true，且不出现"本实例"多余的警告感', async () => {
    installChrome({ enabled: true, ruleCount: 3 }, { path: [10001], tab: [] });
    const row = await proxyRow();

    expect(row.ok).toBe(true);
    expect(row.value).toContain('3');
    expect(row.value).not.toContain('不一致');
  });

  it('enabled=true + ruleCount=-1（读不到）→ ok:true —— 读不到不等于没生效', async () => {
    installChrome({ enabled: true, ruleCount: -1 }, null);
    const row = await proxyRow();

    expect(row.ok).toBe(true);
    expect(row.value).toContain('读不到');
    expect(row.value).not.toContain('不一致');
  });

  it('★ 反向：enabled=false → ok 必须为 false（关着是状态，但要能被 tipFor 识别）', async () => {
    installChrome({ enabled: false, ruleCount: 0 }, { path: [], tab: [] });
    const row = await proxyRow();

    expect(row.ok).toBe(false);
    expect(row.value).toBe('已关闭');
  });

  it('反向：enabled=false 但 ruleCount 有值（关的那一刻残留）→ 仍然是 ok:false', async () => {
    installChrome({ enabled: false, ruleCount: 3 }, { path: [10001], tab: [] });
    const row = await proxyRow();

    expect(row.ok).toBe(false);
    expect(row.value).toBe('已关闭');
  });
});

describe('★ 与 popup-state 口径一致：同一个状态，两处不能说反话', () => {
  it('★ enabled=true + ruleCount=0：诊断说不报警，且 tipFor 给的是正常结论', async () => {
    installChrome({ enabled: true, ruleCount: 0 }, { path: [10001], tab: [] });

    const rows = await collectFacts({ pageView: null });
    const row = rows.find((r) => r.label === PROXY_ROW);

    expect(row?.ok).toBe(true);
    /**
     * `tipFor()` 不能在总开关这一项上报"已关闭"——
     * 那正是 popup 显示「已接管」时诊断页说"关着"的那种自相矛盾。
     */
    expect(tipFor(rows)).not.toContain('代理已关闭');
  });
});

describe('★ tipFor() 三态行为未被本次改动改变', () => {
  it('enabled=false → 报「代理已关闭」（走 ok===false 分支）', async () => {
    installChrome({ enabled: false, ruleCount: 0 }, { path: [], tab: [] });
    const rows = await collectFacts({ pageView: null });
    expect(tipFor(rows)).toContain('代理已关闭');
  });

  it('第 7 项的行不存在（dnrRuleIds=null）→ 中性「状态未知」，且不含"没装上"', async () => {
    installChrome({ enabled: true, ruleCount: 3 }, null);
    const rows = await collectFacts({ pageView: null });

    // 前提：第 7 项确实没产出行
    expect(rows.find((r) => r.label === 'DNR 全局路径规则')).toBeUndefined();

    const tip = tipFor(rows);
    expect(tip).toContain('未知');
    /**
     * ⚠️ 中性文案里**不许出现"没装上"** —— 这条断言与
     * `collect.ts` 的 `:547-553` 注释同源，删掉它会立刻抓到回归。
     */
    expect(tip).not.toContain('没装上');
  });

  it('enabled=true + ruleCount=0 且第 7 项读不到 → 既不说"已关闭"也不说"没装上"', async () => {
    installChrome({ enabled: true, ruleCount: 0 }, null);
    const rows = await collectFacts({ pageView: null });
    const tip = tipFor(rows);

    expect(tip).not.toContain('代理已关闭');
    expect(tip).not.toContain('没装上');
  });
});
