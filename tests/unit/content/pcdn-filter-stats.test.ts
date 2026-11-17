/**
 * 候选改写的**统计与导出**（ADR 0039）。
 *
 * ## 这个文件守什么
 *
 * 改写本身在主世界（`pcdn-filter-wiring.test.ts` 守那里）。这里守的是**另一半**：
 * 用户在诊断页导出的那份 JSON 里，能不能看出"开关开着却什么都没做"。
 *
 * 那正是本功能最危险的失败形态 —— 改写没生效时**界面上一切正常**，
 * 只有导出的 `filter` 字段能说出真相：
 *
 * | 导出值 | 读法 |
 * | --- | --- |
 * | `applied: true` | 真的换过至少一条候选的 authority |
 * | `applied: false` + `reason: 'off'` | 用户没开开关（默认状态） |
 * | `applied: false` + `reason: 'rulesMissing'` | **开关开着，但判据/镜像清单没下发** |
 * | `applied: false` + 无 reason | 开关开着、规则也在，就是这次没有 PCDN 候选 |
 *
 * 四种要分得开。合成一个布尔就分不清"没开"和"坏了"。
 *
 * ## ⚠️ 这里不许有"空转"的断言（2026-11-17 自查出来的坑）
 *
 * 本项目已经踩过「覆盖了但测的是空气」：遍历一个**恒为空**的数组再逐条断言，
 * 循环跑 0 次，测试绿。所以每条断言都指着一个**具体的非空**对象。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { buildLoadingExport } from '../../../src/content/panel/diagnostics';
import {
  createTraceState,
  getLoadingSnapshot,
  notePcdnFilter,
  notePcdnFilterOff,
  recordPcdnFilter,
  resetLoadingTrace,
  snapshotOf,
  type LoadingSnapshotLite,
} from '../../../src/content/isolated/loading-trace';

/** 造一份最小可用的快照（只填导出必需的字段） */
function snapshotWith(filter?: LoadingSnapshotLite['filter']): LoadingSnapshotLite {
  return {
    present: true,
    confidence: 'measured',
    actual: { host: 'a.bilivideo.com', cls: 'official', flavor: null },
    hosts: [{ host: 'a.bilivideo.com', cls: 'official', flavor: null, count: 3 }],
    events: [],
    truncated: false,
    video: null,
    ...(filter === undefined ? {} : { filter }),
  };
}

/** 把快照包成 `buildLoadingExport()` 要的 outcome */
function exportOf(snapshot: LoadingSnapshotLite) {
  return buildLoadingExport({ kind: 'ok', snapshot });
}

/** 一组非空的三计数，避免每条用例都手抄三个 0 */
const ZERO = { rewritten: 0, proxied: 0, fallbackKept: 0 } as const;

beforeEach(() => {
  // 模块级 state 在同一个进程里共享（`notePcdnFilter` 写的就是它），每条用例前清空
  resetLoadingTrace();
});

describe('采集侧：累加、`applied` 粘性、reason 的生命周期', () => {
  it('★ 初始状态：`applied: false` 且三个计数**保持 0**', () => {
    const state = createTraceState();
    expect(state.filter).toEqual({ applied: false, ...ZERO });

    const lite = snapshotOf(state, null);
    expect(lite.filter).toEqual({ applied: false, ...ZERO });
  });

  it('★ 三处调用点各自上报 → **累加**而不是覆盖', () => {
    const state = createTraceState();
    recordPcdnFilter(state, { applied: true, rewritten: 3, proxied: 1, fallbackKept: 0 });
    recordPcdnFilter(state, { applied: true, rewritten: 2, proxied: 0, fallbackKept: 1 });

    expect(state.filter.applied).toBe(true);
    expect(state.filter.rewritten).toBe(5);
    expect(state.filter.proxied).toBe(1);
    expect(state.filter.fallbackKept).toBe(1);
  });

  it('★ `rulesMissing` 之后真的改写过一次 → reason 必须消失（不许自相矛盾）', () => {
    const state = createTraceState();
    recordPcdnFilter(state, { applied: false, ...ZERO, reason: 'rulesMissing' });
    expect(state.filter.reason).toBe('rulesMissing');

    recordPcdnFilter(state, { applied: true, rewritten: 1, proxied: 0, fallbackKept: 0 });
    expect(state.filter.applied).toBe(true);
    expect(state.filter).not.toHaveProperty('reason');
  });

  it('非法计数（负 / `NaN` / 非数字）一律收敛成 0', () => {
    const state = createTraceState();
    recordPcdnFilter(state, {
      applied: false,
      rewritten: -5,
      proxied: Number.NaN,
      fallbackKept: -1,
    });
    expect(state.filter.rewritten).toBe(0);
    expect(state.filter.proxied).toBe(0);
    expect(state.filter.fallbackKept).toBe(0);
  });

  it('★ 模块级入口：`notePcdnFilter` 真的写进了当前快照（不是走空）', () => {
    notePcdnFilter({ applied: true, rewritten: 6, proxied: 2, fallbackKept: 1 });

    const lite = getLoadingSnapshot();
    expect(lite.filter).toEqual({ applied: true, rewritten: 6, proxied: 2, fallbackKept: 1 });
  });

  it('★ 模块级入口：开关关着 → `reason: off`，且计数仍为 0', () => {
    notePcdnFilterOff();

    const lite = getLoadingSnapshot();
    expect(lite.filter).toEqual({ applied: false, ...ZERO, reason: 'off' });
  });

  it('★ 已经改写过之后再关开关 → 不把 applied 抹回去（这一次页面确实改过）', () => {
    notePcdnFilter({ applied: true, rewritten: 4, proxied: 0, fallbackKept: 0 });
    notePcdnFilterOff();

    const lite = getLoadingSnapshot();
    expect(lite.filter).toMatchObject({ applied: true, rewritten: 4, fallbackKept: 0 });
    expect(lite.filter).not.toHaveProperty('reason');
  });
});

describe('导出侧：`filter` 字段的四种读法', () => {
  it('★ 快照里带 `filter` → 原样进导出', () => {
    const out = exportOf(
      snapshotWith({ applied: true, rewritten: 7, proxied: 3, fallbackKept: 2 }),
    );
    expect(out.filter).toEqual({ applied: true, rewritten: 7, proxied: 3, fallbackKept: 2 });
  });

  it('★ `reason` 只在真有的时候出现（不写 `undefined` 键）', () => {
    const off = exportOf(snapshotWith({ applied: false, ...ZERO, reason: 'off' }));
    expect(off.filter.reason).toBe('off');

    const none = exportOf(snapshotWith({ applied: false, ...ZERO }));
    expect(Object.keys(none.filter)).toEqual([
      'applied',
      'rewritten',
      'proxied',
      'fallbackKept',
    ]);
  });

  it('★ 快照里**没有** `filter`（老采集器 / 手工 fixture）→ 全 0，且不编 reason', () => {
    const out = exportOf(snapshotWith());
    expect(out.filter).toEqual({ applied: false, ...ZERO });
  });

  it('`absent` / `unanswered` → 同样是全 0，不崩', () => {
    expect(buildLoadingExport({ kind: 'absent' }).filter).toEqual({
      applied: false,
      ...ZERO,
    });
    expect(buildLoadingExport({ kind: 'unanswered' }).filter).toEqual({
      applied: false,
      ...ZERO,
    });
  });

  it('★ 导出的 JSON 里 `filter` 是对象、不是 `null`（消费方不必判空）', () => {
    const text = JSON.stringify(exportOf(snapshotWith()));
    expect(text).toContain('"filter":{');
    expect(text).not.toContain('"filter":null');
  });

  it('★ 快照里的计数被改坏（负值 / `NaN`）也不会让导出出现负数', () => {
    const out = exportOf(
      snapshotWith({ applied: false, rewritten: -3, proxied: Number.NaN, fallbackKept: -1 }),
    );
    expect(out.filter.rewritten).toBe(0);
    expect(out.filter.proxied).toBe(0);
    expect(out.filter.fallbackKept).toBe(0);
  });

  it('★ 端到端：上报 → 快照 → 导出，三处调用点的数加得起来', () => {
    notePcdnFilter({ applied: true, rewritten: 2, proxied: 1, fallbackKept: 0 });
    notePcdnFilter({ applied: true, rewritten: 1, proxied: 0, fallbackKept: 1 });

    const out = exportOf(getLoadingSnapshot());
    expect(out.filter).toEqual({ applied: true, rewritten: 3, proxied: 1, fallbackKept: 1 });
  });
});
