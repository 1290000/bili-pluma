/**
 * DNR 路径规则清理：白名单增删后不得残留旧规则（O1，2026-10-30）
 *
 * ## 这个测试守的是什么
 *
 * `enableProxy()` 原先的 `removeRuleIds` 只覆盖**当前白名单算出的 ID**：
 *
 * ```ts
 * removeRuleIds: addRules.map((r) => r.id)
 * ```
 *
 * **插入**路径时没问题（新旧 ID 集合互相覆盖）。但**删掉白名单中间一项**时，
 * 旧的后位 ID 不在新集合里，于是残留一条**带着上一次 Cookie** 的规则。
 *
 * 若用户在此期间换过播放账号，残留规则会继续带**旧账号凭据**发请求 ——
 * 画质静默异常而 popup 上一切正常，属于「能骗过用户的 bug」。
 *
 * 2026-10-30 修法：add 之前先 `removeAllPathRules()`（扫出整段再删），
 * 而不是只删当前算出的那几个 ID。
 *
 * ## 为什么用 chrome 桩测
 *
 * `dnr.ts` 的行为（规则装没装、并发串号）只能在真实浏览器验（`poc/verify/`）。
 * 但「删了哪些 ID、留了什么」是**纯记账**，用桩就能精确观察 ——
 * 见 `tests/unit/platform/http/dnr-rule-id.test.ts` 的同一手法。
 *
 * ⚠️ 桩里的 `updateSessionRules` 按「先删后加、同 ID 覆盖」语义实现。
 * 真实 Chrome 是否严格原子：**本测试不假设**，它只断言"最终留下的规则集合"。
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { enableProxy, disableProxy } from '@platform/http/dnr';
import { ENABLED_ROUTE_PATHS } from '@shared/constants/routes';

interface CapturedRule {
  id: number;
  priority: number;
  condition: { urlFilter?: string; requestDomains?: string[] };
  action: { requestHeaders?: Array<{ header: string; value: string }> };
}

interface Stub {
  rules: CapturedRule[];
}

function installChromeStub(): Stub {
  const stub: Stub = { rules: [] };
  const store: Record<string, unknown> = {};

  (globalThis as unknown as { chrome: unknown }).chrome = {
    declarativeNetRequest: {
      updateSessionRules: async (opts: {
        removeRuleIds?: number[];
        addRules?: CapturedRule[];
      }): Promise<void> => {
        for (const id of opts.removeRuleIds ?? []) {
          const at = stub.rules.findIndex((r) => r.id === id);
          if (at >= 0) stub.rules.splice(at, 1);
        }
        for (const r of opts.addRules ?? []) {
          const at = stub.rules.findIndex((x) => x.id === r.id);
          if (at >= 0) stub.rules.splice(at, 1);
          stub.rules.push(r);
        }
      },
      getSessionRules: async (): Promise<CapturedRule[]> => [...stub.rules],
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

  return stub;
}

function cookieOf(r: CapturedRule): string {
  const h = r.action.requestHeaders?.find((x) => x.header.toLowerCase() === 'cookie');
  return h ? h.value : '';
}

const OLD = 'SESSDATA=OLD; bili_jct=old; DedeUserID=1';
const NEW = 'SESSDATA=NEW; bili_jct=new; DedeUserID=1';

let stub: Stub;
beforeEach(() => {
  stub = installChromeStub();
});

describe('DNR 路径规则清理（O1）', () => {
  describe('基线：正常重装', () => {
    it('同样 3 条路径、只换 Cookie → 全部变成新 Cookie，无残留', async () => {
      await enableProxy(OLD);
      expect(stub.rules).toHaveLength(ENABLED_ROUTE_PATHS.length);
      expect(stub.rules.every((r) => cookieOf(r).includes('OLD'))).toBe(true);

      await enableProxy(NEW);
      expect(stub.rules).toHaveLength(ENABLED_ROUTE_PATHS.length);
      expect(stub.rules.every((r) => cookieOf(r).includes('NEW'))).toBe(true);
      expect(stub.rules.some((r) => cookieOf(r).includes('OLD'))).toBe(false);
    });
  });

  describe('核心：白名单缩短时不得残留（O1 的原始缺陷）', () => {
    it('删掉中间一项后，旧的后位 ID 不残留', async () => {
      await enableProxy(OLD);
      // 白名单 3 条 → 产生 ID 10000/10001/10002
      expect(stub.rules.map((r) => r.id).sort((a, b) => a - b)).toEqual([10000, 10001, 10002]);

      // 模拟"删掉中间那条"，用缩短后的白名单重装（换新 Cookie）
      const shortened = ENABLED_ROUTE_PATHS.filter((_, i) => i !== 1);
      await enableProxy(NEW, shortened);

      // 修复前：ID 10001（原属被删路径）残留，且仍带 OLD Cookie
      const stale = stub.rules.filter((r) => cookieOf(r).includes('OLD'));
      expect(stale, `残留规则: ${JSON.stringify(stale.map((r) => r.id))}`).toHaveLength(0);
      expect(stub.rules).toHaveLength(shortened.length);
    });

    it('缩短后规则 ID 重新从 10000 起分配（不再有旧高位 ID 遗留）', async () => {
      await enableProxy(OLD);
      await enableProxy(NEW, ENABLED_ROUTE_PATHS.slice(0, 2));

      const ids = stub.rules.map((r) => r.id).sort((a, b) => a - b);
      expect(ids).toEqual([10000, 10001]);
    });

    it('白名单只剩 1 条时，其余 2 条不残留', async () => {
      await enableProxy(OLD);
      await enableProxy(NEW, ENABLED_ROUTE_PATHS.slice(0, 1));

      expect(stub.rules).toHaveLength(1);
      expect(stub.rules[0]?.id).toBe(10000);
      expect(cookieOf(stub.rules[0]!)).toContain('NEW');
    });
  });

  describe('关开关后重开，不残留', () => {
    it('disable → enable 只剩当前白名单的规则', async () => {
      await enableProxy(OLD);
      await disableProxy();
      expect(stub.rules).toHaveLength(0);

      await enableProxy(NEW);
      expect(stub.rules).toHaveLength(ENABLED_ROUTE_PATHS.length);
      expect(stub.rules.every((r) => cookieOf(r).includes('NEW'))).toBe(true);
    });
  });

  describe('标签页规则不受影响', () => {
    it('路径规则清理不碰 20000 段', async () => {
      // 手动塞一条标签页规则
      stub.rules.push({
        id: 20001,
        priority: 2,
        condition: { urlFilter: '/x/player/playurl' },
        action: { requestHeaders: [] },
      } as CapturedRule);

      await enableProxy(NEW);

      const tabRules = stub.rules.filter((r) => r.id >= 20000 && r.id < 21000);
      expect(tabRules).toHaveLength(1);
      expect(tabRules[0]?.id).toBe(20001);
    });
  });
});
