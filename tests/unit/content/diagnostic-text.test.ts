/**
 * 主世界诊断文案的测试（S3.4）
 *
 * 这些文案不是给用户看的，是**排查时唯一的线索**。
 * 2026-10-28 那次真机坑就是"诊断页一行 PGC 日志都没有" ——
 * 文案里少了 `stage` / `mime` / `path`，那条线索就断了。
 *
 * 抽成纯函数之前，这 6 条分支**没有任何测试**。
 */
import { describe, expect, it } from 'vitest';

import {
  describeCodec,
  describePatch,
  describePgcStage,
  describeRequest,
  describeSourceBuffer,
} from '@/src/content/isolated/diagnostic-text';

describe('诊断文案（S3.4 下沉后新增覆盖）', () => {
  describe('describePatch', () => {
    it('带出被改写的路径', () => {
      expect(describePatch({ path: '/x/vip/webschool' })).toBe(
        '已改写会员状态响应: /x/vip/webschool',
      );
    });

    it('路径缺失时用 ? 占位，不抛', () => {
      expect(describePatch({})).toBe('已改写会员状态响应: ?');
    });
  });

  describe('describeSourceBuffer', () => {
    it('成功时带 mime 与缓冲秒数', () => {
      expect(
        describeSourceBuffer(true, {
          kind: 'video',
          mime: 'video/mp4; codecs="avc1"',
          buffered: 12.7,
        }),
      ).toBe('视频轨装载成功: video/mp4; codecs="avc1" (缓冲 13s)');
    });

    it('buffered 取整（12.7 → 13，不保留小数）', () => {
      expect(describeSourceBuffer(true, { kind: 'video', buffered: 12.7 })).toContain('缓冲 13s');
      expect(describeSourceBuffer(true, { kind: 'video', buffered: 0.4 })).toContain('缓冲 0s');
    });

    it('失败时只说失败，不提缓冲（没有意义）', () => {
      const out = describeSourceBuffer(false, { kind: 'audio', mime: 'audio/mp4' });
      expect(out).toBe('音轨装载失败: audio/mp4');
      expect(out).not.toContain('缓冲');
    });

    it('kind 不是 video 时归为音轨（含 kind 缺失）', () => {
      expect(describeSourceBuffer(true, { kind: 'audio' })).toContain('音轨');
      expect(describeSourceBuffer(true, {})).toContain('音轨');
    });
  });

  describe('describeCodec', () => {
    it('音频与视频分别标出来', () => {
      expect(describeCodec({ kind: 'audio', from: 'sb', mime: 'audio/mp4' })).toBe(
        '音频编码(sb): audio/mp4',
      );
      expect(describeCodec({ kind: 'video', from: 'sb', mime: 'video/mp4' })).toBe(
        '视频编码(sb): video/mp4',
      );
    });

    it('缺失字段用 ? 占位', () => {
      expect(describeCodec({})).toBe('视频编码(?): ?');
    });
  });

  describe('describeRequest', () => {
    it('只保留路径，丢掉 query（日志不该带页面数据）', () => {
      const out = describeRequest({
        method: 'GET',
        url: 'https://api.bilibili.com/x/player/playurl?cid=123&avid=456&qn=80',
      });
      expect(out).toBe('playurl 请求出现: GET https://api.bilibili.com/x/player/playurl');
      expect(out).not.toContain('cid=');
      expect(out).not.toContain('123');
    });

    it('method 缺失时默认 GET', () => {
      expect(describeRequest({ url: 'https://e.com/p' })).toBe(
        'playurl 请求出现: GET https://e.com/p',
      );
    });
  });

  describe('describePgcStage', () => {
    it('带出阶段与细节', () => {
      expect(describePgcStage({ stage: 'patch', detail: 'cid=1 注入成功' })).toBe(
        '[PGC] patch cid=1 注入成功',
      );
    });

    it('末尾不留空白（detail 为空时 trim 掉）', () => {
      expect(describePgcStage({ stage: 'cfg' })).toBe('[PGC] cfg');
    });

    it('阶段缺失用 ? 占位', () => {
      expect(describePgcStage({})).toBe('[PGC] ?');
    });
  });
});
