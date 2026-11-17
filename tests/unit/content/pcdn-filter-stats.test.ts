/**
 * 候选过滤的**统计与导出**（ADR 0038，2026-11-20 接线）。
 *
 * ## 这个文件守什么
 *
 * 过滤本身在主世界（`pcdn-filter-wiring.test.ts` 守那里）。这里守的是**另一半**：
 * 用户在诊断页导出的那份 JSON 里，能不能看出"开关开着却什么都没做"。
 *
 * 那正是本功能最危险的失败形态 —— 过滤没生效时**界面上一切正常**，
 * 只有导出的 `filter` 字段能说出真相：
 *
 * | 导出值 | 读法 |
 * | --- | --- |
 * | `applied: true` | 真的删过候选 |
 * | `applied: false` + `reason: 'off'` | 用户没开开关（默认状态） |
 * | `applied: false` + `reason: 'rulesMissing'` | **开关开着，但判据规则没下发** |
 * | `applied: false` + 无 reason | 开关开着、规则也在，就是这次没有 PCDN 候选 |
 *
 * 四种要分得开。合成一个布尔就分不清"没开"和"坏了"。
 *
 * ## ⚠️ 这里不许有"空转"的断言（2026-11-20 自查出来的坑）
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

beforeEach(() => {
  // 模块级 state 在同一个进程里共享（`notePcdnFilter` 写的就是它），每条用例前清空
  resetLoadingTrace();
});

describe('采集侧：累加、`applied` 粘性、reason 的生命周期', () => {
  it('★ 初始状态：`applied: false` 且两个计数**保持 0**', () => {
    /**
     * "`applied=false` 时计数必须是 0"的机器证明。
     * 写成 `null` 会被读成"这个字段不存在（旧版本）"，而 0 是"确实剔了 0 条"——
     * 两者含义不同，`reason` 负责说清是哪一种。
     */
    const state = createTraceState();
    expect(state.filter).toEqual({ applied: false, removed: 0, keptIntact: 0 });

    const lite = snapshotOf(state, null);
    expect(lite.filter).toEqual({ applied: false, removed: 0, keptIntact: 0 });
  });

  it('★ 三处调用点各自上报 → **累加**而不是覆盖', () => {
    /**
     * 一次播放里三处都可能过滤（playurl / 整页注入 / 切集换流）。
     * 覆盖会让"整页注入删了 3 条、切集又删了 2 条"只剩最后那条 ——
     * 而导出正是用来回答"这次到底删了几条"的。
     */
    const state = createTraceState();
    recordPcdnFilter(state, { applied: true, removed: 3, keptIntact: 0 });
    recordPcdnFilter(state, { applied: true, removed: 2, keptIntact: 1 });

    expect(state.filter.applied).toBe(true);
    expect(state.filter.removed).toBe(5);
    expect(state.filter.keptIntact).toBe(1);
  });

  it('★ `rulesMissing` 之后真的过滤过一次 → reason 必须消失（不许自相矛盾）', () => {
    /**
     * 现实时序：开关开着、规则还没到 → 报 `rulesMissing`；规则到了 → 真剔了候选。
     * 若不清掉 reason，导出里会出现「`applied: true` + `reason: 'rulesMissing'`」，
     * 读的人会去查一个**已经不存在**的问题。
     */
    const state = createTraceState();
    recordPcdnFilter(state, { applied: false, removed: 0, keptIntact: 0, reason: 'rulesMissing' });
    expect(state.filter.reason).toBe('rulesMissing');

    recordPcdnFilter(state, { applied: true, removed: 1, keptIntact: 0 });
    expect(state.filter.applied).toBe(true);
    expect(state.filter).not.toHaveProperty('reason');
  });

  it('非法计数（负 / `NaN` / 非数字）一律收敛成 0', () => {
    /**
     * 消息来自**页面**（主世界），形状可以伪造。负数和 `NaN` 一旦进到快照，
     * 导出里就会出现 `-3` 这种"看起来像统计口径问题"的数字，比缺字段更误导。
     */
    const state = createTraceState();
    recordPcdnFilter(state, { applied: false, removed: -5, keptIntact: Number.NaN });
    expect(state.filter.removed).toBe(0);
    expect(state.filter.keptIntact).toBe(0);
  });

  it('★ 模块级入口：`notePcdnFilter` 真的写进了当前快照（不是走空）', () => {
    notePcdnFilter({ applied: true, removed: 6, keptIntact: 1 });

    const lite = getLoadingSnapshot();
    expect(lite.filter).toEqual({ applied: true, removed: 6, keptIntact: 1 });
  });

  it('★ 模块级入口：开关关着 → `reason: off`，且计数仍为 0', () => {
    notePcdnFilterOff();

    const lite = getLoadingSnapshot();
    expect(lite.filter).toEqual({ applied: false, removed: 0, keptIntact: 0, reason: 'off' });
  });

  it('★ 已经过滤过之后再关开关 → 不把 applied 抹回去（这一次页面确实过滤过）', () => {
    /**
     * 用户看了一会儿才关掉开关。`notePcdnFilterOff()` 不许把已有的事实
     * 改写成"没生效"—— 那会让导出说"开关关着"而实际删过 4 条候选。
     */
    notePcdnFilter({ applied: true, removed: 4, keptIntact: 0 });
    notePcdnFilterOff();

    const lite = getLoadingSnapshot();
    expect(lite.filter).toMatchObject({ applied: true, removed: 4, keptIntact: 0 });
    expect(lite.filter).not.toHaveProperty('reason');
  });
});

describe('导出侧：`filter` 字段的四种读法', () => {
  it('★ 快照里带 `filter` → 原样进导出', () => {
    const out = exportOf(snapshotWith({ applied: true, removed: 7, keptIntact: 2 }));
    expect(out.filter).toEqual({ applied: true, removed: 7, keptIntact: 2 });
  });

  it('★ `reason` 只在真有的时候出现（不写 `undefined` 键）', () => {
    const off = exportOf(
      snapshotWith({ applied: false, removed: 0, keptIntact: 0, reason: 'off' }),
    );
    expect(off.filter.reason).toBe('off');

    const none = exportOf(snapshotWith({ applied: false, removed: 0, keptIntact: 0 }));
    expect(Object.keys(none.filter)).toEqual(['applied', 'removed', 'keptIntact']);
  });

  it('★ 快照里**没有** `filter`（老采集器 / 手工 fixture）→ 全 0，且不编 reason', () => {
    /**
     * 没有观测就不能断言"用户关了开关" —— 那是**具体事实**，不是兜底值。
     */
    const out = exportOf(snapshotWith());
    expect(out.filter).toEqual({ applied: false, removed: 0, keptIntact: 0 });
  });

  it('`absent` / `unanswered` → 同样是全 0，不崩', () => {
    expect(buildLoadingExport({ kind: 'absent' }).filter).toEqual({
      applied: false,
      removed: 0,
      keptIntact: 0,
    });
    expect(buildLoadingExport({ kind: 'unanswered' }).filter).toEqual({
      applied: false,
      removed: 0,
      keptIntact: 0,
    });
  });

  it('★ 导出的 JSON 里 `filter` 是对象、不是 `null`（消费方不必判空）', () => {
    const text = JSON.stringify(exportOf(snapshotWith()));
    expect(text).toContain('"filter":{');
    expect(text).not.toContain('"filter":null');
  });

  it('★ 快照里的计数被改坏（负值 / `NaN`）也不会让导出出现负数', () => {
    /**
     * 防御方向：即使上游给了一份脏数据，导出也不许把 `-3` 这种数字交给用户 ——
     * 它会让人以为"剔了负数条"，比缺字段更误导。
     */
    const out = exportOf(snapshotWith({ applied: false, removed: -3, keptIntact: Number.NaN }));
    expect(out.filter.removed).toBe(0);
    expect(out.filter.keptIntact).toBe(0);
  });

  it('★ 端到端：上报 → 快照 → 导出，三处调用点的数加得起来', () => {
    /**
     * 这条把「主世界报 → 采集累加 → 导出可见」串成一条线，
     * 而它正是用户排查"开关开了没效果"时唯一能看的东西。
     */
    notePcdnFilter({ applied: true, removed: 2, keptIntact: 0 });
    notePcdnFilter({ applied: true, removed: 1, keptIntact: 1 });

    const out = exportOf(getLoadingSnapshot());
    expect(out.filter).toEqual({ applied: true, removed: 3, keptIntact: 1 });
  });
});
