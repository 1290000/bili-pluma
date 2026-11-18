// @vitest-environment jsdom

/**
 * S4（ADR 0041）：`pgc-takeover-ok` 的接收与 reload 决策早退。
 *
 * ## 为什么用「真实代码文本 + stubs 注入」而不是结构断言
 *
 * `entrypoints/content.ts` 是 WXT 入口（import 了运行时依赖，不能整文件 eval），
 * 本文件沿用仓库既有的两条手法：
 * - **真实代码文本跑行为**：消息分派分支与 `orchestratePgc` 函数体从源码里抠出来，
 *   用 `new Function` + `with(stubs)` 注入依赖执行（与 `main-world-pgc.test.ts`
 *   的 G7 手法同源）——测的是真正会跑的那段代码，不是抄一份的实现；
 * - **结构断言**钉住接线点必须存在（照 `pgc-gate-observability.test.ts` 的风格）。
 *
 * ## 为什么消息类型不在 `messages.ts`
 *
 * 主世界 → ISOLATED 的 `postMessage` 通道**从来不在** `messages.ts` 的白名单里
 * （`ssr-playinfo` / `playurl-raw` / `pgc-playview-stream` 都直接在 `content.ts`
 * 的 window listener 里分发）；`check-messages` 只对账 background 路由的请求类型。
 * `pgc-takeover-ok` 与它们同类。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

const CONTENT_SRC = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

/** 从源码里抠出 `pgc-takeover-ok` 的分派分支并执行（依赖经 stubs 注入）。 */
function runDispatch(
  d: { type: string; json?: unknown },
  stubs: { pgcReloadTrace: any; pageState: any },
): void {
  const at = CONTENT_SRC.indexOf("if (d.type === 'pgc-takeover-ok')");
  expect(at, '源码里找不到 pgc-takeover-ok 分派分支').toBeGreaterThan(-1);
  const returnAt = CONTENT_SRC.indexOf('return;', at);
  const block = CONTENT_SRC.slice(at, CONTENT_SRC.indexOf('}', returnAt) + 1);
  new Function('stubs', `with (stubs) { ${block} }`)({ d, ...stubs });
}

/** 从源码里抠出整个 `orchestratePgc` 函数体（以它的文档注释结束标记定位尾部）。 */
function loadOrchestrate(
  stubs: Record<string, any>,
): (cid: string, ssrData?: unknown, patched?: boolean) => Promise<void> {
  const start = CONTENT_SRC.indexOf('async function orchestratePgc(');
  expect(start, '源码里找不到 orchestratePgc').toBeGreaterThan(-1);
  const endMark = CONTENT_SRC.indexOf('/**\n * 把 `guardActionForOutcome()', start);
  expect(endMark, '找不到 orchestratePgc 的结束标记').toBeGreaterThan(start);
  const ts = CONTENT_SRC.slice(start, endMark).replace(/\s+$/, '');
  // content.ts 是 TS：先剥类型再交给 `new Function`（esbuild 随 vite 一起装）
  const js = transpileModule(ts, {
    compilerOptions: {
      target: 99 /* ESNext */,
      module: 99 /* ESNext（类型剥离，不再转换） */,
    },
  }).outputText;
  // ⚠️ 工厂调用时就要把 stubs 传进去：返回的 orchestratePgc 闭包着 with 作用域，
  // 之后每次调用时的标识符解析都走 stubs。
  return new Function('stubs', `with (stubs) { ${js}; return orchestratePgc; }`)(stubs) as (
    cid: string,
    ssrData?: unknown,
    patched?: boolean,
  ) => Promise<void>;
}

/** `orchestratePgc` 的依赖桩：记录关键调用，供断言「没取流 / 没 reload」。 */
function orchestrateStubs(opts: { flipOnWrite?: boolean } = {}): {
  stubs: Record<string, any>;
  pgcReloadTrace: any;
  calls: Record<string, number>;
} {
  const pgcReloadTrace: any = {
    callbackTakeover: false,
    orchestrateCalls: 0,
    cid: '',
    orchestrateExit: 'pending',
    shouldReloadCalls: 0,
    reloadWithGuardCalls: 0,
  };
  const calls = {
    parsePlayPage: 0,
    prepareFullStream: 0,
    reloadWithGuard: 0,
    applyPlayback: 0,
    tryUpgrade: 0,
  };
  const stubs = {
    NS: '__PLUMA__',
    CHANNEL_TOKEN: 'test-token',
    proxyEnabledKnown: true,
    pgcReloadTrace,
    // orchestratePgc 现在经这个 getter 读标志（绕 TS 属性收窄）；桩实现读同一份对象，
    // 竞态用例里 flipOnWrite 改的就是它。
    pgcCallbackTakeover: () => pgcReloadTrace.callbackTakeover,
    parsePlayPage: () => {
      calls.parsePlayPage += 1;
      return { kind: 'pgc', epId: null };
    },
    isStreamTruncated: () => false,
    readSsrVideoInfo: () => ({ quality: 80, timelength: 1000 }),
    expectedDurationMs: () => 1000,
    applyGuardDecisionForRound: () => {},
    reportQuality: () => {},
    canSkipPgcInjection: () => false,
    pageState: {
      applyPlayback: () => {
        calls.applyPlayback += 1;
      },
    },
    tryUpgradeForQuality: async () => {
      calls.tryUpgrade += 1;
      return false;
    },
    loadCachedVideoInfo: async () => ({ quality: 80, timelength: 1000 }),
    isVideoInfoTruncated: () => false,
    shouldResetGuardForBadCache: () => false,
    GUARD_KEY_PREFIX: 'pluma:pgc-reload:',
    isSyncCacheUsable: () => false,
    writePgcSessionCache: () => {
      // 模拟竞态：orchestratePgc 跑到一半时，主世界的回调接管成功了
      if (opts.flipOnWrite) pgcReloadTrace.callbackTakeover = true;
    },
    shouldReload: () => true,
    reloadWithGuard: () => {
      calls.reloadWithGuard += 1;
    },
    isAlreadyTried: () => false,
    parseGuard: () => null,
    prepareFullStream: async () => {
      calls.prepareFullStream += 1;
    },
    sessionStorage,
    location: { href: 'https://www.bilibili.com/bangumi/play/ss34412' },
  };
  return { stubs, pgcReloadTrace, calls };
}

describe('S4：pgc-takeover-ok 分派分支（真实代码文本）', () => {
  it('收到消息 → callbackTakeover=true、applyPlayback(载荷)、orchestrateExit 覆盖为 callback-takeover', () => {
    const pgcReloadTrace: any = {
      callbackTakeover: false,
      // 模拟竞态：orchestratePgc 已经先跑完并记录了别的出口
      orchestrateExit: 'not-truncated-early-return',
    };
    const applied: Array<unknown> = [];
    runDispatch(
      { type: 'pgc-takeover-ok', json: { code: 0, result: { quality: 120 } } },
      { pgcReloadTrace, pageState: { applyPlayback: (j: unknown) => void applied.push(j) } },
    );

    expect(pgcReloadTrace.callbackTakeover).toBe(true);
    // 竞态覆盖：埋点必须反映"这一轮真正发生的事"
    expect(pgcReloadTrace.orchestrateExit).toBe('callback-takeover');
    expect(applied).toEqual([{ code: 0, result: { quality: 120 } }]);
  });

  it('json 缺失 → applyPlayback(null)，不抛错', () => {
    const pgcReloadTrace: any = { callbackTakeover: false, orchestrateExit: '' };
    const applied: Array<unknown> = [];
    expect(() =>
      runDispatch(
        { type: 'pgc-takeover-ok' },
        { pgcReloadTrace, pageState: { applyPlayback: (j: unknown) => void applied.push(j) } },
      ),
    ).not.toThrow();
    expect(applied).toEqual([null]);
    expect(pgcReloadTrace.callbackTakeover).toBe(true);
  });
});

describe('S4：orchestratePgc 的 callbackTakeover 早退（真实函数文本）', () => {
  it('标志已 true → 入口早退：不取流、不 reload、连 parsePlayPage 都不调', async () => {
    const { stubs, pgcReloadTrace, calls } = orchestrateStubs();
    pgcReloadTrace.callbackTakeover = true;
    const orchestratePgc = loadOrchestrate(stubs);

    await orchestratePgc('100', { code: 0, result: {} });

    expect(pgcReloadTrace.orchestrateExit).toBe('callback-takeover');
    expect(calls.parsePlayPage).toBe(0);
    expect(calls.prepareFullStream).toBe(0);
    expect(calls.reloadWithGuard).toBe(0);
  });

  it('竞态：流程中途标志才翻真 → reload 决策点二次检查接住，不发 reload', async () => {
    const { stubs, pgcReloadTrace, calls } = orchestrateStubs({ flipOnWrite: true });
    const orchestratePgc = loadOrchestrate(stubs);

    await orchestratePgc('100', { code: 0, result: {} });

    // 旧链路走到 cache-nosync 决策点，但二次检查在 reloadWithGuard 之前接住
    expect(pgcReloadTrace.orchestrateExit).toBe('callback-takeover');
    expect(calls.reloadWithGuard).toBe(0);
    expect(calls.prepareFullStream).toBe(0);
  });

  it('标志仍 false → 旧链路照跑（cache-nosync-reload），试看集仍会取流 + reload', async () => {
    const { stubs, pgcReloadTrace, calls } = orchestrateStubs();
    const orchestratePgc = loadOrchestrate(stubs);

    await orchestratePgc('100', { code: 0, result: {} });

    expect(calls.reloadWithGuard).toBe(1);
    expect(pgcReloadTrace.orchestrateExit).toBe('cache-nosync-reload');
  });
});

describe('S4：接线点结构断言（照 gate-observability 的风格）', () => {
  it('main-world 发 pgc-takeover-ok 的载荷带 code:0 + result', () => {
    const MAIN_SRC = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');
    expect(MAIN_SRC).toContain("type: 'pgc-takeover-ok'");
    expect(MAIN_SRC).toMatch(/json: \{ code: 0, result: apiSnapshot \}/);
  });

  it('orchestratePgc 的 reload 决策点在 reloadWithGuard 之前查 callbackTakeover', () => {
    const at = CONTENT_SRC.indexOf("pgcReloadTrace.orchestrateExit = 'cache-nosync-reload';");
    expect(at).toBeGreaterThan(-1);
    // 二次检查必须出现在 cache-nosync-reload 赋值之前（否则 reload 已发、检查就是摆设）
    const check = CONTENT_SRC.lastIndexOf('pgcReloadTrace.callbackTakeover === true', at);
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(at);
  });
});
