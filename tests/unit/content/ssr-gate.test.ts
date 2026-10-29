/**
 * `ssr-playinfo` 门控链的测试（S3.4）
 *
 * ## 为什么这个测试值得存在
 *
 * 原来这 5 层判定是 357 行大函数里连着 5 个 `return`，**没有任何测试**。
 * 2026-10-28 真机坑：`cacheBytes=0`、`lastStage='boot'`，诊断页里
 * **一行 PGC 日志都没有** —— 无法判断是"消息没到"还是"到了但判定没过"。
 *
 * 现在每层退出都有名字，可以逐个断言。
 *
 * ## 最要紧的一条
 *
 * "先重置、再判 alreadyTried" 的顺序 —— 写反会让 **SPA 切集后的新集永远不走取流**。
 */
import { describe, expect, it } from 'vitest';

import {
  describeSsrGate,
  gateSsrPlayinfo,
  type SsrGateInput,
} from '@/src/content/isolated/ssr-gate';

function input(over: Partial<SsrGateInput> = {}): SsrGateInput {
  return {
    pageKind: 'pgc',
    cid: '123456789',
    handledCid: '',
    alreadyTried: false,
    ...over,
  };
}

describe('gateSsrPlayinfo（S3.4 下沉后新增覆盖）', () => {
  describe('通过路径', () => {
    it('PGC 页 + 有 cid + 没试过 → proceed', () => {
      expect(gateSsrPlayinfo(input())).toEqual({ kind: 'proceed', cid: '123456789' });
    });
  });

  describe('第 1 层：页面类型', () => {
    it('不是 PGC 页 → not-pgc', () => {
      expect(gateSsrPlayinfo(input({ pageKind: 'video' }))).toEqual({
        kind: 'skip',
        reason: 'not-pgc',
      });
    });

    it('页面判不出来（null）→ not-pgc', () => {
      expect(gateSsrPlayinfo(input({ pageKind: null }))).toEqual({
        kind: 'skip',
        reason: 'not-pgc',
      });
    });

    it('非 PGC 页优先于 cid 判定（先判页面，不先读 cid）', () => {
      // 即便 cid 也没有，报的也该是 not-pgc —— 顺序不能换
      expect(gateSsrPlayinfo(input({ pageKind: 'video', cid: null }))).toEqual({
        kind: 'skip',
        reason: 'not-pgc',
      });
    });
  });

  describe('第 2 层：cid', () => {
    it('读不出 cid → no-cid', () => {
      expect(gateSsrPlayinfo(input({ cid: null }))).toEqual({ kind: 'skip', reason: 'no-cid' });
    });
  });

  describe('第 3/4 层：alreadyTried 与 SPA 切集', () => {
    it('同一个 cid 已试过 → already-tried（防重复取流）', () => {
      expect(gateSsrPlayinfo(input({ cid: '999', handledCid: '999', alreadyTried: true }))).toEqual(
        { kind: 'skip', reason: 'already-tried' },
      );
    });

    it('**cid 变了 → 重置 alreadyTried，新集重新走流程**', () => {
      /**
       * 这是最关键的一条。2026-10-28 真机踩到：
       * 点「第 8 集」后 URL 变了，但 `pgcCacheTried` 还是 true，
       * 新集永远不走取流 → 用上一集的 360 秒流播新集，6 分 01 秒撞墙。
       *
       * 重置逻辑必须发生在 alreadyTried 判断**之前**。
       */
      expect(gateSsrPlayinfo(input({ cid: '888', handledCid: '999', alreadyTried: true }))).toEqual(
        { kind: 'proceed', cid: '888' },
      );
    });

    it('顺序验证：重置必须先于 alreadyTried 判断', () => {
      /**
       * 若有人把顺序写反（先判 alreadyTried 再重置），
       * 上面那条会变成 skip —— 这个测试同时钉住顺序本身。
       */
      const sameCid = gateSsrPlayinfo(input({ cid: 'A', handledCid: 'B', alreadyTried: true }));
      const diffCid = gateSsrPlayinfo(input({ cid: 'B', handledCid: 'A', alreadyTried: true }));

      expect(sameCid.kind).toBe('proceed');
      expect(diffCid.kind).toBe('proceed');
    });

    it('首次上报（handledCid 为空）不算重复', () => {
      expect(gateSsrPlayinfo(input({ handledCid: '', alreadyTried: false }))).toEqual({
        kind: 'proceed',
        cid: '123456789',
      });
    });
  });

  describe('诊断文案：每层退出都有名字', () => {
    it('proceed 与三种 skip 各有不同文案', () => {
      const texts = [
        describeSsrGate({ kind: 'proceed', cid: '1' }),
        describeSsrGate({ kind: 'skip', reason: 'not-pgc' }),
        describeSsrGate({ kind: 'skip', reason: 'no-cid' }),
        describeSsrGate({ kind: 'skip', reason: 'already-tried' }),
      ];

      // 全部非空，且互不相同 —— 否则日志里分不清是哪一层退出的
      texts.forEach((t) => expect(t.length).toBeGreaterThan(0));
      expect(new Set(texts).size).toBe(4);
    });
  });
});
