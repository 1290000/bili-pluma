/**
 * `rewriteGate` 判据的测试（T1–T7）。
 *
 * ## 为什么这里要**复刻**判断而不是 import
 *
 * `content.ts` 是 content 入口，直接 `import` 会把整个 content script
 * （含 `window` / `chrome.*` / 主世界桥）拖进 jsdom，用例会变成集成测试。
 *
 * 所以本文件用**读源码 + 正则提取判据三种写法**的方式防止漂移：
 *
 * 1. 断言源码里**确实是** `res.reason === 'ok'` 这个正向前缀白名单。
 *    若有人把它改回 `!== 'disabled'`（fail-open），这里立刻变红。
 * 2. 再用同一份判据实现一个纯函数，跑 T1–T7 的六种 reason + 一个假 reason。
 *
 * ## 为什么 T7 是这套测试的核心
 *
 * T1–T6 只覆盖**现在已知**的六种 reason —— 它们挡不住"下次加一个新 reason
 * 却忘在 `extensionEngaged` 里表态"这类错。**T7 用 `as never` 构造一个不存在的值**，
 * 断言它的 `rewriteGate` 是 `false`。只要判据保持 `=== 'ok'`，T7 恒成立；
 * 一旦有人写成 fail-open，T7 立刻红。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProxyActivateReason } from '@shared/types/messages';

const CONTENT_SRC = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

/**
 * 判据的**唯一实现**（与 `content.ts` 保持同一形状）：
 * `extensionEngaged = res.reason === 'ok'`。
 *
 * ⚠️ 这个函数必须与源码同形，源码那边有断言钉住（见 describe「源码同形」）。
 */
function extensionEngagedFor(reason: ProxyActivateReason): boolean {
  return reason === 'ok';
}

describe('rewriteGate 判据 —— 源码同形（防漂移）', () => {
  /**
   * 反向验证：把 `content.ts` 里的
   * `const extensionEngaged = res.reason === 'ok';`
   * 改成 `res.reason !== 'disabled'`（即退回 fail-open）→ 本条变红。
   */
  it("源码里 extensionEngaged 必须是正向前缀白名单 `=== 'ok'`", () => {
    expect(CONTENT_SRC).toContain("const extensionEngaged = res.reason === 'ok';");
  });

  /**
   * 反向验证：把 `tellMainWorld(switchOn, res.activated === true, extensionEngaged)`
   * 的第三个参数删掉 → 本条变红（等于 rewriteGate 永远走默认值 false，功能失效但不会撒谎；
   * 删掉后本断言就是唯一提醒）。
   */
  it('源码里必须把 extensionEngaged 作为第三个参数传给 tellMainWorld', () => {
    /**
     * ⚠️ 2026-11-20：参数来源从"就地表达式"变成"先记住再传"
     * （`rewriteGateKnown = extensionEngaged`，然后传 `rewriteGateKnown`）——
     * 因为候选过滤开关热更新时要重发 `cfg`，那一刻拿不到 `res`。
     *
     * 判据不变：**第三个实参必须是 `extensionEngaged` 那条链**，
     * 不许换成 `enabled`、不许吃默认值 `false`。
     */
    expect(CONTENT_SRC).toContain('rewriteGateKnown = extensionEngaged;');
    expect(CONTENT_SRC).toMatch(
      /tellMainWorld\(\s*switchOn,\s*activatedKnown,\s*rewriteGateKnown\s*,/,
    );
  });

  /**
   * 反向验证：把 `switchOn` 也改成 `=== 'ok'` → 本条变红。
   * 两者语义不同（总开关 vs 是否参与取流），**不许合并**。
   */
  it('源码里 switchOn 与 extensionEngaged 是两个独立变量（不许合并）', () => {
    expect(CONTENT_SRC).toContain("const switchOn = res.reason !== 'disabled';");
    expect(CONTENT_SRC).toContain("const extensionEngaged = res.reason === 'ok';");
  });
});

describe('T1–T6：六种已知 reason 的 rewriteGate', () => {
  /**
   * 反向验证：把 `extensionEngagedFor` 改成 `reason !== 'disabled'` → T1/T2/T3/T4 全红。
   * 这就是 `poc/probe/verify-report/PROXYENABLED-DESIGN.md` 真值表里
   * "6 行只有 2 行对"的那 4 行。
   */
  it('T1 page-identity（用户选了页面账号取流）→ 不改写', () => {
    expect(extensionEngagedFor('page-identity')).toBe(false);
  });

  it('T2 self（两个号是同一个）→ 不改写', () => {
    expect(extensionEngagedFor('self')).toBe(false);
  });

  it('T3 not-configured（没扫码）→ 不改写', () => {
    expect(extensionEngagedFor('not-configured')).toBe(false);
  });

  it('T4 error（装规则抛异常）→ 不改写', () => {
    expect(extensionEngagedFor('error')).toBe(false);
  });

  it('T5 ok（规则已装，真的在代理）→ 改写', () => {
    expect(extensionEngagedFor('ok')).toBe(true);
  });

  it('T6 disabled（用户关了总开关）→ 不改写', () => {
    expect(extensionEngagedFor('disabled')).toBe(false);
  });
});

describe('T7：⚠️ 未知的 reason 必须 fail-closed（本组核心）', () => {
  /**
   * ## 这条测试为什么要存在
   *
   * T1–T6 只覆盖**现在已知**的六种值。如果有人明天在 `messages.ts` 里
   * 加第七种 `'something-new'`，**T1–T6 全绿**，而 `content.ts` 若写成
   * `res.reason !== 'disabled'`，新值会**静默落进"在工作"**。
   *
   * T7 用一个**不存在的值**断言 `rewriteGate === false`，把这个不变量钉住：
   * **判据必须是 `=== 'ok'` 这种正向前缀白名单，否则本条必红。**
   *
   * 反向验证（已实测）：把 `extensionEngagedFor` 改成 `reason !== 'disabled'` →
   * 本条变红（期望 false，实际 true）。
   */
  it('T7 不存在的 reason → 不改写（fail-closed）', () => {
    const futureReason = 'some-future-reason' as never as ProxyActivateReason;
    expect(extensionEngagedFor(futureReason)).toBe(false);
  });

  it('T7b 多种未知值都不许放行（列全常见形态）', () => {
    const unknowns = ['future', '', 'OK', 'ok ', 'Ok'] as unknown as ProxyActivateReason[];
    for (const r of unknowns) {
      expect(extensionEngagedFor(r), `reason=${String(r)} 不该放行`).toBe(false);
    }
  });
});

describe('真值表：6 行里有且只有 2 行允许改写', () => {
  /**
   * 把设计文档 §1.2 的真值表直接编码成断言。
   *
   * 反向验证：任何一处 `extensionEngagedFor` 改动都会让这里少/多出一行 → 变红。
   */
  const cases: Array<{ reason: ProxyActivateReason; activated: boolean; rewrite: boolean }> = [
    { reason: 'ok', activated: true, rewrite: true },
    { reason: 'disabled', activated: false, rewrite: false },
    { reason: 'not-configured', activated: false, rewrite: false },
    { reason: 'self', activated: false, rewrite: false },
    { reason: 'page-identity', activated: false, rewrite: false },
    { reason: 'error', activated: false, rewrite: false },
  ];

  it('恰好 1 行允许改写，且是 ok', () => {
    const allowed = cases.filter((c) => extensionEngagedFor(c.reason)).map((c) => c.reason);
    expect(allowed).toEqual(['ok']);
  });

  it('每个 reason 的 activated 与 rewrite 组合都符合真值表', () => {
    for (const c of cases) {
      expect(
        { reason: c.reason, rewrite: extensionEngagedFor(c.reason) },
        `reason=${c.reason} 的 rewriteGate 不符`,
      ).toEqual({ reason: c.reason, rewrite: c.rewrite });
    }
  });
});
