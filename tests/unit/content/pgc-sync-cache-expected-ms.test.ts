/**
 * `isSyncCacheUsable(raw, expectedMs)` 的 `expectedMs` 兜底（2026-10-30）
 *
 * ## 为什么必须给这个参数
 *
 * 四条长度判据里，写入侧 `shouldWritePgcCache(merged, expectedMs)` 早就接了
 * `expectedMs`，读取侧 `isSyncCacheUsable(raw)` **没接** —— 后果是：
 *
 * ```
 * 接口缺 timelength
 *   → 缓存里的 vi 也没有 timelength
 *   → isTruncatedVideoInfo 的 refMs = max(0, 0) = 0 → 直接判定"不截断"
 *   → 一份 180 秒的试看流被当成可用缓存 → hadSync = true → **不刷新**
 *   → 用户看到的就是"永远 180 秒"
 * ```
 *
 * 同一份数据在写入口被判"截断"拒写、在读取口被判"可用"放行 ——
 * 两侧判据不一致这件事，2026-10-29 那次「永远 180 秒」就是这个形态。
 *
 * ## ⚠️ 反例验证（AGENTS.md §1.5）
 *
 * 把 `isSyncCacheUsable` 里的 `isVideoInfoTruncated(vi, expectedMs)` 改回
 * `isVideoInfoTruncated(vi)`，本文件标 ★ 的用例必须变红。
 */
import { describe, expect, it } from 'vitest';

import { isSyncCacheUsable, shouldWritePgcCache } from '@/src/content/isolated/pgc-cache-inject';
import { expectedDurationMs } from '@/src/core/playinfo/pgc-duration';

/** 真机的整集时长：19 分 26 秒（`timelength: 1166528`） */
const EP_MS = 1_166_528;

/**
 * 毒缓存的第二种形态：**缓存里完全没有 `timelength`**。
 *
 * 和 2026-10-29 抓到的那份（`durl.len 180160` + `timelength 1166528`）不同 ——
 * 那份自带了参照时长，长度判据够用；这份没有参照，读取侧必须靠 SSR 的
 * `timelength` 兜底，否则根本判不出来。
 */
const NO_TIMELENGTH_RAW = JSON.stringify({
  vi: {
    type: 3,
    format: 'flv',
    quality: 80,
    durl: [{ order: 1, length: 180_160, url: 'https://example.invalid/x.mp4' }],
  },
  exp: Date.now() + 3_600_000,
});

/** 同上，但走 dash（`duration` 单位是秒） */
const NO_TIMELENGTH_DASH_RAW = JSON.stringify({
  vi: {
    quality: 80,
    dash: { duration: 180, video: [{ id: 80, height: 1080, base_url: 'a' }] },
  },
  exp: Date.now() + 3_600_000,
});

/** 缺 `timelength` 的**完整**流：durl 单段 ≈ 整集 */
const NO_TIMELENGTH_FULL_RAW = JSON.stringify({
  vi: { quality: 80, durl: [{ order: 1, length: 1_166_500 }] },
  exp: Date.now() + 3_600_000,
});

describe('isSyncCacheUsable(raw, expectedMs)：缺 timelength 时靠 SSR 兜底', () => {
  it('★ 缺 timelength + 180 秒 durl + expectedMs=1166528 → 不可用（本修复的核心）', () => {
    /**
     * 反例：去掉 `expectedMs` 透传 → 本条红（返回 true = 毒缓存被采纳）。
     */
    expect(isSyncCacheUsable(NO_TIMELENGTH_RAW, EP_MS)).toBe(false);
  });

  it('★ 缺 timelength + 180 秒 dash + expectedMs=1166528 → 不可用', () => {
    expect(isSyncCacheUsable(NO_TIMELENGTH_DASH_RAW, EP_MS)).toBe(false);
  });

  it('★ 缺 timelength + 完整 durl + expectedMs=1166528 → 可用（不许误杀）', () => {
    /**
     * 兜底的另一面：接了 `expectedMs` 之后不能把所有缺 timelength 的缓存都判死。
     * 完整流仍要判可用，否则每次都白刷一次（用户看到闪屏）。
     */
    expect(isSyncCacheUsable(NO_TIMELENGTH_FULL_RAW, EP_MS)).toBe(true);
  });

  it('expectedMs=0（没有第二参照）→ 行为与修复前一致：判不了 = 可用', () => {
    /**
     * 这是刻意的方向，不是遗漏。
     *
     * `expectedMs` 来自 SSR 的 `timelength`；SSR 没给就是"真的没有参照"。
     * 此时判不了就放行 —— 与 `isVideoInfoTruncated` 的既有口径、
     * 与 ADR 0020「判不了就放行」一致。**不许**把"没有参照"当成"截断"：
     * 那会让每一个 SSR 缺 timelength 的页面都刷一次。
     */
    expect(isSyncCacheUsable(NO_TIMELENGTH_RAW, 0)).toBe(true);
    expect(isSyncCacheUsable(NO_TIMELENGTH_RAW)).toBe(true);
  });

  it('缓存自带的 timelength 更可信时不被 expectedMs 覆盖（取 max）', () => {
    /**
     * `isTruncatedVideoInfo` 用的是 `refMs = max(timelength, expectedMs)`。
     * 缓存里 `timelength` 更长（19 分钟）而传进来的 `expectedMs` 更短（6 分钟）时，
     * 参照仍是 19 分钟 —— 180 秒的流照样判截断。
     *
     * 这条防的是"把 max 写成 min 或直接覆盖"。
     */
    const raw = JSON.stringify({
      vi: { timelength: EP_MS, durl: [{ order: 1, length: 180_160 }] },
      exp: Date.now() + 3_600_000,
    });
    expect(isSyncCacheUsable(raw, 360_000)).toBe(false);
  });

  it('expectedMs 比缓存 timelength 长时也生效（SSR 说整集 19 分钟）', () => {
    const raw = JSON.stringify({
      vi: { timelength: 360_000, durl: [{ order: 1, length: 355_000 }] },
      exp: Date.now() + 3_600_000,
    });
    // 缓存自称 6 分钟、流 355 秒 —— 对自己是"完整"的
    expect(isSyncCacheUsable(raw, 0)).toBe(true);
    // 但 SSR 说整集 19 分钟 → 6 分钟的流是截断的
    expect(isSyncCacheUsable(raw, EP_MS)).toBe(false);
  });

  it('坏数据仍然优先判不可用（expectedMs 不会绕过结构校验）', () => {
    expect(isSyncCacheUsable(null, EP_MS)).toBe(false);
    expect(isSyncCacheUsable('{not json', EP_MS)).toBe(false);
    expect(isSyncCacheUsable(JSON.stringify({ exp: 1 }), EP_MS)).toBe(false);
    expect(isSyncCacheUsable(JSON.stringify({ vi: 'oops' }), EP_MS)).toBe(false);
  });

  it('★ 与写入侧判据一致：同一份缺 timelength 的数据，写入口拒、读取口也拒', () => {
    /**
     * 这条是**一致性断言**，不是重复覆盖。
     *
     * bug 的本质是"两个入口对同一份数据给出相反答案"。所以这里把
     * `shouldWritePgcCache`（写入侧）和 `isSyncCacheUsable`（读取侧）
     * 对**同一份** `video_info` + **同一个** `expectedMs` 的结论放在一起比。
     *
     * 反例：任一入口丢掉 `expectedMs` → 两侧结论劈开 → 本条红。
     */
    const vi = JSON.parse(NO_TIMELENGTH_RAW).vi as Record<string, unknown>;

    const writeSide = shouldWritePgcCache(vi, EP_MS);
    const readSide = isSyncCacheUsable(NO_TIMELENGTH_RAW, EP_MS);

    expect(writeSide).toBe(false);
    expect(readSide).toBe(writeSide);
  });

  it('SSR 的 expectedMs 由 expectedDurationMs 给出（入口接线的口径）', () => {
    /**
     * 入口两处都写成 `expectedDurationMs(readSsrVideoInfo(ssr))`。
     * 这条钉住"那个函数的取值口径"，防止有人换成 `dash.duration`
     * （秒 vs 毫秒会差 1000 倍，见 `pgc-duration.ts` 的注释）。
     */
    expect(expectedDurationMs({ timelength: EP_MS })).toBe(EP_MS);
    expect(expectedDurationMs({ dash: { duration: 1166 } })).toBe(0);
    expect(expectedDurationMs(null)).toBe(0);
  });
});
