/**
 * 规则装配计划 —— 纯函数判据。
 *
 * ## 这个文件守的是什么
 *
 * 「取流身份」与「首页推荐流」是**两个完全独立的功能**（用户原话）。
 *
 * 所以本文件最重要的一组断言是：**改一个不影响另一个**。
 * 那类 bug 不会报错，只会表现为"用户只想换推荐，画质却变了"
 * 或者"开关开着，推荐流却没换"。
 */

import { describe, expect, it } from 'vitest';

import {
  FEED_RCMD_PATH,
  buildRulePlan,
  planPaths,
  type RuleState,
} from '@/src/platform/http/rule-plan';

/** 白名单（含推荐流）—— 与 `routes.ts` 的 `ENABLED_ROUTE_PATHS` 同形 */
const ALL_PATHS = [
  '/x/player/wbi/playurl',
  '/x/player/playurl',
  '/pgc/player/web/playurl',
  FEED_RCMD_PATH,
];

function state(over: Partial<RuleState> = {}): RuleState {
  return {
    streamingIdentity: 'extension',
    feedAccountEnabled: false,
    hasCredential: true,
    ...over,
  };
}

describe('buildRulePlan —— 两个功能完全独立', () => {
  it('extension + 推荐流关 → 只装取流', () => {
    expect(buildRulePlan(state())).toEqual({ feedStreaming: true, feedAccount: false });
  });

  it('extension + 推荐流开 → 两个都装', () => {
    expect(buildRulePlan(state({ feedAccountEnabled: true }))).toEqual({
      feedStreaming: true,
      feedAccount: true,
    });
  });

  it('★★ page + 推荐流开 → **只装推荐流，不装取流**', () => {
    /**
     * 这是"独立"的核心用例。
     *
     * 用户设了取流身份 = 浏览器账号（不代理 playurl），
     * 但**开了推荐流开关** → 推荐流仍要用扩展账号。
     *
     * 反向验证：把 `feedAccount` 改成
     * `state.feedAccountEnabled && state.streamingIdentity === 'extension'`
     * → 本用例红（那等于把两个功能绑回一起）。
     */
    expect(buildRulePlan(state({ streamingIdentity: 'page', feedAccountEnabled: true }))).toEqual({
      feedStreaming: false,
      feedAccount: true,
    });
  });

  it('page + 推荐流关 → 一条都不装', () => {
    expect(buildRulePlan(state({ streamingIdentity: 'page' }))).toEqual({
      feedStreaming: false,
      feedAccount: false,
    });
  });

  it('★★ 没有凭据 → 两个槽都不装（最后一道闸）', () => {
    /**
     * 正常路径下"开关开着但没凭据"不会出现（开关 UI 用 `hasCredential` 做可点性）。
     * 但**凭据可能在开关打开后被清掉**（退出账号）——
     * 若此时仍装推荐流规则，会用一份不存在的凭据去代理，结果是未登录态。
     *
     * 反向验证：把 `if (!state.hasCredential)` 那段删掉 → 本用例红。
     */
    expect(buildRulePlan(state({ hasCredential: false, feedAccountEnabled: true }))).toEqual({
      feedStreaming: false,
      feedAccount: false,
    });
  });

  it('全状态矩阵：只有 5 种合法组合', () => {
    const ids = ['extension', 'page'] as const;
    const rows = [true, false].flatMap((hasCredential) =>
      ids.flatMap((streamingIdentity) =>
        [true, false].map((feedAccountEnabled) => {
          const p = buildRulePlan({ streamingIdentity, feedAccountEnabled, hasCredential });
          return `${hasCredential ? 'has' : 'noCred'}/${
            streamingIdentity === 'extension' ? 'ext' : 'page'
          }/feed${feedAccountEnabled ? 'On' : 'Off'} → stream=${String(p.feedStreaming)} feed=${String(p.feedAccount)}`;
        }),
      ),
    );
    expect(rows).toMatchInlineSnapshot(`
      [
        "has/ext/feedOn → stream=true feed=true",
        "has/ext/feedOff → stream=true feed=false",
        "has/page/feedOn → stream=false feed=true",
        "has/page/feedOff → stream=false feed=false",
        "noCred/ext/feedOn → stream=false feed=false",
        "noCred/ext/feedOff → stream=false feed=false",
        "noCred/page/feedOn → stream=false feed=false",
        "noCred/page/feedOff → stream=false feed=false",
      ]
    `);
  });
});

describe('planPaths —— 推荐流不能同时进两套规则', () => {
  it('取流那套**永远排除**推荐流路径', () => {
    /**
     * ⚠️ 这是最容易错的一处：`feed/rcmd` **在白名单里**，
     * 所以 `feedStreaming` 装规则时它会跟着被装。
     *
     * 若不排除 → 取流身份 = extension、推荐流开关**关着**时，
     * 推荐流仍会被换成扩展账号 → **开关形同虚设**。
     *
     * 反向验证：把 `.filter((p) => p !== FEED_RCMD_PATH)` 删掉 → 本用例红。
     */
    const plan = planPaths({ feedStreaming: true, feedAccount: false }, ALL_PATHS);
    expect(plan.streamingPaths).not.toContain(FEED_RCMD_PATH);
    expect(plan.streamingPaths).toEqual([
      '/x/player/wbi/playurl',
      '/x/player/playurl',
      '/pgc/player/web/playurl',
    ]);
  });

  it('推荐流开关开 → feedAccount 为 true，且它不在取流那套里', () => {
    const plan = planPaths({ feedStreaming: true, feedAccount: true }, ALL_PATHS);
    expect(plan.feedAccount).toBe(true);
    expect(plan.streamingPaths).not.toContain(FEED_RCMD_PATH);
  });

  it('取流不装时 streamingPaths 为空数组', () => {
    const plan = planPaths({ feedStreaming: false, feedAccount: true }, ALL_PATHS);
    expect(plan.streamingPaths).toEqual([]);
    expect(plan.feedAccount).toBe(true);
  });

  it('⚠️ 推荐流不在白名单里时 → feedAccount 强制 false（装了也白装）', () => {
    /**
     * `buildPathRule()` 会因 `isProxyPath()` 拒绝而返回 null。
     * 与其"装了但静默无效"，不如在计划层就判成 false —— 可观测。
     */
    const withoutFeed = ALL_PATHS.filter((p) => p !== FEED_RCMD_PATH);
    const plan = planPaths({ feedStreaming: true, feedAccount: true }, withoutFeed);
    expect(plan.feedAccount).toBe(false);
  });
});
