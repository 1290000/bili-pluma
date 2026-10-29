/**
 * PGC 时长 / SSR 取数纯判据的测试（S3.3）
 *
 * 这两个函数原先在 `entrypoints/content.ts` 里，**零测试**。
 * 下沉到 `core/playinfo/` 后才第一次可测。
 *
 * 它们判错会让 PGC 换流走错分支：
 *   - `readSsrVideoInfo` 取不到 → 判成"没有 SSR 基线"
 *   - `expectedDurationMs` 取错 → 截断判据整体偏掉
 */
import { describe, expect, it } from 'vitest';

import { expectedDurationMs, readSsrVideoInfo } from '@core/playinfo/pgc-duration';

describe('readSsrVideoInfo（S3.3 下沉后新增覆盖）', () => {
  it('整页形状：取 result.video_info', () => {
    const vi = { dash: { duration: 1200 } };
    expect(readSsrVideoInfo({ result: { video_info: vi } })).toBe(vi);
  });

  it('嵌套形状：取 data.result.video_info（SPA 切集会这样）', () => {
    const vi = { dash: { duration: 1200 } };
    expect(readSsrVideoInfo({ data: { result: { video_info: vi } } })).toBe(vi);
  });

  it('两种形状都不满足时返回 null', () => {
    expect(readSsrVideoInfo({})).toBeNull();
    expect(readSsrVideoInfo({ result: {} })).toBeNull();
  });

  it('输入非法时返回 null，不抛', () => {
    expect(readSsrVideoInfo(null)).toBeNull();
    expect(readSsrVideoInfo(undefined)).toBeNull();
    expect(readSsrVideoInfo(42)).toBeNull();
    expect(readSsrVideoInfo('str')).toBeNull();
  });

  it('video_info 为 null 时返回 null（不返回 undefined）', () => {
    expect(readSsrVideoInfo({ result: { video_info: null } })).toBeNull();
  });
});

describe('expectedDurationMs（S3.3 下沉后新增覆盖）', () => {
  it('正常取 timelength', () => {
    expect(expectedDurationMs({ timelength: 1200000 })).toBe(1200000);
  });

  it('字段是 duration 时取不到（dash.duration 是另一回事）', () => {
    // 防"把 dash.duration 误当 timelength"——两者单位都不同
    expect(expectedDurationMs({ duration: 1200 })).toBe(0);
  });

  it('缺失 / 非数字 / 非正数一律返回 0（= 不知道）', () => {
    expect(expectedDurationMs({})).toBe(0);
    expect(expectedDurationMs({ timelength: '1200' })).toBe(0);
    expect(expectedDurationMs({ timelength: 0 })).toBe(0);
    expect(expectedDurationMs({ timelength: -5 })).toBe(0);
    expect(expectedDurationMs({ timelength: NaN })).toBe(0);
  });

  it('输入非法时返回 0，不抛', () => {
    expect(expectedDurationMs(null)).toBe(0);
    expect(expectedDurationMs(undefined)).toBe(0);
    expect(expectedDurationMs(42)).toBe(0);
  });
});
