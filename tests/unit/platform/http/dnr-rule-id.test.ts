/**
 * DNR 路径规则 ID 的分配（B-05）。
 *
 * ## 为什么这个测试值得存在（而 dnr.ts 整体「无法用 Vitest 测」）
 *
 * `docs/04-project-structure.md` §4 与 AGENTS.md §5.4 都说 `dnr.ts` **无法用 Vitest 测**——
 * 那说的是**行为**（规则装没装、并发会不会串号），那些只能在真实浏览器里验
 * （`poc/verify/run-q2-auto.cjs`）。
 *
 * 但「ID 怎么算」是**纯函数**，不碰任何 `chrome.*`。而它恰好是最容易静默出错、
 * 也最值得钉住的一小块：
 *
 *   - 哈希实现下，两条路径算出同一个 ID → `updateSessionRules` 后一条顶掉前一条
 *   - 少了一条 playurl 规则 → 那条路径画质静默回落，popup 上一切正常
 *   - 属于「能骗过用户的 bug」（`docs/plans/1.0.0-release-plan.md` §6.2 判据 1）
 *
 * 2026-10-29 改为止式分配（`ENABLED_ROUTE_PATHS` 下标 + `PATH_RULE_BASE`）。
 *
 * ## 怎么测到私有函数
 *
 * `ruleIdForPath()` 没有导出，而且**不应该**为了测试而导出（它不该成为公开 API）。
 * 这里用 `chrome.declarativeNetRequest` 的最小桩 + 调公开的 `enableProxy()`，
 * 从**真正提交给浏览器的规则 ID**上观察结果 —— 测的是"实际会装成什么"，
 * 比测内部函数更接近用户看到的东西。
 *
 * 详见文件末尾 `describe('反例场景：白名单扩容')` —— 那一组复现了旧哈希实现的碰撞。
 */

import { describe, expect, it } from 'vitest';

import { enableProxy } from '@platform/http/dnr';
import { ENABLED_ROUTE_PATHS } from '@shared/constants/routes';

/** 与 `dnr.ts` 内部常量同值（路径规则区段的起点） */
const PATH_RULE_BASE = 10000;

/**
 * 记录 `updateSessionRules` 收到的规则，其余 DNR/存储 API 给最小可用桩。
 *
 * 只实现被测路径会碰到的部分：`updateSessionRules` + `storage.local.set`。
 * 多实现的部分会让"其实调了别的 API"这类问题被掩盖。
 */
interface CapturedRule {
  id: number;
  priority: number;
  condition: { urlFilter?: string; requestDomains?: string[] };
  action: { requestHeaders?: Array<{ header: string; value: string }> };
}

function installChromeStub(): { rules: CapturedRule[]; readd: () => Promise<CapturedRule[]> } {
  /** @type {CapturedRule[]} */
  const rules: CapturedRule[] = [];

  const store: Record<string, unknown> = {};

  (globalThis as unknown as { chrome: unknown }).chrome = {
    declarativeNetRequest: {
      updateSessionRules: async (opts: {
        removeRuleIds?: number[];
        addRules?: CapturedRule[];
      }): Promise<void> => {
        // 按 DNR 的真实语义处理：先删后加，同 ID 视为覆盖
        for (const id of opts.removeRuleIds ?? []) {
          const at = rules.findIndex((r) => r.id === id);
          if (at >= 0) rules.splice(at, 1);
        }
        for (const r of opts.addRules ?? []) {
          const at = rules.findIndex((x) => x.id === r.id);
          if (at >= 0) rules.splice(at, 1);
          rules.push(r);
        }
      },
      /**
       * 2026-10-30 加（O1）：`enableProxy()` 现在会先 `removeAllPathRules()` 清整个 ID 段，
       * 而那一步要读 `getSessionRules()`。桩当初只实现了 `updateSessionRules`，
       * 于是修复后这里报 `getSessionRules is not a function`。
       *
       * ⚠️ 这**不是**为了"让测试变绿"而补桩，而是被测代码确实多了这个依赖 ——
       * 桩必须跟上真实 API 的使用面，否则测试测的是"一个不存在的最小实现"。
       */
      getSessionRules: async (): Promise<CapturedRule[]> => [...rules],
    },
    storage: {
      local: {
        set: async (bag: Record<string, unknown>): Promise<void> => {
          Object.assign(store, bag);
        },
        get: async (key: string): Promise<Record<string, unknown>> => ({ [key]: store[key] }),
      },
    },
  };

  return { rules, readd: async () => rules };
}

const COOKIE = 'SESSDATA=fake; bili_jct=fake; DedeUserID=1000002';

describe('DNR 路径规则 ID —— 止式分配（B-05）', () => {
  it('白名单 3 条 → ID 是 10000 / 10001 / 10002（下标 + BASE）', async () => {
    const { rules } = installChromeStub();
    await enableProxy(COOKIE);

    // 白名单当前就是 3 条（`/x/player/wbi/playurl`、`/x/player/playurl`、`/pgc/player/web/playurl`）
    expect(ENABLED_ROUTE_PATHS.length).toBe(3);
    expect(rules.map((r) => r.id).sort((a, b) => a - b)).toEqual([10000, 10001, 10002]);
  });

  it('ID 与白名单下标一一对应（不是碰巧算对）', async () => {
    const { rules } = installChromeStub();
    await enableProxy(COOKIE);

    for (const [index, path] of ENABLED_ROUTE_PATHS.entries()) {
      const rule = rules.find((r) => r.condition.urlFilter === path);
      expect(rule, `找不到 ${path} 的规则`).toBeDefined();
      expect(rule?.id).toBe(PATH_RULE_BASE + index);
    }
  });

  it('每条白名单路径各一条规则，ID 唯一（无碰撞）', async () => {
    const { rules } = installChromeStub();
    await enableProxy(COOKIE);

    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(ENABLED_ROUTE_PATHS.length);
  });

  it('所有 ID 落在 10000 段的 1000 槽内（不与 20000 段标签页规则撞车）', async () => {
    const { rules } = installChromeStub();
    await enableProxy(COOKIE);

    for (const r of rules) {
      expect(r.id).toBeGreaterThanOrEqual(PATH_RULE_BASE);
      expect(r.id).toBeLessThan(PATH_RULE_BASE + 1000);
    }
  });

  it('不在白名单里的路径被丢弃（不产生 ID 为 -1 的规则）', async () => {
    const { rules } = installChromeStub();
    // 显式传一个从未被授权的路径：`isProxyPath()` 放行前缀匹配，`indexOf()` 找不到
    await enableProxy(COOKIE, [...ENABLED_ROUTE_PATHS, '/x/player/playurl/']);

    expect(rules.every((r) => r.id >= PATH_RULE_BASE)).toBe(true);
    expect(rules.some((r) => r.condition.urlFilter === '/x/player/playurl/')).toBe(false);
  });
});

describe('反例场景：旧哈希实现会碰撞（B-05 的原始缺陷）', () => {
  /**
   * 把旧实现照抄一份（`h = (h * 31 + charCode) % 1000`），用来证明两件事：
   *
   *   1. 现在这 3 条**不碰撞** —— 所以旧实现能一直活着，从来没人发现
   *   2. 换一对路径立刻碰撞 —— 而碰撞的后果是**静默覆盖**，不报错
   *
   * ⚠️ 第一版这里写的是"扩到 40 条假路径必然碰撞"，**实测是错的**：
   * 40 条 `/x/player/variant-N/playurl` 在旧哈希下仍然 0 碰撞（我实际跑过）。
   * 那个断言只是"猜生日问题"，不是证据。现在改用**已实测到的最小碰撞对**
   * `/x/90` 与 `/x/209`（都落到槽 389）—— 确定的、可复现的。
   *
   * 顺带说明为什么"估算 40 条 55% 碰撞"这句话别当成已验证的结论：
   * 它只在路径**随机均匀**时成立，而真实白名单是同一前缀下的一批固定串，
   * 散列分布完全取决于那几个字符。这正是"能实测就不要推理"的场景。
   */
  function legacyRuleId(path: string): number {
    let h = 0;
    for (let i = 0; i < path.length; i += 1) h = (h * 31 + path.charCodeAt(i)) % 1000;
    return PATH_RULE_BASE + h;
  }

  it('当前 3 条在旧哈希下不碰撞（所以旧实现在这段时间"看着没问题"）', () => {
    const ids = ENABLED_ROUTE_PATHS.map(legacyRuleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('旧哈希的实测碰撞对 `/x/90` 与 `/x/209` 同槽 389（新实现不会）', () => {
    expect(legacyRuleId('/x/90')).toBe(PATH_RULE_BASE + 389);
    expect(legacyRuleId('/x/209')).toBe(PATH_RULE_BASE + 389);

    const expanded = [...ENABLED_ROUTE_PATHS, '/x/90', '/x/209'];
    const legacyIds = expanded.map(legacyRuleId);
    expect(legacyIds.length - new Set(legacyIds).size).toBe(1);

    // 止式分配：下标即偏移，天然唯一
    const newIds = expanded.map((_, i) => PATH_RULE_BASE + i);
    expect(new Set(newIds).size).toBe(newIds.length);
  });
});
