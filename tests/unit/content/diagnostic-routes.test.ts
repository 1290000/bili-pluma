/**
 * 诊断路由表的测试（S3.4）
 *
 * 守三件事：
 *   1. 六条诊断消息都能被路由到（加新消息时忘了登记会红）
 *   2. **有状态写入的消息不许进表**（表的前提是"纯诊断"）
 *   3. 非诊断类型返回 null，让调用方继续走别的分支
 */
import { describe, expect, it } from 'vitest';

import {
  DIAGNOSTIC_ROUTES,
  describeDiagnostic,
  isDiagnosticType,
} from '@/src/content/isolated/diagnostic-routes';

describe('诊断路由表（S3.4 下沉后新增覆盖）', () => {
  describe('六条诊断消息都能路由', () => {
    it('patch / sb-ok / sb-error / codec / req / pgc 全部在内', () => {
      expect(Object.keys(DIAGNOSTIC_ROUTES).sort()).toEqual([
        'codec',
        'patch',
        'pgc',
        'req',
        'sb-error',
        'sb-ok',
      ]);
    });

    it.each([
      ['patch', { path: '/x/vip' }, '已改写会员状态响应: /x/vip'],
      [
        'sb-ok',
        { kind: 'video', mime: 'video/mp4', buffered: 5 },
        '视频轨装载成功: video/mp4 (缓冲 5s)',
      ],
      ['sb-error', { kind: 'audio', mime: 'audio/mp4' }, '音轨装载失败: audio/mp4'],
      ['codec', { kind: 'audio', from: 'sb', mime: 'audio/mp4' }, '音频编码(sb): audio/mp4'],
      [
        'req',
        { method: 'GET', url: 'https://e.com/p?cid=1' },
        'playurl 请求出现: GET https://e.com/p',
      ],
      ['pgc', { stage: 'cfg', detail: 'ok' }, '[PGC] cfg ok'],
    ])('%s 产出正确文案', (type, payload, expected) => {
      expect(describeDiagnostic({ type, ...payload })).toBe(expected);
    });
  });

  describe('有状态写入的消息不许进表', () => {
    /**
     * 这条是表的前提。`ssr-playinfo` 写 pageState、`hdr` 写 badgeState、
     * `playurl-tracks` 写 badgeState —— 它们一旦混进来，
     * "这张表只管纯诊断"的承诺就破了，后续改动会重新变得不可预测。
     */
    it.each([
      'hello',
      'ready',
      'ssr-playinfo',
      'playurl-raw',
      'pgc-playview-stream',
      'playurl-tracks',
      'hdr',
    ])('%s 不在诊断表里', (type) => {
      expect(isDiagnosticType(type)).toBe(false);
      expect(describeDiagnostic({ type })).toBeNull();
    });
  });

  describe('非诊断类型返回 null（让调用方继续走别的分支）', () => {
    it('未知类型', () => {
      expect(isDiagnosticType('nope')).toBe(false);
      expect(describeDiagnostic({ type: 'nope' })).toBeNull();
    });

    it('type 缺失或非字符串', () => {
      expect(isDiagnosticType(undefined)).toBe(false);
      expect(describeDiagnostic({})).toBeNull();
    });

    it('原型链上的键不算（Object.hasOwn 而非 in）', () => {
      // 用 `in` 的话 'toString' 会被判成诊断类型
      expect(isDiagnosticType('toString')).toBe(false);
      expect(isDiagnosticType('constructor')).toBe(false);
    });
  });
});
