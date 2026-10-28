import { describe, expect, it } from 'vitest';

import {
  isPreviewSsr,
  isStreamTruncated,
  readCidFromSsr,
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
