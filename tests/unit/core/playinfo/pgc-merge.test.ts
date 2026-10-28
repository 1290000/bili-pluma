import { describe, expect, it } from 'vitest';

import {
  STREAM_FIELDS,
  hasPlayableStream,
  mergeVideoInfo,
  pickSsrResult,
} from '@core/playinfo/pgc-merge';

/**
 * P2 路线的核心合并逻辑。
 *
 * 这组测试守的是**一个已经踩过的坑**：接口与 SSR 的 `result` 形状不同，
 * 直接替换会让播放器黑屏且不报错（2026-10-27 实测，`poc/verify/poc-pgc-inject.cjs`）。
 */

const SSR_VIDEO_INFO = {
  is_preview: true,
  type: 3,
  format: 'mp4',
  quality: 80,
  timelength: 1440083,
  durls: [{ quality: 80, durl: [{ length: 360082, url: 'https://ssr.example/preview.m4s' }] }],
  play_check: 'PLAY_PREVIEW',
};

const API_RESULT = {
  quality: 120,
  timelength: 1440083,
  format: 'flv720',
  dash: {
    duration: 1441,
    video: [{ id: 80, height: 1080, codecid: 12, base_url: 'https://api.example/v.m4s' }],
    audio: [{ id: 30232, base_url: 'https://api.example/a.m4s' }],
  },
  accept_quality: [120, 112, 80],
  accept_description: ['超清 4K', '高清 1080P+', '高清 1080P'],
};

describe('pickSsrResult', () => {
  it('playurlSSRData.data 外壳（{code,message,ttl,result}）', () => {
    const got = pickSsrResult({ code: 0, result: { arc: { cid: 1 } } });
    expect(got).toEqual({ arc: { cid: 1 } });
  });

  it('外面还包了一层 data 也认', () => {
    const got = pickSsrResult({ data: { code: 0, result: { arc: { cid: 2 } } } });
    expect(got).toEqual({ arc: { cid: 2 } });
  });

  it('形状不对返回 null', () => {
    expect(pickSsrResult(null)).toBeNull();
    expect(pickSsrResult('x')).toBeNull();
    expect(pickSsrResult({})).toBeNull();
  });
});

describe('mergeVideoInfo：以 SSR 为骨架', () => {
  it('SSR 的 is_preview / type / play_check 必须保留（不改权益字段）', () => {
    const got = mergeVideoInfo(SSR_VIDEO_INFO, API_RESULT);
    expect(got).not.toBeNull();
    // ⚠️ 这三条是最容易被"顺手改掉"的 —— 改它们等于伪装成有权益
    expect(got?.is_preview).toBe(true);
    expect(got?.play_check).toBe('PLAY_PREVIEW');
    expect(got?.type).toBe(3);
  });

  it('有 dash 时 **durl / durls 必须被删掉**（播放器优先走 durl）', () => {
    const got = mergeVideoInfo(SSR_VIDEO_INFO, API_RESULT);
    expect(got?.dash).toEqual(API_RESULT.dash);
    expect(got?.quality).toBe(120);

    /**
     * 2026-10-28 真机定位：注入后 `dash.duration = 1441` 是对的，但
     * `<video>.duration` 仍是 360、`currentSrc` 指向 **durl** 的地址、
     * `currentTime=600` 被夹回 360。
     *
     * → 播放器在 `durl` 存在时优先走 durl，SSR 那份 360 秒的试看 durl 一直在，
     *   注入的 dash 从没被用过。所以必须抹掉 durl。
     */
    expect(got).not.toHaveProperty('durl');
    expect(got).not.toHaveProperty('durls');
  });

  it('没有 dash 时保留 durl（缓存里只有 durl 的场景）', () => {
    const got = mergeVideoInfo(
      { is_preview: true, durls: [{ durl: [{ url: 'ssr-preview' }] }] },
      { durls: [{ durl: [{ url: 'full-durl' }] }], quality: 80 },
    );
    expect(got).not.toBeNull();
    expect((got?.durls as unknown[]).length).toBe(1);
    expect(JSON.stringify(got?.durls)).toContain('full-durl');
  });

  it('不修改入参（返回新对象）', () => {
    const before = JSON.stringify(SSR_VIDEO_INFO);
    mergeVideoInfo(SSR_VIDEO_INFO, API_RESULT);
    expect(JSON.stringify(SSR_VIDEO_INFO)).toBe(before);
  });

  it('接口给空数组不覆盖；且因为最终有 dash，durls 会被删掉', () => {
    // 保留 dash、只把 durls 换成空数组：这份响应仍然"有流"（走 dash），所以会合并
    const got = mergeVideoInfo(SSR_VIDEO_INFO, { ...API_RESULT, durls: [] });
    expect(got).not.toBeNull();
    // 关键：不会被空数组"覆盖成空"，而是因为走 dash 直接删掉
    expect(got).not.toHaveProperty('durls');
    expect(got?.dash).toEqual(API_RESULT.dash);
  });

  it('接口一个流字段都没有 → 返回 null（调用方不该替换）', () => {
    expect(mergeVideoInfo(SSR_VIDEO_INFO, {})).toBeNull();
    expect(mergeVideoInfo(SSR_VIDEO_INFO, null)).toBeNull();
    expect(mergeVideoInfo(SSR_VIDEO_INFO, { quality: 120 })).toBeNull();
  });

  it('SSR 的 video_info 不是对象时也能合并（不崩）', () => {
    const got = mergeVideoInfo(null, API_RESULT);
    expect(got?.dash).toEqual(API_RESULT.dash);
  });

  it('字段白名单是封闭的 —— 接口里多出来的字段不会被搬进去', () => {
    const got = mergeVideoInfo(SSR_VIDEO_INFO, {
      ...API_RESULT,
      evil_field: 'should-not-leak',
    });
    expect(got).not.toHaveProperty('evil_field');
  });

  it('白名单里的每个字段都能被搬', () => {
    const all: Record<string, unknown> = {};
    for (const k of STREAM_FIELDS) all[k] = 'v-' + k;
    // durl 用非空数组，否则会被"空数组不覆盖"规则挡掉
    all.durl = [{ url: 'x' }];
    const got = mergeVideoInfo({ is_preview: true }, all);
    for (const k of STREAM_FIELDS) expect(got?.[k]).toBe(all[k]);
  });
});

describe('hasPlayableStream：只看流，不看别的字段', () => {
  it('有 dash.video 算有流', () => {
    expect(hasPlayableStream(API_RESULT)).toBe(true);
  });

  it('有 durl 算有流', () => {
    expect(hasPlayableStream({ durl: [{ url: 'x' }] })).toBe(true);
  });

  it('有 durls[0].durl 算有流', () => {
    expect(hasPlayableStream({ durls: [{ durl: [{ url: 'x' }] }] })).toBe(true);
  });

  it('只有 quality / timelength 不算 —— 无权益时它们也有值', () => {
    expect(hasPlayableStream({ quality: 120, timelength: 1440083 })).toBe(false);
  });

  it('空 dash / 空 durls 不算', () => {
    expect(hasPlayableStream({ dash: { video: [] } })).toBe(false);
    expect(hasPlayableStream({ durls: [{ durl: [] }] })).toBe(false);
  });
});
