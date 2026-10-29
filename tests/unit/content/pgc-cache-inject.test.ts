import { describe, expect, it } from 'vitest';

import { hasPlayableStream, mergeVideoInfo } from '@core/playinfo/pgc-merge';

import {
  canSkipPgcInjection,
  isBetterStream,
  isPreviewSsr,
  isStreamTruncated,
  isSyncCacheUsable,
  isVideoInfoTruncated,
  maxVideoHeight,
  readCidFromSsr,
  shouldWritePgcCache,
} from '../../../src/content/isolated/pgc-cache-inject';

/**
 * ISOLATED 侧从主世界报上来的 `ssr-playinfo` 里取信息。
 *
 * 这里守的是两件容易写错的事：
 *   1. 两种外壳（`{result}` / `{data:{result}}`）都要认
 *   2. `is_preview` 与 `play_video_type === 'preview'` **任一成立即算试看**
 *      —— 实测两个字段有时不同步（免费集 `is_preview` 可能缺失）
 */

const SSR_STD = {
  code: 0,
  result: {
    play_video_type: 'preview',
    arc: { cid: 281989571, title: 'x' },
    video_info: { is_preview: true, timelength: 1440083 },
  },
};

describe('readCidFromSsr', () => {
  it('从 result.arc.cid 取', () => {
    expect(readCidFromSsr(SSR_STD)).toBe('281989571');
  });

  it('外面包了一层 data 也认', () => {
    expect(readCidFromSsr({ data: SSR_STD })).toBe('281989571');
  });

  it('arc 缺失时回落到 video_info.cid', () => {
    expect(readCidFromSsr({ result: { video_info: { cid: 123 } } })).toBe('123');
  });

  it('字符串 cid 也认（服务端偶尔给字符串）', () => {
    expect(readCidFromSsr({ result: { arc: { cid: '456' } } })).toBe('456');
  });

  it('没有 cid 返回 null', () => {
    expect(readCidFromSsr({ result: {} })).toBeNull();
    expect(readCidFromSsr(null)).toBeNull();
    expect(readCidFromSsr('x')).toBeNull();
  });

  it('非法 cid（0 / 负数 / NaN）返回 null，不能拿去当缓存 key', () => {
    expect(readCidFromSsr({ result: { arc: { cid: 0 } } })).toBeNull();
    expect(readCidFromSsr({ result: { arc: { cid: -1 } } })).toBeNull();
    expect(readCidFromSsr({ result: { arc: { cid: NaN } } })).toBeNull();
    expect(readCidFromSsr({ result: { arc: { cid: 'abc' } } })).toBeNull();
  });
});

describe('isPreviewSsr', () => {
  it('play_video_type === preview 算试看', () => {
    expect(isPreviewSsr(SSR_STD)).toBe(true);
  });

  it('只有 is_preview 也算试看（两个字段不一定同步）', () => {
    expect(isPreviewSsr({ result: { video_info: { is_preview: true } } })).toBe(true);
  });

  it('whole 且有流 → 不是试看（免费集不该注入）', () => {
    expect(
      isPreviewSsr({
        result: { play_video_type: 'whole', video_info: { is_preview: false, durls: [{}] } },
      }),
    ).toBe(false);
  });

  it('数据残缺时保守返回 false（不注入，宁可按原样播）', () => {
    expect(isPreviewSsr(null)).toBe(false);
    expect(isPreviewSsr({})).toBe(false);
  });
});

describe('isStreamTruncated：判据是"流够不够长"，不是 is_preview 标志', () => {
  /**
   * 2026-10-28 真机踩到：第二次进同一集时
   * `play_video_type: "whole"` / `is_preview: false` / `timelength: 1440083`，
   * **但 `video.duration` 只有 360**。
   *
   * 按标志判断 → 判定"不是试看" → 不注入 → 用户卡在 6 分 01 秒。
   */

  const TIMELENGTH = 1_440_083;

  it('dash 只有 360 秒、timelength 是 24 分钟 → 被截断', () => {
    expect(
      isStreamTruncated({
        result: {
          play_video_type: 'whole',
          video_info: { timelength: TIMELENGTH, dash: { duration: 360 } },
        },
      }),
    ).toBe(true);
  });

  it('dash 是 1441 秒 → 不算截断（容差内）', () => {
    expect(
      isStreamTruncated({
        result: {
          play_video_type: 'whole',
          video_info: { timelength: TIMELENGTH, dash: { duration: 1441 } },
        },
      }),
    ).toBe(false);
  });

  it('纯 durl 流水线：4 组 × 360 秒 → 被截断', () => {
    expect(
      isStreamTruncated({
        result: {
          video_info: {
            timelength: TIMELENGTH,
            durls: [
              { durl: [{ length: 360082 }, { length: 360082 }] },
              { durl: [{ length: 360082 }] },
            ],
          },
        },
      }),
    ).toBe(true);
  });

  it('纯 durl 但时长足够 → 不算截断', () => {
    expect(
      isStreamTruncated({
        result: {
          video_info: {
            timelength: 600_000,
            durls: [{ durl: [{ length: 600_000 }] }],
          },
        },
      }),
    ).toBe(false);
  });

  it('容差 5 秒：差 900ms 不算截断（实测 dash 1441s vs timelength 1440083ms）', () => {
    expect(
      isStreamTruncated({
        result: { video_info: { timelength: 1_441_000, dash: { duration: 1441 } } },
      }),
    ).toBe(false);
  });

  it('数据残缺时保守返回 false（不贸然注入）', () => {
    expect(isStreamTruncated(null)).toBe(false);
    expect(isStreamTruncated({})).toBe(false);
    expect(isStreamTruncated({ result: {} })).toBe(false);
    expect(isStreamTruncated({ result: { video_info: {} } })).toBe(false);
  });

  it('外层包了 data 也认', () => {
    expect(
      isStreamTruncated({
        data: { result: { video_info: { timelength: TIMELENGTH, dash: { duration: 360 } } } },
      }),
    ).toBe(true);
  });
});

/**
 * `playview` 的响应形状（ADR 0023，2026-10-28 真机实测）。
 *
 * ## 这组测试守的是"别拿 timelength 判断能不能播"
 *
 * `playview` 的 `timelength` 是 **1440000（整集 24 分钟）**，
 * 而 `durls` 只有 4 组 × 6 分钟。**`timelength` 是整集元数据，不代表流有多长。**
 *
 * 之前 `readVideoInfo` 只认 `result.video_info` 和 `data.result.video_info`，
 * 而 `playview` 是 `data.video_info`（没有 `result` 层）→ 直接取不到 → 判不了。
 */
describe('isStreamTruncated：playview 的响应形状', () => {
  const TIMELENGTH = 1_440_000;

  const previewResp = (vi: Record<string, unknown>) => ({
    code: 0,
    data: { arc: { cid: 253153139, aid: 415131120 }, play_video_type: 'preview', video_info: vi },
  });

  it('试看：durls 4 组 × 6 分钟，timelength 24 分钟 → 被截断', () => {
    expect(
      isStreamTruncated(
        previewResp({
          timelength: TIMELENGTH,
          is_preview: 1,
          durls: Array.from({ length: 4 }, () => ({ durl: [{ length: 360_109 }] })),
        }),
      ),
    ).toBe(true);
  });

  it('完整：单段 durl 长度 = timelength → 不算截断', () => {
    expect(
      isStreamTruncated(
        previewResp({
          timelength: TIMELENGTH,
          durl: [{ length: TIMELENGTH, size: 292_087_480 }],
        }),
      ),
    ).toBe(false);
  });

  it('单段 durl 明显短于 timelength → 被截断', () => {
    expect(
      isStreamTruncated(previewResp({ timelength: TIMELENGTH, durl: [{ length: 360_109 }] })),
    ).toBe(true);
  });

  it('差 2 秒（取整误差内）不算截断 —— 否则完整集会被反复注入', () => {
    expect(
      isStreamTruncated(
        previewResp({ timelength: TIMELENGTH, durl: [{ length: TIMELENGTH - 2000 }] }),
      ),
    ).toBe(false);
  });

  it('`/pgc/player/web/playurl` 的形状：result 本身就是 video_info', () => {
    // 实测：result 里直接有 durl / timelength，没有 video_info 这一层
    expect(
      isStreamTruncated({
        code: 0,
        result: { timelength: TIMELENGTH, durl: [{ length: TIMELENGTH }], is_preview: 0 },
      }),
    ).toBe(false);
  });

  it('取不到 video_info 的形状 → 保守返回 false（不贸然注入）', () => {
    expect(isStreamTruncated({ code: 0, data: {} })).toBe(false);
    expect(isStreamTruncated({ code: 0 })).toBe(false);
    expect(isStreamTruncated(null)).toBe(false);
  });
});

/**
 * 画质比较 —— **2026-10-29 修的第二个 bug 的核心判据**。
 *
 * ## 为什么要和 `isStreamTruncated` 分开测
 *
 * 两者回答不同的问题，**不能互相替代**：
 * - `isStreamTruncated`：这条流够不够长（能不能看完整集）
 * - `isBetterStream`：取到的流画质是不是更高
 *
 * 真机实测（ep733317，限免集）：
 * ```
 * dash:           80@1080 64@720 32@480 16@360   ← 只下发到 1080
 * timelength      1075582ms vs 1076s             ← 相符，不算截断
 * accept_quality  [125,122,120,112,80,...]       ← 内容有 HDR/4K/1080P+
 * 播放账号取流     最高 2160                      ← 本来能拿到
 * ```
 * 旧逻辑只看截断 → 判「无需注入」→ 播放账号没去取 → 用户选了 4K 没反应。
 */
describe('maxVideoHeight', () => {
  it('取 dash.video 里的最高高度', () => {
    expect(
      maxVideoHeight({ dash: { video: [{ height: 1080 }, { height: 720 }, { height: 2160 }] } }),
    ).toBe(2160);
  });

  it('没有 dash / 没有 video / 空数组 → 0（不猜）', () => {
    expect(maxVideoHeight(null)).toBe(0);
    expect(maxVideoHeight({})).toBe(0);
    expect(maxVideoHeight({ dash: {} })).toBe(0);
    expect(maxVideoHeight({ dash: { video: [] } })).toBe(0);
  });

  it('height 缺失或非数字的轨被忽略', () => {
    expect(maxVideoHeight({ dash: { video: [{ height: 720 }, {}, { height: '1080' }] } })).toBe(
      720,
    );
  });
});

describe('isBetterStream', () => {
  const vi = (h: number) => ({ dash: { video: [{ height: h }] } });

  it('严格更高才替换 —— 限免集 1080 → 4K 走这条', () => {
    expect(isBetterStream(1080, vi(2160))).toBe(true);
  });

  it('相等不替换（避免无意义的 reload 闪屏）', () => {
    expect(isBetterStream(2160, vi(2160))).toBe(false);
    expect(isBetterStream(1080, vi(1080))).toBe(false);
  });

  it('更低不替换（**不许把画质拉低**）', () => {
    expect(isBetterStream(2160, vi(1080))).toBe(false);
  });

  it('取回来没有可用轨 → 不替换', () => {
    expect(isBetterStream(1080, null)).toBe(false);
    expect(isBetterStream(1080, {})).toBe(false);
  });

  /**
   * 这条守的是「会员老番不许掉回试看」的**边界**：
   * 老番的 SSR 流本身就短，走的是 `isStreamTruncated` 那条路，
   * 根本不会调到这里。但如果哪天真调到了，也不许因为"画质不更高"就去动它。
   */
  it('当前 720、取回也只有 720 → 不动（老番场景）', () => {
    expect(isBetterStream(720, vi(720))).toBe(false);
  });
});

/**
 * `canSkipPgcInjection` —— 「重开开关后卡在试看」的守卫（2026-10-29）。
 *
 * ## 这条测试守的是一个**反直觉**的 bug
 *
 * 注入越成功，`orchestratePgc` 的早退分支越容易被误触发：
 *
 * ```
 * 主世界 setter：
 *   ssrPlayinfo = v          ← 记下引用
 *   pgcPatchPlayinfo(v)      ← 原地 r.video_info = next，引用不变
 * → 上报给 ISOLATED 的 data 已经是注入后的完整流
 * → isStreamTruncated() 得到 false（完整流当然"够长"）
 * → 走「无需注入」早退 → cache 分支永不执行 → 永不 reload
 * ```
 *
 * 真机表现：`patchedAt: 583` + `duration: 180` 同时成立，
 * 且 `sessionStorage` 里**从来没有** `pluma:pgc-reload`。
 *
 * ⚠️ 反例验证：把 `if (opts.pgcPatchedByUs) return false;` 删掉，
 * 下面第 2、3 条必红。
 */
describe('canSkipPgcInjection：区分「SSR 本来就完整」与「被我们改成了完整」', () => {
  it('① 首访免费集：SSR 本来就完整、没被我们改过 → 跳过取流', () => {
    expect(canSkipPgcInjection({ pgcPatchedByUs: false, truncated: false })).toBe(true);
  });

  it('② 第二趟：注入成了完整流（truncated=false）→ **不能**跳过，要继续走 cache 分支', () => {
    /**
     * 这是本组最重要的一条。若返回 true 就回到「永不 reload」的老 bug。
     */
    expect(canSkipPgcInjection({ pgcPatchedByUs: true, truncated: false })).toBe(false);
  });

  it('③ 我们注入过、但流仍是截断（异常情况）→ 继续走 cache 分支', () => {
    expect(canSkipPgcInjection({ pgcPatchedByUs: true, truncated: true })).toBe(false);
  });

  it('④ 真·试看、没注入过 → 继续走 cache 分支（取流）', () => {
    expect(canSkipPgcInjection({ pgcPatchedByUs: false, truncated: true })).toBe(false);
  });

  it('⑤ 四种组合穷举，只有「没注入过 + 不截断」才跳过', () => {
    const cases: Array<[boolean, boolean, boolean]> = [
      [false, false, true], // 唯一跳过
      [false, true, false],
      [true, false, false],
      [true, true, false],
    ];
    for (const [patched, truncated, expected] of cases) {
      expect(
        canSkipPgcInjection({ pgcPatchedByUs: patched, truncated }),
        `pgcPatchedByUs=${String(patched)} truncated=${String(truncated)}`,
      ).toBe(expected);
    }
  });
});

/**
 * `isVideoInfoTruncated` —— 直接收 `video_info` 的长度判据（2026-10-29 加，问题 5）。
 *
 * ## 它守的是一个**已经污染过真实用户缓存**的 bug
 *
 * 用户机器上的 `sessionStorage` 里躺着：
 * ```
 * pluma:pgc-vi:42696771537
 *   durl[0].length : 180160     ← 180 秒
 *   timelength     : 1166528    ← 19 分钟
 *   hasDash        : false
 * ```
 * 播放器拿到「1 段 180 秒 durl」只能播 180 秒 → 「重开开关后画质不恢复」。
 *
 * 而写入侧 / 读取侧当时**都没调过任何长度判据** —— `isStreamTruncated` 明明能识别它。
 *
 * ⚠️ 反例验证：把 `isStreamTruncated` 里的 `<` 改成 `>`，本组第 2、3 条必红。
 */
describe('isVideoInfoTruncated：直接收 video_info', () => {
  it('① 截断的 durl（真机那份坏数据）→ true', () => {
    /**
     * 逐字段照抄真机 `sessionStorage` 里的内容，不改一个数。
     * 这条是整组的地基：判据对它返回 false，坏数据就会被写进缓存。
     */
    expect(
      isVideoInfoTruncated({
        timelength: 1166528,
        quality: 80,
        durl: [{ length: 180160, url: 'https://example/preview.m4s' }],
      }),
    ).toBe(true);
  });

  it('② 完整单段 durl（length ≈ timelength）→ false（不许误杀）', () => {
    /**
     * `fnval=0` 老路的完整集形态：单段 durl，长度就等于 timelength。
     * 误杀它的后果是"每次进页面都白取一次流"，比不修还差。
     */
    expect(
      isVideoInfoTruncated({
        timelength: 1440000,
        durl: [{ length: 1440000, url: 'https://example/full.m4s' }],
      }),
    ).toBe(false);
  });

  it('③ 完整 dash → false（不许误杀）', () => {
    expect(
      isVideoInfoTruncated({
        timelength: 1440083,
        dash: { duration: 1441, video: [{ height: 2160 }] },
      }),
    ).toBe(false);
  });

  it('④ 试看 dash（180s vs 19 分钟）→ true', () => {
    expect(
      isVideoInfoTruncated({
        timelength: 1166528,
        dash: { duration: 180, video: [{ height: 1080 }] },
      }),
    ).toBe(true);
  });

  it('⑤ 空对象 / null / 非对象 → false（判不了就放行）', () => {
    /**
     * 方向必须与 `isStreamTruncated` 的"保守不注入"一致：
     * 判不出来时**不要**把数据当坏的丢掉，否则会把合法缓存误杀。
     */
    expect(isVideoInfoTruncated({})).toBe(false);
    expect(isVideoInfoTruncated(null)).toBe(false);
    expect(isVideoInfoTruncated(undefined)).toBe(false);
    expect(isVideoInfoTruncated('x')).toBe(false);
    expect(isVideoInfoTruncated({ timelength: 1166528 })).toBe(false); // 只有 timelength，没有流
  });

  it('⑥ 容差 5 秒：差 917ms 不算截断（实测 dash 1441s vs timelength 1440083ms）', () => {
    expect(
      isVideoInfoTruncated({
        timelength: 1_441_000,
        dash: { duration: 1441, video: [{}] },
      }),
    ).toBe(false);
  });

  it('⑦ durls：只看第一组的段总长', () => {
    // 4 组 × 1 段 × 360109ms = 截断（vs 24 分钟）
    expect(
      isVideoInfoTruncated({
        timelength: 1_440_000,
        durls: Array.from({ length: 4 }, () => ({ durl: [{ length: 360_109 }] })),
      }),
    ).toBe(true);
    // 单组内多段累加够长 → 不截断
    expect(
      isVideoInfoTruncated({
        timelength: 1_440_000,
        durls: [{ durl: [{ length: 720_000 }, { length: 720_000 }] }],
      }),
    ).toBe(false);
  });

  it('⑧ 多段 durl：按段相加，不再只看第一段（verifier 反例）', () => {
    expect(
      isVideoInfoTruncated({
        timelength: 600_000,
        durl: [{ length: 300_000 }, { length: 300_000 }],
      }),
    ).toBe(false);
    expect(
      isVideoInfoTruncated({
        timelength: 600_000,
        durl: [{ length: 180_000 }, { length: 180_000 }],
      }),
    ).toBe(true);
  });

  it('⑨ expectedMs 第二参照：接口缺 timelength 也能判', () => {
    // 没有 timelength，但 SSR 告诉我们是 19 分钟 → 180 秒的流必须判截断
    expect(isVideoInfoTruncated({ durl: [{ length: 180_160 }] }, 1_166_528)).toBe(true);
    expect(isVideoInfoTruncated({ durl: [{ length: 1_166_528 }] }, 1_166_528)).toBe(false);
    // 没有第二参照时仍保守放行
    expect(isVideoInfoTruncated({ durl: [{ length: 180_160 }] }, 0)).toBe(false);
  });
});

/**
 * 端到端：**坏数据不会走完「取流 → 合并 → 写缓存」这条链**（2026-10-29，问题 5）。
 *
 * ## 为什么这条必须存在
 *
 * 单测 `isVideoInfoTruncated` 只证明"判据本身对"。但真正的 bug 是
 * **判据从没被调用**。所以这里把链路上每一步都用真实函数串起来：
 *
 * ```
 * 接口响应（无权益时的形状）
 *   → hasPlayableStream()   放行（它只看"有没有流"）
 *   → mergeVideoInfo()      合并非 null
 *   → isVideoInfoTruncated() **必须拦住**
 * ```
 *
 * 只要最后一步返回 false，坏数据就会被写进缓存并躺 100 分钟 ——
 * 那正是用户在真机上遇到的状态。
 *
 * ⚠️ 这条也顺便把「`hasPlayableStream` 放行 ≠ 是完整流」这件事变成可执行的断言，
 * 避免下一个人看到 `hasPlayableStream` 返回 true 就以为安全了。
 */
describe('端到端：坏数据链路必须在写入前被拦住', () => {
  /** 无权益时接口返回的真实形状（真机 sessionStorage 那份的来源） */
  const PREVIEW_API_RESULT = {
    quality: 80,
    timelength: 1166528, // 整集 19 分钟
    format: 'mp4',
    durl: [{ length: 180160, url: 'https://example/preview.m4s' }],
  };

  it('hasPlayableStream 会放行它（只判有无流，不判长度）', () => {
    /**
     * 这是**已知且本次不修**的漏点（决策：取流侧语义不动）。
     * 断言它放行，是为了把"这里不安全"钉成事实 ——
     * 谁哪天以为 `hasPlayableStream === true` 就等于"完整流"，这条会提醒他。
     */
    expect(hasPlayableStream(PREVIEW_API_RESULT)).toBe(true);
  });

  it('mergeVideoInfo 也会产出非 null（它只负责搬字段，不负责验长度）', () => {
    const merged = mergeVideoInfo({ is_preview: true }, PREVIEW_API_RESULT);
    expect(merged).not.toBeNull();
    // 合并结果就是真机缓存里那份自相矛盾的数据
    expect(merged?.timelength).toBe(1166528);
    const durl = merged?.durl as { length: number }[] | undefined;
    expect(durl?.[0]?.length).toBe(180160);
  });

  it('但 isVideoInfoTruncated 能拦住它 —— 这就是写入侧校验的价值', () => {
    const merged = mergeVideoInfo({ is_preview: true }, PREVIEW_API_RESULT);
    expect(isVideoInfoTruncated(merged)).toBe(true);
  });

  it('完整流走完同一条链 → 不被拦（防过度修复）', () => {
    const fullApiResult = {
      quality: 120,
      timelength: 1166528,
      dash: { duration: 1166, video: [{ height: 2160 }] },
    };
    expect(hasPlayableStream(fullApiResult)).toBe(true);
    const merged = mergeVideoInfo({ is_preview: false }, fullApiResult);
    expect(merged).not.toBeNull();
    expect(isVideoInfoTruncated(merged)).toBe(false);
  });
});

/**
 * `shouldWritePgcCache` —— 写入侧的**唯一决策点**（2026-10-29，问题 5）。
 *
 * ## 为什么它必须是纯函数而不是内联的 `if`
 *
 * 它原先内联在 `entrypoints/content.ts` 的 `prepareFullStream` 里。
 * 反例验证实测：**把那个 `if` 删掉，当时所有测试仍然全绿** ——
 * 因为 `content.ts` 是 WXT 入口，没有任何测试能覆盖它。
 *
 * 而这个判断一旦失效，坏数据就会躺进缓存 100 分钟，期间每次刷新都注入它。
 * 所以抽成纯函数，让"删掉守卫"这件事能被测试打红。
 *
 * ⚠️ 反例验证：把 `shouldWritePgcCache` 改成恒返回 `true`，本组第 1、2 条必红。
 */
describe('shouldWritePgcCache：写入侧决策', () => {
  it('① 截断流（真机那份坏数据）→ 不写', () => {
    expect(
      shouldWritePgcCache({
        timelength: 1166528,
        quality: 80,
        durl: [{ length: 180160 }],
      }),
    ).toBe(false);
  });

  it('② 试看 dash（180s vs 19 分钟）→ 不写', () => {
    expect(
      shouldWritePgcCache({
        timelength: 1166528,
        dash: { duration: 180, video: [{ height: 1080 }] },
      }),
    ).toBe(false);
  });

  it('③ 完整 dash → 写', () => {
    expect(
      shouldWritePgcCache({
        timelength: 1166528,
        dash: { duration: 1166, video: [{ height: 2160 }] },
      }),
    ).toBe(true);
  });

  it('④ 完整单段 durl（length = timelength）→ 写（防误杀）', () => {
    expect(
      shouldWritePgcCache({
        timelength: 1440000,
        durl: [{ length: 1440000 }],
      }),
    ).toBe(true);
  });

  it('⑤ null / 非对象 → 不写（宁可少写，不可写错）', () => {
    /**
     * `mergeVideoInfo` 返回 null 时本来就不该走到这里；万一走到了，
     * "不写"是安全方向 —— 空对象写进缓存等于让下一趟注入一个空流。
     */
    expect(shouldWritePgcCache(null)).toBe(false);
    expect(shouldWritePgcCache(undefined)).toBe(false);
    expect(shouldWritePgcCache('x')).toBe(false);
  });

  it('⑥ 只有 timelength、没有流字段 → 写（判不了就放行，交给上游把关）', () => {
    /**
     * 与 `isVideoInfoTruncated` 的方向一致：判不出来时不要自作主张拒绝。
     * 真正保证"有流"的是 `mergeVideoInfo` 的 `hasStreamField`（它在更上游）。
     */
    expect(shouldWritePgcCache({ timelength: 1166528 })).toBe(true);
  });
});

/**
 * `isSyncCacheUsable`：`sessionStorage` 里那份原文能不能当"有缓存"用（2026-10-29）。
 *
 * ## 为什么这条必须存在
 *
 * 原来的判据是 `!!sessionStorage.getItem(key)` —— 只问键在不在。
 * 真机踩到「键在但内容是坏数据」：`hadSync = true` → 不刷新；
 * 而主世界读它时被自己的校验拒了 → setter 位置没数据 → 只能等 cfg 补注入（晚 1450ms）
 * → 播放器早已用 SSR 的 180 秒流起播 → **永远 180 秒**。
 *
 * 校验逻辑抽成纯函数就是为了这条测试 —— `entrypoints/content.ts` 是 WXT 入口，
 * 零单测覆盖，写在调用处等于没有守卫。
 */
describe('isSyncCacheUsable：同步缓存的原文可用性', () => {
  /** 真机抓到的那份坏数据：1 段 180 秒 durl，却配 19 分钟的 timelength */
  const BAD_RAW = JSON.stringify({
    vi: {
      type: 3,
      format: 'flv',
      quality: 80,
      timelength: 1166528,
      durl: [{ order: 1, length: 180160, url: 'https://example.invalid/x.mp4' }],
    },
    exp: Date.now() + 3_600_000,
  });

  /** 完整流：dash 时长与 timelength 一致 */
  const GOOD_DASH_RAW = JSON.stringify({
    vi: {
      quality: 120,
      timelength: 1166528,
      dash: { duration: 1167, video: [{ id: 120, height: 2160, base_url: 'a' }] },
    },
    exp: Date.now() + 3_600_000,
  });

  /** 完整流但走纯 durl（fnval=0 老路）：单段长度 ≈ timelength */
  const GOOD_DURL_RAW = JSON.stringify({
    vi: { quality: 80, timelength: 1166528, durl: [{ order: 1, length: 1166500 }] },
    exp: Date.now() + 3_600_000,
  });

  it('★ 键不存在 → 不可用', () => {
    expect(isSyncCacheUsable(null)).toBe(false);
    expect(isSyncCacheUsable('')).toBe(false);
  });

  it('★ 真机那份坏数据（180 秒 durl + 19 分钟 timelength）→ 不可用（本修复的核心）', () => {
    expect(isSyncCacheUsable(BAD_RAW)).toBe(false);
  });

  it('完整 dash → 可用（不许误杀）', () => {
    expect(isSyncCacheUsable(GOOD_DASH_RAW)).toBe(true);
  });

  it('完整单段 durl（len ≈ timelength）→ 可用（不许误杀）', () => {
    expect(isSyncCacheUsable(GOOD_DURL_RAW)).toBe(true);
  });

  it('坏 JSON → 不可用（宁可多刷一次，也不拿坏数据去注入）', () => {
    expect(isSyncCacheUsable('{not json')).toBe(false);
    expect(isSyncCacheUsable('null')).toBe(false);
    expect(isSyncCacheUsable('[]')).toBe(false);
  });

  it('缺 vi 字段 → 不可用', () => {
    expect(isSyncCacheUsable(JSON.stringify({ exp: Date.now() }))).toBe(false);
  });

  it('vi 不是对象 → 不可用', () => {
    expect(isSyncCacheUsable(JSON.stringify({ vi: 'oops' }))).toBe(false);
  });
});
