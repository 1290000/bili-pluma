// @vitest-environment jsdom

/**
 * 加载时间轴的**视图层**（T5）：速览行 + 二级浮层「本次加载」+ 取快照的桥。
 *
 * ## 为什么这个文件必须存在（三条都是"会静默坏掉"的）
 *
 * 1. **`absent` 与 `unanswered` 归并**。两者都表现为"没有数据"，但一个是
 *    事实（非播放页本来就没有），一个是故障（要刷新页面）。归并之后用户
 *    和排查者都分不出来 —— `diagnostics.ts` 的 `logsMeta.ok` 已经踩过一次
 *    （`readDiag()` 的 `catch { return [] }` 把读失败压成了"没有日志"）。
 * 2. **`flavor === null` 时加括号**。分类器认不出是自建还是服务商时不猜
 *    （`cdn/classify.ts` 文件头第 3 条），界面这边不许替它猜 ——
 *    用户会拿这句话去对照播放页右键的「视频统计信息」。
 * 3. **`playing` 缺失时补 0**。"开局 0.0s"是一句看起来像数据的话，
 *    而事实是没测到开始播放（`loading/timeline.ts` 文件头第 3 条：绝不补造）。
 *
 * ## 测不到什么
 *
 * - 颜色与形状**在像素上**对不对（jsdom 没有布局，也没有渲染）。
 *   这里只断言"挂的是哪个色调类名 / 形状是哪个 SVG 元素"，
 *   真的观感靠真机冒烟。
 * - 真机上的整条桥（要两个 content script 实例）。这里用一个
 *   `window.postMessage` 的假 `content.ts` 模拟，与 `panel-page-channel.test.ts`
 *   同一个手法。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLoadingQuick,
  buildTimelineRows,
  clockText,
  describeCounts,
  describeLine,
  describeKindPill,
  describePcdnCaveat,
  describeSnapshotLine,
  FOOTNOTE_TIMEBASE_CLAUSE,
  gapText,
  hostClsOf,
  hostCountText,
  isPlayingWithoutData,
  legendEntries,
  legendHasExtPatch,
  legendKinds,
  loadingDetailPane,
  loadingQuickRow,
  pageOriginAnchor,
  renderedKind,
  stageLabel,
  timelineFootnote,
  TIMELINE_FOOTNOTE,
} from '../../../src/content/panel/loading-pane';
import type { LoadingOutcome } from '../../../src/content/panel/loading-pane';
import {
  buildPanelModel,
  buildQualityView,
  fetchLoadingSnapshot,
  fetchLoadingSnapshotViaPage,
  onLoadingChanged,
} from '../../../src/content/panel/panel-data';
import { qualityTab } from '../../../src/content/panel/tabs';
import type { LoadingSnapshotLite } from '../../../src/content/isolated/loading-trace';
import type { LoadEvent, LoadStage } from '../../../src/core/loading/timeline';

// ─────────────────────────── 真实快照 ───────────────────────────

/**
 * 一份**实测**快照（2026-11-19，12 秒播放，`poc/probe/pcdn-diag` 同源数据）。
 *
 * ⚠️ 不要把它"整理"成更好看的样子：它的价值就在于时间是脏的
 * （`2525.9` / `3270.2` 这种）、`stall` 事件没有 host、
 * 官方线路在两个边缘之间来回。用它断言增量计算，才算真的算过。
 */
function snapshot(overrides: Partial<LoadingSnapshotLite> = {}): LoadingSnapshotLite {
  const events: LoadEvent[] = [
    { t: 1772, stage: 'stall' },
    { t: 2525.9, stage: 'seg-req', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
    { t: 2815.3, stage: 'seg-res', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
    { t: 3268.2, stage: 'canplay' },
    { t: 3270.2, stage: 'playing' },
    { t: 3737.1, stage: 'seg-req', host: 'xy220x180x77x45xy.mcdn.bilivideo.cn', kind: 'pcdn' },
    { t: 3890.1, stage: 'seg-res', host: 'xy220x180x77x45xy.mcdn.bilivideo.cn', kind: 'pcdn' },
    { t: 4164.4, stage: 'seg-req', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
    { t: 4224.6, stage: 'seg-res', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
  ];

  return {
    present: true,
    confidence: 'measured',
    actual: {
      host: 'cn-jsnt-ct-01-07.bilivideo.com',
      cls: 'official',
      flavor: 'self-built',
    },
    hosts: [
      {
        host: 'cn-jsnt-ct-01-07.bilivideo.com',
        cls: 'official',
        flavor: 'self-built',
        count: 12,
      },
      {
        host: 'cn-jsnt-ct-01-06.bilivideo.com',
        cls: 'official',
        flavor: 'self-built',
        count: 11,
      },
      { host: 'xy220x180x77x45xy.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null, count: 1 },
    ],
    events,
    truncated: false,
    video: { readyState: 4, durationSec: 213, height: 360, errorCode: 0 },
    ...overrides,
  };
}

/** 一份 `ok` 结局 */
function ok(overrides: Partial<LoadingSnapshotLite> = {}): LoadingOutcome {
  return { kind: 'ok', snapshot: snapshot(overrides) };
}

// ─────────────────────────── 文案：7 种分支 ───────────────────────────

describe('线路文案：七种情况逐条钉住', () => {
  it('official + self-built → 带（自建 CDN）', () => {
    const line = describeLine({ cls: 'official', flavor: 'self-built' });
    expect(line.title).toBe('B站官方线路（自建 CDN）');
    expect(line.tone).toBe('ok');
    expect(line.marker).toBe('disc');
  });

  it('official + partner → 带（服务商 CDN）', () => {
    expect(describeLine({ cls: 'official', flavor: 'partner' }).title).toBe(
      'B站官方线路（服务商 CDN）',
    );
  });

  it('★ official + flavor null → **不加括号**（分类器认不出，界面不许猜）', () => {
    const line = describeLine({ cls: 'official', flavor: null });
    expect(line.title).toBe('B站官方线路');
    // 反例守卫：任何一个括号字符都算"替分类器下了结论"
    expect(line.title).not.toContain('（');
    expect(line.title).not.toContain(')');
    expect(line.tone).toBe('ok');
  });

  it('pcdn → 第三方加速线路（PCDN），警告色 + 菱形', () => {
    const line = describeLine({ cls: 'pcdn', flavor: null });
    expect(line.title).toBe('第三方加速线路（PCDN）');
    expect(line.tone).toBe('warn');
    expect(line.marker).toBe('diamond');
  });

  it('third-party → 第三方线路，次要文字色 + 三角', () => {
    const line = describeLine({ cls: 'third-party', flavor: null });
    expect(line.title).toBe('第三方线路');
    expect(line.tone).toBe('muted');
    expect(line.marker).toBe('triangle');
  });

  it('actual 为 null → 还不知道走哪条线路', () => {
    expect(describeLine(null).title).toBe('还不知道走哪条线路');
    expect(describeLine(null).tone).toBe('muted');
  });

  it('★ confidence === none → 同一句「还不知道」（即使 actual 意外有值）', () => {
    /**
     * ⚠️ `video` 必须显式写成"没起播"。默认 fixture 的 `readyState` 是 4
     * （在播），那会落进 2026-11-20 新增的第二态
     * 「视频已在播放 · 这次没拿到线路数据」—— 见下面的四态用例。
     * 本用例要钉的是**"什么都没看到"**那一态，所以得把"在播"这个变量按住。
     */
    const quick = buildLoadingQuick(
      ok({
        confidence: 'none',
        actual: null,
        hosts: [],
        video: { readyState: 0, durationSec: 0, height: 0, errorCode: 0 },
      }),
    );
    expect(quick?.title).toBe('还不知道走哪条线路');
  });

  it('★ 没人应答 → 危险色的「读取失败」，且**不是**「还没有数据」', () => {
    const quick = buildLoadingQuick({ kind: 'unanswered' });
    expect(quick?.title).toBe('读取失败 · 刷新页面后重试');
    expect(quick?.tone).toBe('bad');
    expect(quick?.title).not.toContain('还没有');
  });

  it('★ unknown 类别 → 「认不出来源」+ 虚线圆，不当成 PCDN（P0-1）', () => {
    /**
     * 反例：`describeLine({cls:'unknown'})` 落回「还不知道走哪条线路」——
     * 那是"什么都没看到"的说法，而这里是"看到了，只是认不出来"。
     * 两者合并会让"B站 换了 PCDN 供应商"看起来像"功能没数据"。
     */
    const line = describeLine({ cls: 'unknown', flavor: null });
    expect(line.title).toBe('有 1 条线路认不出来源');
    expect(line.tone).toBe('muted');
    // 必须与 ext-patch 的空心圆区分开（色盲第二条线索）
    expect(line.marker).toBe('dashed');
    expect(line.marker).not.toBe('ring');
  });

  it('结论卡胶囊：官方 / PCDN / 第三方，认不出就没有胶囊', () => {
    expect(describeKindPill('official')).toEqual({ text: '官方 CDN', tone: 'good' });
    expect(describeKindPill('pcdn')).toEqual({ text: 'PCDN', tone: 'warn' });
    expect(describeKindPill('third-party')).toEqual({ text: '第三方', tone: 'neutral' });
    // 认不出 = 不编一个「未知」标签（那看起来像一种线路）
    expect(describeKindPill('unknown')).toBeNull();
    expect(describeKindPill(null)).toBeNull();
  });
});

// ─────────────────────────── 副行与计数 ───────────────────────────

describe('速览副行：开局 Ns · N 条线路', () => {
  it('有 playing → 开局 3.27s · 3 条线路', () => {
    expect(buildLoadingQuick(ok())?.sub).toBe('开局 3.27s · 3 条线路');
  });

  it('★ playing 缺失 → 整行不显示（不补 0）', () => {
    const noPlaying = ok({ events: [{ t: 1772, stage: 'stall' }] });
    expect(buildLoadingQuick(noPlaying)?.sub).toBeNull();
  });
});

describe('结论卡的三个小计数', () => {
  it('开局 / 线路数 / 切换次数都算对（实测快照是真的换了两次线）', () => {
    expect(describeCounts(snapshot())).toEqual(['开局 3.27s', '3 条线路', '2 次切换']);
  });

  it('没有切换就不出现「0 次切换」（不补 0）', () => {
    const oneLine = ok({
      events: [
        { t: 1000, stage: 'seg-req', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
        { t: 1100, stage: 'seg-res', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
        { t: 1200, stage: 'playing' },
      ],
      hosts: [
        {
          host: 'cn-jsnt-ct-01-07.bilivideo.com',
          cls: 'official',
          flavor: 'self-built',
          count: 1,
        },
      ],
    });
    const counts = describeCounts(oneLine.kind === 'ok' ? oneLine.snapshot : snapshot());
    expect(counts).toContain('1 条线路');
    expect(counts.some((c) => c.includes('次切换'))).toBe(false);
  });
});

// ─────────────────────────── 图例与自洽说明 ───────────────────────────

describe('图例：跟着本次数据走', () => {
  it('顺序固定：官方 → P2P → 第三方（不按出现顺序）', () => {
    const snap = snapshot({
      hosts: [
        { host: 'a.bilivideo.com', cls: 'official', flavor: null, count: 3 },
        { host: 'b.akamaized.net', cls: 'third-party', flavor: null, count: 2 },
        { host: 'c.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null, count: 1 },
      ],
    });
    expect(legendKinds(snap)).toEqual(['official', 'pcdn', 'third-party']);
  });

  it('events 里出现、hosts 里没有的类别也算（两边取并）', () => {
    const snap = snapshot({
      hosts: [],
      events: [{ t: 10, stage: 'seg-req', host: 'x.mcdn.bilivideo.cn', kind: 'pcdn' }],
    });
    expect(legendKinds(snap)).toEqual(['pcdn']);
  });

  it('unknown 不算线路，不进图例', () => {
    const snap = snapshot({
      hosts: [{ host: 'x.example', cls: 'unknown', flavor: null, count: 1 }],
      events: [],
    });
    expect(legendKinds(snap)).toEqual([]);
  });
});

describe('结论卡的自洽说明', () => {
  it('数的是 hosts 里 cls 为 pcdn 的条数', () => {
    const two = snapshot({
      hosts: [
        { host: 'a.bilivideo.com', cls: 'official', flavor: null, count: 9 },
        { host: 'b.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null, count: 2 },
        { host: 'c.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null, count: 1 },
      ],
    });
    expect(describePcdnCaveat(two)).toBe('其中 2 条是 P2P 线路，未占主导');
  });

  it('actual 是 P2P / 没有 actual / 没有 P2P → 都不出现', () => {
    expect(
      describePcdnCaveat(
        snapshot({ actual: { host: 'x.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null } }),
      ),
    ).toBeNull();
    expect(describePcdnCaveat(snapshot({ actual: null, confidence: 'none' }))).toBeNull();
    expect(
      describePcdnCaveat(
        snapshot({
          hosts: [{ host: 'a.bilivideo.com', cls: 'official', flavor: null, count: 1 }],
        }),
      ),
    ).toBeNull();
  });

  /**
   * ## P0-2：结论看"整次"，这句补充"此刻"
   *
   * 结论大字用 argmax（整次主要走官方），而**最后一条分片**已经切到 PCDN ——
   * 那时还说「其中 N 条是 P2P 线路，未占主导」是误导：用户刚被切走。
   */
  it('★ 当前线路（最后一条 seg-req）也是 P2P → 换成「现在正在用 P2P 线路」', () => {
    const switched = snapshot({
      // argmax 仍是官方（12 > 1）
      hosts: [
        {
          host: 'cn-jsnt-ct-01-07.bilivideo.com',
          cls: 'official',
          flavor: 'self-built',
          count: 12,
        },
        { host: 'xy220x180x77x45xy.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null, count: 1 },
      ],
      events: [
        { t: 1000, stage: 'seg-req', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
        { t: 2000, stage: 'seg-req', host: 'xy220x180x77x45xy.mcdn.bilivideo.cn', kind: 'pcdn' },
      ],
    });
    expect(describePcdnCaveat(switched)).toBe('现在正在用 P2P 线路');
    // ⛔ 仍然不许写"已回退"：我们没有"什么时候被踢下来"的观测
    expect(describePcdnCaveat(switched)).not.toContain('回退');
  });

  it('当前线路仍是官方 → 保持原来那句（未占主导）', () => {
    expect(describePcdnCaveat(snapshot())).toBe('其中 1 条是 P2P 线路，未占主导');
  });
});

// ─────────────────────────── 时间轴 ───────────────────────────

describe('时间轴：请求与返回配对成一行', () => {
  const rows = buildTimelineRows(snapshot().events);

  it('★ 实测快照 9 条事件 → 6 行（3 段配对 + 3 个里程碑）', () => {
    /**
     * 反例：把 `buildTimelineRows` 里的 `if (event.stage === 'seg-res') continue`
     * 去掉 → 又变回 9 行，用户重新看不出哪个返回属于哪个请求。
     */
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.kind)).toEqual([
      'event',
      'segment',
      'event',
      'event',
      'segment',
      'segment',
    ]);
  });

  it('★ 每行的标题与右列元信息（配对区间带耗时）', () => {
    /**
     * 标题是「下载视频片段」而不是「开始下载分片」：配对行代表**一整段**
     * （请求→返回），不是"那一刻"；而「分片」是内部实现词，用户读不出它指视频。
     * 反例：把 `SEGMENT_LABEL` 改回 `stageLabel('seg-req')` → 这条必红。
     * 技术名映射本身不变（诊断页还在用「开始下载分片」，见下一个用例）。
     */
    expect(rows.map((r) => r.label)).toEqual([
      '卡了一下',
      '下载视频片段',
      '可以播放',
      '开始播放',
      '下载视频片段',
      '下载视频片段',
    ]);
    expect(rows.map((r) => r.meta)).toEqual([
      '1.77s',
      '2.53s → 2.82s · 0.29s',
      '3.27s +0.45s',
      '3.27s 同一刻',
      '3.74s → 3.89s · 0.15s',
      '4.16s → 4.22s · 0.06s',
    ]);
  });

  it('里程碑的增量是相对**上一条行的结束时刻**（配对行用 doneAt）', () => {
    /**
     * `可以播放` 的 +0.45s 是 3268.2 − 2815.3（上一条分片**返回**的时刻）。
     * 如果用请求时刻（2525.9），这段会算成 +0.74s，把下载耗时算进间隔里。
     */
    expect(rows[2]?.meta).toBe('3.27s +0.45s');
  });

  it('明细：配对行给出 host，里程碑没有就留空（不显示占位符）', () => {
    expect(rows[0]?.detail).toBeNull();
    expect(rows[1]?.detail).toBe('cn-jsnt-ct-01-07.bilivideo.com');
    expect(rows[4]?.detail).toBe('xy220x180x77x45xy.mcdn.bilivideo.cn');
  });

  it('★ 里程碑不用圆点（marker === null），线路行才用', () => {
    expect(rows[0]?.marker).toBeNull(); // 卡了一下
    expect(rows[2]?.marker).toBeNull(); // 可以播放
    expect(rows[3]?.marker).toBeNull(); // 开始播放
    expect(rows[1]).toMatchObject({ marker: 'disc', tone: 'ok' });
    expect(rows[4]).toMatchObject({ marker: 'diamond', tone: 'warn' });
  });

  it('★ 未等到返回的请求写「未完成」，用次要文字色（不是危险色）', () => {
    const unmatched = buildTimelineRows([
      { t: 100, stage: 'seg-req', host: 'a.bilivideo.com', kind: 'pcdn' },
    ]);
    expect(unmatched[0]).toMatchObject({
      kind: 'segment',
      meta: '0.10s · 未完成',
      dimTitle: true,
      dangerTitle: false,
      marker: 'diamond',
    });
  });

  it('配不上的 seg-res 不出行（对应请求在采集窗口外）', () => {
    const onlyRes = buildTimelineRows([
      { t: 100, stage: 'seg-res', host: 'a.bilivideo.com', kind: 'official' },
    ]);
    expect(onlyRes).toEqual([]);
  });

  it('★ error 的标题走危险色，且把 MediaError.code 放进明细（P1-6）', () => {
    /**
     * 反例：`detail` 只认 `host` → 「播放出错」那一行没有明细，
     * 用户/排查者分不清"网慢"（`stall`）与"被拦"（`error code=3`）。
     */
    const special = buildTimelineRows([
      { t: 10, stage: 'error', note: 'code=3' },
      { t: 30, stage: 'stall' },
    ]);
    expect(special[0]).toMatchObject({ dangerTitle: true, detail: 'code=3', marker: null });
    expect(special[1]).toMatchObject({ dangerTitle: false, detail: null });
  });

  it('⛔ `switch` / `blocked` 已经从枚举里删掉（没有生产者）', () => {
    /**
     * 这条守的是"别再加回来一个没有生产者的阶段"：
     * - 换线已由「下载视频片段」行的类别变色表达，再插一行是重复
     * - 候选过滤（T9′）本期没做，`blocked` 无从产出
     *
     * 类型层面 `LoadStage` 已不接受这两个值（`tsc` 会红）；运行时若有人硬塞，
     * 走 `stageLabel()` 的兜底**原样显示**，而不是命中某个残留的中文名 ——
     * 那正是"删干净了"的判据。
     */
    expect(stageLabel('switch' as unknown as LoadStage)).toBe('switch');
    expect(stageLabel('blocked' as unknown as LoadStage)).toBe('blocked');
  });

  it('10 个阶段都有中文名（漏一个会显示成英文）', () => {
    const stages = [
      'nav',
      'playurl-req',
      'playurl-res',
      'ext-patch',
      'seg-req',
      'seg-res',
      'canplay',
      'playing',
      'stall',
      'error',
    ] as const;
    for (const s of stages) expect(stageLabel(s)).not.toBe(s);
    expect(stageLabel('playurl-res')).toBe('B站返回线路清单');
    // 配对行用更短的「下载视频片段」，但技术名映射本身不变（诊断页还在用）
    expect(stageLabel('seg-req')).toBe('开始下载分片');
    expect(stageLabel('ext-patch')).toBe('扩展介入');
  });
});

// ─────────────────────────── P0-1：认不出来源的线路 ───────────────────────────

/** 一条认不出来源的 host（`classifyCdn` 对没实测过的域返回 `unknown`） */
const UNKNOWN_HOST = {
  host: 'xyz.example-cdn.com',
  cls: 'unknown' as const,
  flavor: null,
  count: 7,
};

describe('P0-1 · 认不出来源的线路必须被看见', () => {
  it('★ 只有 unknown → 「有 N 条线路认不出来源」+ 虚线圆（不是「还不知道」）', () => {
    /**
     * 反例（旧行为）：`unknown` 被采集侧丢弃 → `hosts` 为空 → 显示
     * 「还不知道走哪条线路」。用户会以为功能没数据，而事实是**有流量、只是认不出**。
     */
    const quick = buildLoadingQuick(
      ok({ actual: null, confidence: 'measured', hosts: [UNKNOWN_HOST] }),
    );
    expect(quick?.title).toBe('有 1 条线路认不出来源');
    expect(quick?.tone).toBe('muted');
    expect(quick?.marker).toBe('dashed');
  });

  it('⛔ 一条 host 都没有（视频也没起来）→ 仍然是「还不知道走哪条线路」（四态不许归并）', () => {
    /**
     * ⚠️ 和一个显式的"没起播" `video` 一起断言。默认 fixture 的
     * `readyState: 4` + 空 `hosts` 现在是**另一态**（2026-11-20 新增），
     * 不把 `video` 按住的话，这条会去测另一件事而本意被悄悄换掉。
     */
    const quick = buildLoadingQuick(
      ok({
        actual: null,
        confidence: 'none',
        hosts: [],
        video: { readyState: 0, durationSec: 0, height: 0, errorCode: 0 },
      }),
    );
    expect(quick?.title).toBe('还不知道走哪条线路');
    expect(quick?.marker).toBe('ring');
  });

  it('★ 有已知线路 + 同时有 unknown → 计数里写清「4 条线路（1 条认不出）」', () => {
    const snap = snapshot({
      hosts: [
        { host: 'a.bilivideo.com', cls: 'official', flavor: null, count: 9 },
        { host: 'b.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null, count: 3 },
        { host: 'c.akamaized.net', cls: 'third-party', flavor: null, count: 2 },
        UNKNOWN_HOST,
      ],
    });
    expect(hostCountText(snap)).toBe('4 条线路（1 条认不出）');
    expect(describeCounts(snap)).toContain('4 条线路（1 条认不出）');
  });

  it('没有 unknown 时不加那个括号（别让所有快照都变长）', () => {
    expect(hostCountText(snapshot())).toBe('3 条线路');
  });

  it('★ unknown 的分片行画虚线空心圆（与 ext-patch 的空心圆区分）', () => {
    const rows = buildTimelineRows([
      { t: 100, stage: 'seg-req', host: 'xyz.example-cdn.com', kind: 'unknown' },
    ]);
    expect(rows[0]).toMatchObject({ kind: 'segment', marker: 'dashed', tone: 'muted' });
  });

  it('★ DOM：虚线圆带 stroke-dasharray，图例里有一条「认不出来源」', () => {
    const box = loadingDetailPane(
      ok({
        actual: null,
        confidence: 'measured',
        hosts: [UNKNOWN_HOST],
        events: [{ t: 100, stage: 'seg-req', host: 'xyz.example-cdn.com', kind: 'unknown' }],
      }),
      { back: () => undefined, refresh: () => undefined, openDiagnostics: () => undefined },
    );

    const circle = box.querySelector('.ld-node svg circle');
    expect(circle).not.toBeNull();
    expect(circle?.getAttribute('stroke-dasharray')).toBeTruthy();
    // 图例必须解释这个形状（画出来却没人解释，比不画更容易误导）
    const texts = [...box.querySelectorAll('.ld-legend-text')].map((n) => n.textContent);
    expect(texts).toEqual(['认不出来源']);
    // 结论大字同样是「认不出来源」
    expect(box.querySelector('.ld-conclusion-title')?.textContent).toBe('有 1 条线路认不出来源');
  });

  it('★ `describeSnapshotLine()` 四态一次看全（DOM 之外也能直接用）', () => {
    const onlyUnknown = snapshot({ actual: null, confidence: 'measured', hosts: [UNKNOWN_HOST] });
    expect(describeSnapshotLine(onlyUnknown)).toMatchObject({
      title: '有 1 条线路认不出来源',
      marker: 'dashed',
      tone: 'muted',
    });
    expect(describeSnapshotLine(snapshot()).title).toBe('B站官方线路（自建 CDN）');
    // ③ 什么都没看到，视频也没起来
    expect(
      describeSnapshotLine(
        snapshot({
          actual: null,
          confidence: 'none',
          hosts: [],
          video: { readyState: 0, durationSec: 0, height: 0, errorCode: 0 },
        }),
      ).title,
    ).toBe('还不知道走哪条线路');
    // ④ 视频已经在播，但我们没拿到线路数据
    expect(
      describeSnapshotLine(
        snapshot({
          actual: null,
          confidence: 'none',
          hosts: [],
          video: { readyState: 4, durationSec: 1441, height: 1080, errorCode: 0 },
        }),
      ).title,
    ).toBe('视频已在播放 · 这次没拿到线路数据');
  });

  /**
   * 2026-11-20 真机反馈第 2 条：番剧换集后，视频已经加载出来了，
   * 线路卡却写「还不知道走哪条线路」。
   *
   * 根因是 `resetLoadingTrace()` 清空后，新一集的 m4s 已经在传，但
   * `PerformanceObserver` **资源完成后才回调**，实测空窗 288–932ms
   * 里 `hosts` 恒为 0（`<video>.readyState` 已经 ≥ 2）。
   *
   * 那一瞬间显示「还不知道」不是"数据没有"，而是"我们晚了"——
   * 而用户读到的是前者，会以为等一会儿就有。
   */
  it('★★ 视频在播但一条 host 都没拿到 → 「视频已在播放 · 这次没拿到线路数据」', () => {
    const quick = buildLoadingQuick(
      ok({
        actual: null,
        confidence: 'none',
        hosts: [],
        video: { readyState: 2, durationSec: 1441, height: 1080, errorCode: 0 },
      }),
    );
    expect(quick?.title).toBe('视频已在播放 · 这次没拿到线路数据');
    // 绝不能说成"还不知道"—— 那句话暗示"等一会儿就有了"，而这里再等也没有
    expect(quick?.title).not.toContain('还不知道');
    // 也绝不能说成"没流量"或"功能没数据"
    expect(quick?.title).not.toContain('还没有数据');
    // 形状与「认不出来源」同为虚线空心圆：都是"有活动但无结论"
    expect(quick?.marker).toBe('dashed');
    expect(quick?.tone).toBe('muted');
    // 有明细可看（时间轴里那些分片确实在，只是还没入账）
    expect(quick?.hasDetail).toBe(true);
  });

  it('⛔ `readyState === 1`（只有元数据、没有帧）**不许**判成"已在播放"', () => {
    /**
     * 这条最容易误用：`HAVE_METADATA` 时 `duration` 已经有了，
     * 看起来像"视频起来了"，但**一个帧都还没解码**。那一刻确实还没拿到
     * 分片数据，说"没拿到线路数据"是拿一句真话掩盖一个假结论。
     */
    for (const readyState of [0, 1]) {
      expect(
        isPlayingWithoutData(
          snapshot({
            hosts: [],
            video: { readyState, durationSec: 1441, height: 1080, errorCode: 0 },
          }),
        ),
        `readyState=${String(readyState)} 不该判成在播`,
      ).toBe(false);
    }
    // 2 是分界：HAVE_CURRENT_DATA 起才算"当前帧够用"
    expect(
      isPlayingWithoutData(
        snapshot({
          hosts: [],
          video: { readyState: 2, durationSec: 1441, height: 1080, errorCode: 0 },
        }),
      ),
    ).toBe(true);
  });

  it('⛔ 有 host 时不进这一态（哪怕视频在播）', () => {
    expect(isPlayingWithoutData(snapshot())).toBe(false);
    expect(isPlayingWithoutData(snapshot({ hosts: [UNKNOWN_HOST] }))).toBe(false);
  });

  it('⛔ `durationSec === 0` 时不下这个结论（自相矛盾的状态，宁可少说一句）', () => {
    expect(
      isPlayingWithoutData(
        snapshot({
          hosts: [],
          video: { readyState: 4, durationSec: 0, height: 1080, errorCode: 0 },
        }),
      ),
    ).toBe(false);
  });

  it('⛔ 页面上没有 `<video>` → 退回「还不知道」，不编一个"在播"', () => {
    expect(
      describeSnapshotLine(snapshot({ actual: null, confidence: 'none', hosts: [], video: null }))
        .title,
    ).toBe('还不知道走哪条线路');
  });

  it('★ 第四态只改文案，不动 `confidence` / `present`（采集事实不许被界面美化）', () => {
    /**
     * 采集侧"确实没看到"是事实。界面这一层不许为了话说得好听，
     * 就把 `confidence` 抬成 `'measured'` —— 那是拿显示层去改数据层。
     */
    const snap = snapshot({
      present: false,
      actual: null,
      confidence: 'none',
      hosts: [],
      events: [],
      video: { readyState: 4, durationSec: 1441, height: 1080, errorCode: 0 },
    });
    expect(describeSnapshotLine(snap).title).toBe('视频已在播放 · 这次没拿到线路数据');
    expect(snap.confidence).toBe('none');
    expect(snap.present).toBe(false);
  });

  it('图例顺序：三个已知类别 → 认不出来源 → 扩展介入', () => {
    const snap = snapshot({
      hosts: [
        { host: 'a.bilivideo.com', cls: 'official', flavor: null, count: 9 },
        { host: 'b.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null, count: 3 },
        { host: 'c.akamaized.net', cls: 'third-party', flavor: null, count: 2 },
        UNKNOWN_HOST,
      ],
      events: [{ t: 10, stage: 'ext-patch' }, ...snapshot().events],
    });
    expect(legendEntries(snap).map((e) => e.text)).toEqual([
      '官方',
      'P2P',
      '第三方',
      '认不出来源',
      '扩展介入',
    ]);
  });
});

// ─────────────────────────── 取流请求（playurl） ───────────────────────────

/**
 * 一份**带取流请求**的事件序列：0s 原点 → 取流 → 返回清单 → 分片 → 可播放。
 *
 * 这就是用户真机上那条完整链路（时间取自 2026-11-17 真机截图：
 * 第一片在 1.53s，而在此之前有两次 playurl）。
 */
const CHAIN_EVENTS: LoadEvent[] = [
  { t: 0, stage: 'nav' },
  { t: 210.5, stage: 'playurl-req' },
  { t: 384.25, stage: 'playurl-res' },
  { t: 1530, stage: 'seg-req', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
  { t: 1700, stage: 'seg-res', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
  { t: 2100, stage: 'canplay' },
  { t: 2200, stage: 'playing' },
];

describe('取流请求（playurl）在时间轴上', () => {
  it('★ 行序：页面开始加载 → 发出取流请求 → B站返回线路清单 → 下载视频片段 → 可以播放', () => {
    const rows = buildTimelineRows(CHAIN_EVENTS);
    expect(rows.map((r) => r.label)).toEqual([
      '页面开始加载',
      '发出取流请求',
      'B站返回线路清单',
      '下载视频片段',
      '可以播放',
      '开始播放',
    ]);
    expect(rows.map((r) => r.kind)).toEqual([
      'event',
      'event',
      'event',
      'segment',
      'event',
      'event',
    ]);
  });

  it('★ 两行都走里程碑的短竖线（它们不是线路，没有形状）', () => {
    const rows = buildTimelineRows(CHAIN_EVENTS);
    expect(rows[0]).toMatchObject({ marker: null, tone: 'muted' });
    expect(rows[1]).toMatchObject({ marker: null, tone: 'muted' });
    expect(rows[2]).toMatchObject({ marker: null, tone: 'muted' });
    // 分片行仍然用线路形状（对照）
    expect(rows[3]).toMatchObject({ marker: 'disc', tone: 'ok' });
  });

  it('⛔ `--pluma-accent` 只留给 ext-patch：取流两行不许是 accent', () => {
    const rows = buildTimelineRows(CHAIN_EVENTS);
    expect(rows.filter((r) => r.tone === 'accent')).toEqual([]);
  });

  it('没有 host 明细（接口请求不是某条线路的流量）', () => {
    const rows = buildTimelineRows(CHAIN_EVENTS);
    expect(rows[1]?.detail).toBeNull();
    expect(rows[2]?.detail).toBeNull();
  });

  it('★ 参与空档计算：原点与取流之间隔 5 秒就插一条分隔行', () => {
    /**
     * 反例：若把 playurl 事件排除在"上一条行"的更新之外，间隔会被算成
     * "0s → 5.53s" 一整段 —— 而那 5 秒里明明有取流这件事。
     */
    const sparse: LoadEvent[] = [
      { t: 0, stage: 'nav' },
      { t: 5000, stage: 'playurl-req' },
      { t: 5530, stage: 'seg-req', host: 'a.bilivideo.com', kind: 'official' },
    ];
    const rows = buildTimelineRows(sparse);
    expect(rows.map((r) => r.kind)).toEqual(['event', 'gap', 'event', 'segment']);
    // 这条空档发生在**第一个分片之前**（样本里只有两个里程碑，没有 seg）
    // ⇒ 说"片段未逐段列出"是假的，那时连分片请求都还没有。见 `gapText()`。
    expect(rows[1]?.label).toBe('⋯ 5.00s（这段时间没有采集到分片请求）');
  });

  it('⛔ 图例里不出现取流（它不是线路类别）', () => {
    const box = loadingDetailPane(
      ok({
        events: CHAIN_EVENTS,
        hosts: [
          {
            host: 'cn-jsnt-ct-01-07.bilivideo.com',
            cls: 'official',
            flavor: 'self-built',
            count: 1,
          },
        ],
        actual: { host: 'cn-jsnt-ct-01-07.bilivideo.com', cls: 'official', flavor: 'self-built' },
      }),
      { back: () => undefined, refresh: () => undefined, openDiagnostics: () => undefined },
    );
    const texts = [...box.querySelectorAll('.ld-legend-text')].map((n) => n.textContent);
    expect(texts).toEqual(['官方']);
    expect(texts.join()).not.toContain('取流');
  });

  it('★ 完整链路渲染全文（0s 原点 → 取流 → 返回 → 分片 → 播放）', () => {
    const box = loadingDetailPane(
      ok({
        events: CHAIN_EVENTS,
        hosts: [
          {
            host: 'cn-jsnt-ct-01-07.bilivideo.com',
            cls: 'official',
            flavor: 'self-built',
            count: 1,
          },
        ],
        actual: { host: 'cn-jsnt-ct-01-07.bilivideo.com', cls: 'official', flavor: 'self-built' },
      }),
      { back: () => undefined, refresh: () => undefined, openDiagnostics: () => undefined },
    );

    const lines = [...box.querySelectorAll('.ld-row')].map((row) => {
      const title = row.querySelector('.ld-title')?.textContent ?? '';
      const meta = row.querySelector('.ld-delta')?.textContent ?? '';
      const detail = row.querySelector('.ld-detail')?.textContent ?? '';
      return `${title} ${meta} ${detail}`.trim();
    });
    expect(lines).toEqual([
      '页面开始加载 0.00s',
      '发出取流请求 0.21s +0.21s',
      'B站返回线路清单 0.38s +0.17s',
      '下载视频片段 1.53s → 1.70s · 0.17s cn-jsnt-ct-01-07.bilivideo.com',
      '可以播放 2.10s +0.40s',
      '开始播放 2.20s +0.10s',
    ]);
  });
});

// ─────────────────────────── 空档分隔行 ───────────────────────────

describe('空档分隔行：间隔 ≥ 2 秒才插一条', () => {
  /** 两个里程碑、间隔可控 —— 最少的事件数才能把"阈值"单独钉住 */
  const between = (a: number, b: number): ReturnType<typeof buildTimelineRows> =>
    buildTimelineRows([
      { t: a, stage: 'canplay' },
      { t: b, stage: 'playing' },
    ]);

  it('1.9 秒不插；2.0 秒插（阈值就在 2 秒，边界不含糊）', () => {
    expect(between(1000, 2900).map((r) => r.kind)).toEqual(['event', 'event']);
    expect(between(1000, 3000).map((r) => r.kind)).toEqual(['event', 'gap', 'event']);
  });

  it('★ 真机那份 2.07s → 8.28s：文案写 6.21s（秒数就是两个节点相减）', () => {
    const rows = between(2070, 8280);
    const gap = rows.find((r) => r.kind === 'gap');
    // 样本里没有分片 ⇒ 走"没有采集到分片请求"那一版（不是"未逐段列出"）
    expect(gap?.label).toBe('⋯ 6.21s（这段时间没有采集到分片请求）');
    // 与"用两个 t 相减"的结果逐字一致 —— 不是估计出来的
    expect(gap?.label).toBe(gapText(8280 - 2070, true));
  });

  /**
   * ## 两种空档的文案必须分得开（2026-11-17 真机提问）
   *
   * 用户看到时间轴最上面那条「⋯ 2.56s（这段时间的片段未逐段列出）」直接问：
   * 「这段时间哪来的片段？」—— 那片区间里**连取流请求都还没发**。
   *
   * 判据是 `sawSegment`：第一个分片**之前**的空档不能说"片段未列出"。
   * 反例守卫：把 `gapText(ms, !sawSegment)` 改回 `gapText(ms)` → 本条红。
   */
  it('★★ 第一个分片之前的空档：不许说"片段未逐段列出"', () => {
    const beforeSeg = buildTimelineRows([
      { t: 0, stage: 'nav' },
      { t: 2560, stage: 'playurl-req' },
    ]);
    expect(beforeSeg.find((r) => r.kind === 'gap')?.label).toBe(
      '⋯ 2.56s（这段时间没有采集到分片请求）',
    );

    // 有分片之后同样的间隔 —— 这时"未逐段列出"才是真话
    const afterSeg = buildTimelineRows([
      { t: 0, stage: 'nav' },
      { t: 1000, stage: 'seg-req', host: 'a.bilivideo.com' },
      { t: 1100, stage: 'seg-res', host: 'a.bilivideo.com' },
      { t: 5000, stage: 'canplay' },
    ]);
    expect(afterSeg.find((r) => r.kind === 'gap')?.label).toBe(
      '⋯ 3.90s（这段时间的片段未逐段列出）',
    );
  });

  /**
   * ## 同一刻不写 `+0.00s`（2026-11-17 真机提问）
   *
   * 用户看到「扩展介入 2.56s +0.00s」问"为什么是 0 秒"。
   * 原因是 `recordPlayurl()` 把 `ext-patch` 与 `playurl-req` 放在同一个
   * `startTime` 上 —— 两行天生同刻。`+0.00s` 让"同时发生"读起来像"耗时 0"。
   *
   * 反向守卫：把 `rowMeta()` 里的 `delta < 5` 分支删掉 → 本条红。
   * 同时钉住"13ms 仍然写 +0.01s"，防止有人把阈值放大到把真实差值也吞掉。
   */
  it('★★ 同一刻标「同一刻」；真实差值哪怕很小也要写出来', () => {
    const rows = buildTimelineRows([
      { t: 2560, stage: 'playurl-req' },
      { t: 2560, stage: 'ext-patch', note: '接管取流' },
      { t: 2573, stage: 'canplay' },
    ]);
    expect(rows.map((r) => r.meta)).toEqual(['2.56s', '2.56s 同一刻', '2.57s +0.01s']);
  });

  it('⛔ 分隔行不是事件：没有阶段、没有形状、没有右列元信息与明细', () => {
    const gap = between(1000, 5000).find((r) => r.kind === 'gap');
    expect(gap).toMatchObject({
      kind: 'gap',
      stage: null,
      marker: null,
      meta: '',
      detail: null,
      dimTitle: true,
      dangerTitle: false,
    });
  });

  it('上一条是配对行时，间隔从**返回时刻**算起（不把正在下载的时间说成空档）', () => {
    /**
     * 请求 1.00s → 返回 4.00s，下一条在 4.50s：真实空档只有 0.5s。
     * 反例：改用请求时刻（1.00s）当前一条的结束 → 会插一条「3.50s 未逐段列出」，
     * 而上面那一行明明写着这 3 秒在下载。那是在陈述没观测到的事。
     */
    const rows = buildTimelineRows([
      { t: 1000, stage: 'seg-req', host: 'a.bilivideo.com', kind: 'official' },
      { t: 4000, stage: 'seg-res', host: 'a.bilivideo.com', kind: 'official' },
      { t: 4500, stage: 'canplay' },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['segment', 'event']);
  });

  it('时间上重叠的两条请求不产生负间隔行', () => {
    // A 先返回、B 后发但更早结束：previous 在两者之间来回，差值可能为负
    const rows = buildTimelineRows([
      { t: 1000, stage: 'seg-req', host: 'a.bilivideo.com', kind: 'official' },
      { t: 9000, stage: 'seg-res', host: 'a.bilivideo.com', kind: 'official' },
      { t: 2000, stage: 'seg-req', host: 'b.mcdn.bilivideo.cn', kind: 'pcdn' },
      { t: 2100, stage: 'seg-res', host: 'b.mcdn.bilivideo.cn', kind: 'pcdn' },
    ]);
    expect(rows.some((r) => r.kind === 'gap')).toBe(false);
  });

  it('只有一条事件时没有"上一行"，不插行', () => {
    expect(buildTimelineRows([{ t: 1000, stage: 'canplay' }]).map((r) => r.kind)).toEqual([
      'event',
    ]);
  });
});

// ─────────────────────────── 「扩展介入」 ───────────────────────────

describe('「扩展介入」事件（ext-patch）', () => {
  it('★ 画空心圆 + accent 色，而不是里程碑的短竖线', () => {
    const rows = buildTimelineRows([
      { t: 1000, stage: 'ext-patch' },
      { t: 1500, stage: 'canplay' },
    ]);

    expect(rows[0]).toMatchObject({
      kind: 'event',
      stage: 'ext-patch',
      label: '扩展介入',
      marker: 'ring',
      tone: 'accent',
      dangerTitle: false,
    });
    // 同一次序列里的里程碑仍然走短竖线（marker: null）—— 两者没混
    expect(rows[1]?.marker).toBeNull();
  });

  it('它不归属任何线路：没有 host 就没有明细行', () => {
    const rows = buildTimelineRows([{ t: 1000, stage: 'ext-patch' }]);
    expect(rows[0]?.detail).toBeNull();
  });

  /**
   * ## P0-3：明细说清是哪一种介入
   *
   * `ext-patch` 有两个来源：DNR 接管取流（`note: '接管取流'`）与主世界改写响应
   * （`note: '改写响应'`）。用户看到「扩展介入」时，下一个问题就是"它干了什么"。
   */
  it('★ 明细显示介入方式（接管取流 / 改写响应）', () => {
    const rows = buildTimelineRows([
      { t: 1000, stage: 'ext-patch', note: '接管取流' },
      { t: 2000, stage: 'ext-patch', note: '改写响应' },
    ]);
    expect(rows[0]?.detail).toBe('接管取流');
    expect(rows[1]?.detail).toBe('改写响应');
  });

  it('⛔ 没有 ext-patch 事件时，时间轴上不出现「扩展介入」', () => {
    const rows = buildTimelineRows(snapshot().events);
    expect(rows.map((r) => r.label)).not.toContain('扩展介入');
  });
});

// ─────────────────── ADR 0042：官方镜像 + os=mcdn 不许画成 P2P ───────────────────

/**
 * ## 这一组修的是什么（真机报的「P2P 绕过屏蔽 PCDN 开关」）
 *
 * 候选过滤把 PCDN 候选的 authority 换成官方镜像，`search` 一字不动（签名参数
 * `uparams` 含 `os`，删了 403）。改写后是「官方镜像 + `os=mcdn`」→
 * `classifyCdn()` 第 5 条照旧命中 → 面板画橙色 P2P、结论卡说「其中 N 条是 P2P」。
 *
 * 那是**显示错误**，不是取流错误（首块字节与官方基线完全相同）。
 *
 * ## 判据只有一个：`hostCls`
 *
 * | `cls` | `hostCls` | 文案 |
 * | --- | --- | --- |
 * | `pcdn` | `official` | 「官方镜像（资源标记为 mcdn）」+ 官方色实心圆 |
 * | `pcdn` | `pcdn` | 「第三方加速线路（PCDN）」+ 橙色菱形（**一个字不改**） |
 * | `official` | `official` | 「B站官方线路…」+ 官方色实心圆（不变） |
 *
 * 文案必须**同时**说两件事：走的是官方镜像（host 事实）、资源的源标记是 mcdn
 * （query 事实）。只说一半就是要么夸功、要么沿用旧错误。
 *
 * ⛔ 不许出现「已回退」/「已修复」：没有"源站到底是谁"的观测。
 */
describe('ADR 0042 · 三行表：真实 PCDN / 官方镜像 + os=mcdn / 纯官方', () => {
  it('① 真实 PCDN 主机（hostCls=pcdn）→ 文案与形状**一个字不改**', () => {
    const line = describeLine({ cls: 'pcdn', flavor: null, hostCls: 'pcdn' });
    expect(line.title).toBe('第三方加速线路（PCDN）');
    expect(line.tone).toBe('warn');
    expect(line.marker).toBe('diamond');
  });

  it('★ ② 官方镜像 + os=mcdn（cls=pcdn / hostCls=official）→ 官方文案 + 官方形状', () => {
    const line = describeLine({ cls: 'pcdn', flavor: null, hostCls: 'official' });
    /**
     * 必须同时说两件事：
     * - 「官方镜像」= host 事实（所以流量不走 PCDN）
     * - 「资源标记为 mcdn」= query 事实（所以不是"完全干净的官方资源"）
     */
    expect(line.title).toContain('官方镜像');
    expect(line.title).toContain('mcdn');
    // 不许再说 P2P / 加速线路 —— 那句就是本次要修的病
    expect(line.title).not.toContain('P2P');
    expect(line.title).not.toContain('加速');
    // 形状与色调必须折回官方：橙色菱形在时间轴上表示"正在走 P2P"
    expect(line.marker).toBe('disc');
    expect(line.tone).toBe('ok');
  });

  it('⛔ ② 档的文案里不许出现「已回退」/「已修复」', () => {
    /**
     * 我们没有"源站到底是谁"的观测，只有「改写了 authority」与
     * 「首块字节与官方基线相同」两条证据（ADR 0042 §1）。
     * 把推断写成"已修复"就是编事实。
     */
    const title = describeLine({ cls: 'pcdn', flavor: null, hostCls: 'official' }).title;
    expect(title).not.toContain('已回退');
    expect(title).not.toContain('已修复');
    expect(title).not.toContain('回退');
    expect(title).not.toContain('修复');
  });

  it('③ 纯官方（official / hostCls=official）→ 与原来一样', () => {
    const line = describeLine({
      cls: 'official',
      flavor: 'self-built',
      hostCls: 'official',
    });
    expect(line.title).toBe('B站官方线路（自建 CDN）');
    expect(line.tone).toBe('ok');
    expect(line.marker).toBe('disc');
  });

  it('★ `hostCls` 缺席（旧快照）→ 按 `cls` 处理，保留旧行为（宁可显示橙色 P2P）', () => {
    /**
     * 误报"P2P"是可感知的假警报；误报"官方"才是静默失败
     * （`classify.ts` 文件头第 1 条）。所以兜底方向只能是"继续画橙色"。
     */
    const line = describeLine({ cls: 'pcdn', flavor: null });
    expect(line.title).toBe('第三方加速线路（PCDN）');
    expect(line.marker).toBe('diamond');
  });

  it('★ 结论卡胶囊同一口径：官方镜像那一档不许还写 PCDN', () => {
    // 大字说「官方镜像」而胶囊写「PCDN」，就是卡里自己打架
    expect(describeKindPill('pcdn', 'official')).toEqual({ text: '官方 CDN', tone: 'good' });
    // 真实 PCDN 主机不变
    expect(describeKindPill('pcdn', 'pcdn')).toEqual({ text: 'PCDN', tone: 'warn' });
    // 缺席时退回旧行为
    expect(describeKindPill('pcdn')).toEqual({ text: 'PCDN', tone: 'warn' });
  });

  it('★ `renderedKind()` 是唯一判据（三行表都走它）', () => {
    expect(renderedKind('pcdn', 'official')).toBe('official');
    expect(renderedKind('pcdn', 'pcdn')).toBe('pcdn');
    expect(renderedKind('pcdn', undefined)).toBe('pcdn');
    // 非 pcdn 的类别一律原样返回 —— 这个函数**只**折那一档
    expect(renderedKind('official', 'official')).toBe('official');
    expect(renderedKind('third-party', 'third-party')).toBe('third-party');
    expect(renderedKind('unknown', 'unknown')).toBe('unknown');
    // 反例守卫：`hostCls === 'official'` 但 `cls === 'official'` 时不该被"折"出别的值
    expect(renderedKind('official', 'official')).toBe('official');
  });
});

describe('ADR 0042 · 时间轴节点：官方镜像 + os=mcdn 不画橙色 P2P', () => {
  /**
   * 改写后的真实形态：`kind` 仍是 `pcdn`（带 query 判的），但那个 host 的
   * `hostCls` 是 `official`。时间轴靠 `hostClsByHost` 把它还原成官方圆点。
   */
  const REWRITTEN_SNAPSHOT = snapshot({
    actual: {
      host: 'upos-sz-mirrorhw.bilivideo.com',
      cls: 'pcdn',
      flavor: null,
      hostCls: 'official',
    },
    hosts: [
      {
        host: 'upos-sz-mirrorhw.bilivideo.com',
        cls: 'pcdn',
        flavor: null,
        hostCls: 'official',
        count: 3,
      },
    ],
    events: [
      { t: 1000, stage: 'seg-req', host: 'upos-sz-mirrorhw.bilivideo.com', kind: 'pcdn' },
      { t: 1100, stage: 'seg-res', host: 'upos-sz-mirrorhw.bilivideo.com', kind: 'pcdn' },
    ],
  });

  it('★ 时间轴那一行是**官方实心圆 + ok 色**，不是橙色菱形', () => {
    const rows = buildTimelineRows(REWRITTEN_SNAPSHOT.events, hostClsOf(REWRITTEN_SNAPSHOT));
    const line = rows.find((r) => r.kind === 'segment');
    expect(line, '找不到分片行').toBeDefined();
    expect(line?.marker).toBe('disc');
    expect(line?.tone).toBe('ok');
    expect(line?.marker).not.toBe('diamond');
  });

  it('★ 真实 PCDN 主机的时间轴行仍是橙色菱形（一个字不改）', () => {
    // 实测快照里 `xy220…mcdn.bilivideo.cn` 的 hostCls 是 pcdn
    const real = snapshot({
      hosts: [
        {
          host: 'xy220x180x77x45xy.mcdn.bilivideo.cn',
          cls: 'pcdn',
          flavor: null,
          hostCls: 'pcdn',
          count: 1,
        },
      ],
      events: [
        { t: 1000, stage: 'seg-req', host: 'xy220x180x77x45xy.mcdn.bilivideo.cn', kind: 'pcdn' },
      ],
    });
    const line = buildTimelineRows(real.events, hostClsOf(real)).find((r) => r.kind === 'segment');
    expect(line?.marker).toBe('diamond');
    expect(line?.tone).toBe('warn');
  });

  it('★ 不传 `hostClsByHost` 时按 `kind` 画（旧行为，宁可显示橙色 P2P）', () => {
    const rows = buildTimelineRows(REWRITTEN_SNAPSHOT.events);
    const line = rows.find((r) => r.kind === 'segment');
    expect(line?.marker).toBe('diamond');
  });

  it('★ 图例里不许出现一个画面上不存在的形状', () => {
    /**
     * 官方镜像那一档的 `cls` 是 `pcdn`，但画的都是官方圆点 ——
     * 图例若还列「P2P」，用户会去找那些橙色菱形，然后找不到。
     */
    expect(legendKinds(REWRITTEN_SNAPSHOT)).toEqual(['official']);
    expect(legendKinds(REWRITTEN_SNAPSHOT)).not.toContain('pcdn');
  });

  it('★ `loadingDetailPane()` 真的把 `hostCls` 传进去了（接线不是摆设）', () => {
    /**
     * 源码级断言：`buildTimelineRows(snapshot.events)` 单参数调用会让上面那条
     * "画成官方圆点"失效 —— 而那正是最容易漏的一处（改完函数忘了改调用点）。
     */
    const src = readFileSync(
      join(process.cwd(), 'src', 'content', 'panel', 'loading-pane.ts'),
      'utf8',
    );
    expect(src).toContain('buildTimelineRows(snapshot.events, hostClsOf(snapshot))');
    // `hostClsOf` 本身真的读的是 `hosts[].hostCls`
    expect(src).toContain('h.hostCls');
  });
});

describe('ADR 0042 · describePcdnCaveat 的口径：排除官方镜像那批', () => {
  it('★ 「只有官方镜像 + os=mcdn」→ 返回 null（不再说"其中 N 条是 P2P"）', () => {
    /**
     * 那批的 `cls` 是 `pcdn`、但 `hostCls` 是 `official` —— 它们都在官方镜像上，
     * 与同一张卡上「官方 CDN」的大字结论一致。算进"其中 N 条是 P2P"会让结论卡
     * 自己打架（正是 `describePcdnCaveat()` 头部记的那次真机矛盾）。
     */
    const onlyMirror = snapshot({
      actual: {
        host: 'upos-sz-mirrorhw.bilivideo.com',
        cls: 'pcdn',
        flavor: null,
        hostCls: 'official',
      },
      hosts: [
        {
          host: 'upos-sz-mirrorhw.bilivideo.com',
          cls: 'pcdn',
          flavor: null,
          hostCls: 'official',
          count: 5,
        },
        {
          host: 'upos-sz-mirrorcos.bilivideo.com',
          cls: 'pcdn',
          flavor: null,
          hostCls: 'official',
          count: 3,
        },
      ],
      events: [{ t: 1000, stage: 'seg-req', host: 'upos-sz-mirrorhw.bilivideo.com', kind: 'pcdn' }],
    });
    expect(describePcdnCaveat(onlyMirror)).toBeNull();
  });

  it('★ 真 PCDN 与官方镜像混在一起 → **只数真 PCDN**', () => {
    const mixed = snapshot({
      actual: {
        host: 'cn-jsnt-ct-01-07.bilivideo.com',
        cls: 'official',
        flavor: 'self-built',
        hostCls: 'official',
      },
      hosts: [
        {
          host: 'cn-jsnt-ct-01-07.bilivideo.com',
          cls: 'official',
          flavor: 'self-built',
          hostCls: 'official',
          count: 12,
        },
        {
          host: 'upos-sz-mirrorhw.bilivideo.com',
          cls: 'pcdn',
          flavor: null,
          hostCls: 'official',
          count: 4,
        },
        {
          host: 'x5zy69j.edge.mountaintoys.cn',
          cls: 'pcdn',
          flavor: null,
          hostCls: 'pcdn',
          count: 2,
        },
      ],
      events: [
        { t: 1000, stage: 'seg-req', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
      ],
    });
    // 3 条里只有 1 条是真实 PCDN 主机（另外两条：官方 + 官方镜像）
    expect(describePcdnCaveat(mixed)).toBe('其中 1 条是 P2P 线路，未占主导');
  });

  it('★ 此刻那条是官方镜像（kind 仍是 pcdn）→ 不许说「现在正在用 P2P 线路」', () => {
    /**
     * `currentSegment()?.kind === 'pcdn'` 单独不够：官方镜像那一档的 `kind`
     * 也是 `pcdn`。说"现在正在用 P2P 线路"就是旧错误复发。
     * 判据要再问一次"这个 host 的 hostCls 是什么"。
     */
    const nowMirror = snapshot({
      actual: {
        host: 'cn-jsnt-ct-01-07.bilivideo.com',
        cls: 'official',
        flavor: 'self-built',
        hostCls: 'official',
      },
      hosts: [
        {
          host: 'cn-jsnt-ct-01-07.bilivideo.com',
          cls: 'official',
          flavor: 'self-built',
          hostCls: 'official',
          count: 9,
        },
        {
          host: 'upos-sz-mirrorhw.bilivideo.com',
          cls: 'pcdn',
          flavor: null,
          hostCls: 'official',
          count: 5,
        },
        {
          host: 'x5zy69j.edge.mountaintoys.cn',
          cls: 'pcdn',
          flavor: null,
          hostCls: 'pcdn',
          count: 1,
        },
      ],
      events: [
        { t: 1000, stage: 'seg-req', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
        // 最后一条落在**官方镜像**上（kind 仍是 pcdn）
        { t: 2000, stage: 'seg-req', host: 'upos-sz-mirrorhw.bilivideo.com', kind: 'pcdn' },
      ],
    });
    const caveat = describePcdnCaveat(nowMirror);
    expect(caveat).not.toBe('现在正在用 P2P 线路');
    expect(caveat).toBe('其中 1 条是 P2P 线路，未占主导');
  });

  it('★ 此刻那条是真 PCDN 主机 → 仍换那句更强的话（既有行为不变）', () => {
    const nowReal = snapshot({
      actual: {
        host: 'cn-jsnt-ct-01-07.bilivideo.com',
        cls: 'official',
        flavor: 'self-built',
        hostCls: 'official',
      },
      hosts: [
        {
          host: 'cn-jsnt-ct-01-07.bilivideo.com',
          cls: 'official',
          flavor: 'self-built',
          hostCls: 'official',
          count: 9,
        },
        {
          host: 'x5zy69j.edge.mountaintoys.cn',
          cls: 'pcdn',
          flavor: null,
          hostCls: 'pcdn',
          count: 1,
        },
      ],
      events: [
        { t: 1000, stage: 'seg-req', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
        { t: 2000, stage: 'seg-req', host: 'x5zy69j.edge.mountaintoys.cn', kind: 'pcdn' },
      ],
    });
    expect(describePcdnCaveat(nowReal)).toBe('现在正在用 P2P 线路');
  });

  it('结论本身就是官方镜像 → 与「其中 N 条是 P2P」不同时出现', () => {
    /**
     * `actual` 折回 official 之后，那句"其中 N 条"仍可能被真 PCDN 触发 ——
     * 但结论卡的大字已经是「官方镜像」，两者同时出现会让人以为大字说错了。
     * 这里钉的是：**只有**真 PCDN 存在时才出现那句，而且不出现"现在正在用"。
     */
    const mirrorTop = snapshot({
      actual: {
        host: 'upos-sz-mirrorhw.bilivideo.com',
        cls: 'pcdn',
        flavor: null,
        hostCls: 'official',
      },
      hosts: [
        {
          host: 'upos-sz-mirrorhw.bilivideo.com',
          cls: 'pcdn',
          flavor: null,
          hostCls: 'official',
          count: 9,
        },
        {
          host: 'x5zy69j.edge.mountaintoys.cn',
          cls: 'pcdn',
          flavor: null,
          hostCls: 'pcdn',
          count: 1,
        },
      ],
      events: [{ t: 1000, stage: 'seg-req', host: 'upos-sz-mirrorhw.bilivideo.com', kind: 'pcdn' }],
    });
    // 大字是「官方镜像」（走 renderedKind），所以这句说"其中 1 条"是自洽的
    expect(describeLine(mirrorTop.actual).title).toContain('官方镜像');
    expect(describePcdnCaveat(mirrorTop)).toBe('其中 1 条是 P2P 线路，未占主导');
  });
});

// ─────────────────────────── 尾注的锚点 ───────────────────────────

describe('尾注的锚点（PGC 换集后时间轴没有 nav）', () => {
  /**
   * ## 这一条修的是什么
   *
   * `resetLoadingTrace()` 之后**有意不补** `nav`（补了会凭空多出一条几分钟的
   * 空档行）。于是番剧换集后时间轴第一行可能是 `302.41s` —— 而尾注只写
   * 「时间从页面开始加载算起」，看起来像"这一集从 302 秒开始"。
   *
   * 那句话本身没错（时间戳确实相对页面 `timeOrigin`），缺的是**锚点**。
   * 现在不补假事件、不加新行，只把可观测的那个数说进尾注。
   */
  const noNav = (t: number): LoadingSnapshotLite =>
    snapshot({
      events: [{ t, stage: 'seg-req', host: 'a.bilivideo.com', kind: 'official' }],
    });

  it('★ 无 nav + 首条 t=302410 → 尾注首句换成「本集从 5:02.41 开始」', () => {
    const text = timelineFootnote(noNav(302_410));
    expect(text).toContain('5:02.41');
    /**
     * 2026-11-19 精简：改成**整句替换**，不再往基准句里插括号。
     *
     * 旧写法 `时间从页面开始加载算起（本集开始于页面加载后 5:02.41）`
     * 让读者在一句话里处理两个时基。这一版只出现在"没有 nav 的换集后"，
     * 直接说"本集从 X 开始"就够了。
     */
    expect(text).toContain('本集从 5:02.41 开始');
    // 时基句被换掉了，不该同时留着两句
    expect(text).not.toContain('时间从页面开始加载算起');
    // 另外那半句（两种耗时的区别）必须还在
    expect(text).toContain('+x.xxs 是与上一条的间隔');
  });

  it('★ 有 nav → **不**含锚点那段（基准版一字不多）', () => {
    const withNav = snapshot({ events: [{ t: 0, stage: 'nav' }, ...snapshot().events] });
    expect(timelineFootnote(withNav)).toBe(TIMELINE_FOOTNOTE);
    expect(timelineFootnote(withNav)).not.toContain('本集开始于');
    expect(timelineFootnote(withNav)).not.toContain('本集从');
    expect(timelineFootnote(withNav)).not.toContain('（');
  });

  it('⛔ truncated（环形缓冲丢过早期事件）→ 不补锚点', () => {
    /**
     * 反例：`nav` 也会被 200 条环形缓冲挤掉。那种情况下已经有一句
     * 「更早的事件被丢掉了」在说"开头不是页面开始"；再补一句"本集开始于 X"
     * 就是两个互相矛盾的说法 —— 而且后者是假的。
     */
    expect(timelineFootnote(snapshot({ truncated: true }))).toBe(TIMELINE_FOOTNOTE);
    expect(pageOriginAnchor(snapshot({ truncated: true }))).toBeNull();
  });

  it('一条事件都没有 → 没有数可说（**不补 0**）', () => {
    const empty = snapshot({ events: [], truncated: false });
    expect(pageOriginAnchor(empty)).toBeNull();
    expect(timelineFootnote(empty)).toBe(TIMELINE_FOOTNOTE);
  });

  it('DOM：换集后的时间轴，尾注首句说「本集从 … 开始」', () => {
    const box = loadingDetailPane(
      ok({
        events: [{ t: 302_410, stage: 'seg-req', host: 'a.bilivideo.com', kind: 'official' }],
      }),
      { back: () => undefined, refresh: () => undefined, openDiagnostics: () => undefined },
    );
    expect(box.textContent).toContain('本集从 5:02.41 开始');
  });

  it('clockText：m:ss.SS，超过 1 小时才带小时', () => {
    expect(clockText(302_410)).toBe('5:02.41');
    expect(clockText(61_000)).toBe('1:01.00');
    expect(clockText(590)).toBe('0:00.59');
    expect(clockText(3_600_000)).toBe('1:00:00.00');
    expect(clockText(3_661_230)).toBe('1:01:01.23');
    // 边界：59.999s 不许拼成 0:60.00
    expect(clockText(59_999)).toBe('1:00.00');
    // 非法输入不拼出 NaN
    expect(clockText(Number.NaN)).toBe('0:00.00');
  });
});

// ─────────────────── 归零之后：锚点消失、尾注换时基（2026-11-20）───────────────────

describe('归零时间轴的配套文案（originT > 0）', () => {
  /**
   * ## 这一组修的是什么（用户截图证实）
   *
   * 番剧换集后时间轴首行显示 `55.62s` / `267.49s` —— 那是相对页面 `timeOrigin`
   * 的绝对毫秒。修法是**采集侧归零**（`loading-trace.ts` 的 `originT`）。
   *
   * 归零之后，上面那套「本集开始于页面加载后 5:02.41」的锚点不但没用了，
   * 而且**与归零自相矛盾**：时间轴已经改成"本集开始后第几秒"，
   * 再说它从页面加载后 5 分钟开始，等于同一个界面陈述两个时基。
   *
   * 所以这是**归零的配套**，不是另一件事：归零了就必须撤锚点、换尾注第一句。
   */
  const zeroed = (t: number): LoadingSnapshotLite =>
    snapshot({
      originT: 302_410,
      events: [{ t, stage: 'seg-req', host: 'a.bilivideo.com', kind: 'official' }],
    });

  it('★ 归零后 → 锚点**必须消失**（再说「页面加载后 5:02.41」是自相矛盾）', () => {
    expect(pageOriginAnchor(zeroed(0))).toBeNull();
    // 哪怕首条事件不是 0（本集开播后 4.65s 起播），也照样不补
    expect(pageOriginAnchor(zeroed(4650))).toBeNull();
  });

  it('★ 归零后 → 尾注第一句换成「时间从本集开始播放算起」', () => {
    const text = timelineFootnote(zeroed(0));

    expect(text).toContain('时间从本集开始播放算起');
    // 自相矛盾的那半句必须一起消失（不是"再加一句新的"）
    expect(text).not.toContain('时间从页面开始加载算起');
    // 精简后只剩那半句"两种耗时的区别"，它跟时基无关，必须保留
    expect(text).toContain('+x.xxs 是与上一条的间隔');
    expect(text).toContain('耗时');
  });

  it('★ 归零后**不许**再拼出「本集从…开始」（三版里的第二版不能漏判）', () => {
    // 判据必须排在"无 nav ⇒ 补锚点"之前，否则会同时说两句时基
    expect(timelineFootnote(zeroed(0))).not.toContain('（');
    expect(timelineFootnote(zeroed(0))).not.toContain('本集开始于');
    expect(timelineFootnote(zeroed(0))).not.toContain('本集从');
  });

  it('originT 缺席（旧快照 / fixture）→ 走原路：补锚点 + 页面时基（不崩）', () => {
    /**
     * `originT` 在 `LoadingSnapshotLite` 里是**可选**的（几十个 fixture 手工构造
     * 这份形状）。消费方必须兜底成 `0` —— 缺字段 = "没换过集"，不是"读不到"。
     */
    const legacy = snapshot({
      events: [{ t: 302_410, stage: 'seg-req', host: 'a.bilivideo.com', kind: 'official' }],
    });
    expect(legacy.originT).toBeUndefined();
    expect(pageOriginAnchor(legacy)).toBe('本集开始于页面加载后 5:02.41');
    // 尾注这一侧换成整句：「本集从 5:02.41 开始」
    expect(timelineFootnote(legacy)).toContain('本集从 5:02.41 开始');
  });

  it('originT 为 0 → 与缺席同义（不是"归零成 0 秒"）', () => {
    const atZero = snapshot({
      originT: 0,
      events: [{ t: 302_410, stage: 'seg-req', host: 'a.bilivideo.com', kind: 'official' }],
    });
    expect(pageOriginAnchor(atZero)).toBe('本集开始于页面加载后 5:02.41');
    expect(timelineFootnote(atZero)).toBe(timelineFootnote(snapshot({ events: atZero.events })));
  });

  /**
   * ⛔ 这一条守的不是行为，是**不报错的失效模式**。
   *
   * `timelineFootnote()` 三版尾注只有第一句不同，靠
   * `TIMELINE_FOOTNOTE.replace(时基句, …)` 换 —— 而 `String.prototype.replace`
   * 在找不到目标时**原样返回，不抛不警告**。
   *
   * 于是有人把常量里的"时间从页面开始加载算起"改成"时间从页面载入算起"，
   * 归零后界面就会显示「时间从页面开始加载算起」—— 一个**错误的时基陈述**，
   * 而没有任何异常。这正是最难发现的那种错：数字都变小了看起来像修好了，
   * 唯一还说着旧时基的地方就是这句。
   *
   * 所以这里直接钉"目标串必须仍在常量里"。上面那些行为用例都是间接的：
   * 它们只证明"现在能换到"，证明不了"以后改字时会被发现"。
   */
  it('⛔ 时基句必须仍在 TIMELINE_FOOTNOTE 里（否则 replace 静默不生效）', () => {
    expect(TIMELINE_FOOTNOTE).toContain(FOOTNOTE_TIMEBASE_CLAUSE);
    // 而且只能出现一次：出现两次的话 `replace` 只换掉第一个，后半句还留在那儿
    expect(TIMELINE_FOOTNOTE.split(FOOTNOTE_TIMEBASE_CLAUSE)).toHaveLength(2);
  });

  it('DOM：归零后的时间轴，尾注说本集时基且没有锚点括号', () => {
    const box = loadingDetailPane(ok(zeroed(4650)), {
      back: () => undefined,
      refresh: () => undefined,
      openDiagnostics: () => undefined,
    });

    expect(box.textContent).toContain('时间从本集开始播放算起');
    expect(box.textContent).not.toContain('本集开始于页面加载后');
  });
});

// ─────────────────────────── 文案守卫 ───────────────────────────

describe('文案守卫：只说可证实的事', () => {
  /**
   * ## 为什么这两条要单独守
   *
   * 闸门按**线路类别**（`cls`）压事件 —— **同一类别下 host 可能已经换了**。
   * 用户真机截图里副行写「4 条线路」，时间轴却只有 3 个 host，第 4 个正是在
   * 空档期间出现的。所以"同一条线路继续下载"是一句我们**没有观测到**的话，
   * 而这正是最容易为了"解释得通顺"被写回去的一句。
   */
  it('★ 尾注与分隔行都不许出现「同一线路」', () => {
    expect(TIMELINE_FOOTNOTE).not.toContain('同一线路');
    expect(gapText(6210)).not.toContain('同一线路');

    const box = loadingDetailPane(
      ok({
        events: [
          { t: 1000, stage: 'playing' },
          { t: 7210, stage: 'stall' },
        ],
      }),
      { back: () => undefined, refresh: () => undefined, openDiagnostics: () => undefined },
    );
    expect(box.textContent).not.toContain('同一线路');
  });

  /**
   * 2026-11-19 精简（用户：「太长太繁琐，太啰嗦，尽量让普通用户一眼就能看明白」）。
   *
   * 四句 82 字 → 两句 42 字。这条用例守的是**精简后仍然必须说清的两件事**，
   * 不是字数本身（字数会随措辞摇摆，不该被测试钉死）：
   *
   * | 必须留下 | 砍了会怎样 |
   * | --- | --- |
   * | 时基「从页面开始加载算起」 | `1.20s` 变成孤立的数，用户不知道从哪算 |
   * | 两种耗时的区别 | 左列是**时刻**、`+x.xxs` 是**增量**、右列灰字是**单次请求耗时** —— 三列三种含义 |
   *
   * 砍掉的「同一刻」与「未逐段列出」各自的归处：
   * - 「同一刻」：右列同刻时直接写这两个字，自解释
   * - 「未逐段列出」：`gapText()` 的空档行本来就在说这件事，且更贴近它解释的现象
   */
  it('★ 尾注精简后仍说清两件事：时基 / 两种耗时的区别', () => {
    expect(TIMELINE_FOOTNOTE).toContain('时间从页面开始加载算起');
    // `+x.xxs` 与"右侧灰字"是两种不同的数，必须分开说
    expect(TIMELINE_FOOTNOTE).toContain('+x.xxs');
    expect(TIMELINE_FOOTNOTE).toContain('耗时');
    // 也不能写成"同一条线路"的等价说法
    expect(TIMELINE_FOOTNOTE).not.toContain('同一条线');
    expect(gapText(6210)).not.toContain('同一条线');
  });

  it('★ 精简：不再出现已砍掉的两句（防止有人把长版写回来）', () => {
    // 「同一刻」由右列自己表达，尾注不必再教
    expect(TIMELINE_FOOTNOTE).not.toContain('同一刻');
    // 「未逐段列出」归 `gapText()` 的空档行
    expect(TIMELINE_FOOTNOTE).not.toContain('未逐段列出');
    // 长度上限：普通用户一眼看完的量级（两句 ≈ 40 字，留一点余量）
    expect(TIMELINE_FOOTNOTE.length).toBeLessThanOrEqual(45);
  });
});

// ─────────────────────────── DOM：速览行 ───────────────────────────

describe('速览行 DOM', () => {
  it('★ absent（非播放页）→ buildLoadingQuick 返回 null，整卡不渲染', () => {
    expect(buildLoadingQuick({ kind: 'absent' })).toBeNull();
    // undefined 与 absent 同义（既有调用点没给这个字段）
    expect(buildLoadingQuick(undefined)).toBeNull();
  });

  it('画质 Tab：速览行夹在胶囊与解锁卡之间，且非播放页一个都没有', () => {
    const view = buildQualityView({
      view: { pill: '已接管', tone: 'good' },
      unlock: { title: '已解锁', badges: [], anchor: 'x', improved: true },
      proxyEnabled: true,
      pageKind: 'play',
      pageStateKind: 'ok',
      loading: ok(),
    });
    const box = qualityTab(view, {
      toggleProxy: () => undefined,
      proxyUsable: true,
      proxyDisabledReason: null,
      openLoading: () => undefined,
    });

    const classes = [...box.children].map((n) => n.className);
    const headAt = classes.findIndex((c) => c.includes('pane-head'));
    const quickAt = classes.findIndex((c) => c.includes('ld-quick'));
    const unlockAt = classes.findIndex((c) => c.includes('unlock-card'));
    expect(headAt).toBeGreaterThanOrEqual(0);
    expect(quickAt).toBeGreaterThan(headAt);
    expect(unlockAt).toBeGreaterThan(quickAt);

    // 非播放页（这里是首页/直播）：连行都不画
    const other = buildQualityView({
      view: { pill: '未生效', tone: 'neutral' },
      unlock: null,
      proxyEnabled: true,
      pageKind: 'other',
      pageStateKind: 'ok',
      loading: ok(),
    });
    const otherBox = qualityTab(other, {
      toggleProxy: () => undefined,
      proxyUsable: true,
      proxyDisabledReason: null,
      openLoading: () => undefined,
    });
    expect(otherBox.querySelector('.ld-quick')).toBeNull();
  });

  it('快照正常时渲染主行 + 副行 + 「详情 ›」，点整行进浮层', () => {
    const onOpen = vi.fn();
    const quick = buildLoadingQuick(ok());
    expect(quick).not.toBeNull();
    if (quick === null) return;

    const row = loadingQuickRow(quick, onOpen);
    expect(row.className).toContain('ld-quick');
    expect(row.textContent).toContain('线路');
    expect(row.textContent).toContain('B站官方线路（自建 CDN）');
    expect(row.textContent).toContain('详情');
    expect(row.querySelector('.ld-quick-sub')?.textContent).toBe('开局 3.27s · 3 条线路');
    // 圆点真的画了一个 SVG 形状（不是字符）
    expect(row.querySelector('.ld-quick-dot svg')).not.toBeNull();

    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('★ 没人应答 → 危险色 + **没有**「详情 ›」（没有可看的东西）', () => {
    const quick = buildLoadingQuick({ kind: 'unanswered' });
    expect(quick).not.toBeNull();
    if (quick === null) return;

    const row = loadingQuickRow(quick, () => undefined);
    expect(row.textContent).toContain('读取失败');
    expect(row.querySelector('.ld-quick-main')?.className).toContain('ld-tone-bad');
    expect(row.textContent).not.toContain('详情');
    // 不可点就不要渲染成 button（读屏用户会听到一个按不动的按钮）
    expect(row.tagName).toBe('DIV');
  });

  it('调用方没给入口时退化成静态行（不出现点了没反应的箭头）', () => {
    const quick = buildLoadingQuick(ok());
    if (quick === null) throw new Error('unreachable');
    const row = loadingQuickRow(quick);
    expect(row.textContent).not.toContain('详情');
    expect(row.tagName).toBe('DIV');
  });
});

// ─────────────────────────── 模型装配：每条出口都补值 ───────────────────────────

describe('生产路径不许出现 undefined', () => {
  /**
   * ## 为什么单独钉这一条
   *
   * `QualityView.loading` / `PanelModel.loading` 是**可选**字段（既有测试直接构造
   * 字面量，做成必填要动 4 个测试文件）。可选字段的代价是：有人删掉装配那一行，
   * `tsc` **不会报错**，面板会静静地退化成"非播放页"——加载速览整块消失，
   * 而且没有任何错误。
   *
   * 所以判据放在这里：**每一条 return 都必须带一个明确值**。
   * 反例：把 `buildQualityView` 里 `loading,` 那一行删掉 → 本条必红。
   */
  it('★ buildQualityView 的两个出口都带 loading', () => {
    const base = {
      view: { pill: '已接管', tone: 'good' as const },
      unlock: null,
      proxyEnabled: true,
      pageStateKind: 'ok' as const,
    };

    const play = buildQualityView({ ...base, pageKind: 'play', loading: { kind: 'unanswered' } });
    expect(play.loading).toEqual({ kind: 'unanswered' });

    const other = buildQualityView({ ...base, pageKind: 'other', loading: ok() });
    // 非播放页一刀切成 absent：即使调用方传了 ok，也不许画
    expect(other.loading).toEqual({ kind: 'absent' });

    // 调用方没给的时候也要补成明确值，而不是留 undefined
    expect(buildQualityView({ ...base, pageKind: 'play' }).loading).toEqual({ kind: 'absent' });
  });

  it('★ buildPanelModel 与它组出来的 QualityView 都有 loading', () => {
    const model = buildPanelModel({
      snapshot: null,
      pageView: null,
      primary: { uname: null, level: null, loggedIn: 'unknown', source: 'none' },
      clean: null,
      pageKind: 'play',
      accountKnown: false,
      pageStateKind: 'timeout',
      loading: { kind: 'unanswered' },
    });

    expect(model.loading).toEqual({ kind: 'unanswered' });
    expect(model.quality.loading).toEqual({ kind: 'unanswered' });
  });
});

// ─────────────────────────── DOM：二级浮层 ───────────────────────────

describe('「本次加载」浮层', () => {
  /** 三个出口的间谍。`vi.fn()` 直接满足 `() => void` 的签名 */
  function spyActions() {
    return { back: vi.fn(), refresh: vi.fn(), openDiagnostics: vi.fn() };
  }

  it('顶栏是既有形态：返回（‹ + 文字）+ 标题「本次加载」+ ⟳', () => {
    const box = loadingDetailPane(ok(), spyActions());
    const bar = box.querySelector('.sub-bar');
    expect(bar).not.toBeNull();
    expect(box.querySelector('.sub-back')?.textContent).toContain('返回');
    expect(box.querySelector('.sub-back svg')).not.toBeNull();
    expect(bar?.querySelector('.sub-title')?.textContent).toBe('本次加载');
    expect(bar?.querySelector('[aria-label="重新读取加载数据"]')).not.toBeNull();
  });

  it('结论卡：大字结论 + 官方 CDN 胶囊 + 三个小计数', () => {
    const box = loadingDetailPane(ok(), spyActions());
    expect(box.querySelector('.ld-conclusion-icon')).not.toBeNull();
    expect(box.querySelector('.ld-conclusion-kicker')?.textContent).toBe('本次加载');
    expect(box.querySelector('.ld-conclusion-title')?.textContent).toBe('B站官方线路（自建 CDN）');
    expect(box.querySelector('.ld-conclusion .pill')?.textContent).toBe('官方 CDN');
    expect([...box.querySelectorAll('.ld-count')].map((n) => n.textContent)).toEqual([
      '开局 3.27s',
      '3 条线路',
      '2 次切换',
    ]);
  });

  it('★ 结论卡：P2P 存在时补一句自洽说明（裁决 ②）', () => {
    const box = loadingDetailPane(ok(), spyActions());
    const note = box.querySelector('.ld-conclusion-note');
    expect(note?.textContent).toBe('其中 1 条是 P2P 线路，未占主导');
    // 不许出现"回退"：我们没有数据能证明发生过回退
    expect(note?.textContent).not.toContain('回退');
  });

  it('结论本身就是 P2P 时，不再补那句（否则大字与说明打架）', () => {
    const pcdnSnap = ok({
      actual: { host: 'xy220x180x77x45xy.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null },
    });
    const box = loadingDetailPane(pcdnSnap, spyActions());
    expect(box.querySelector('.ld-conclusion-title')?.textContent).toBe('第三方加速线路（PCDN）');
    expect(box.querySelector('.ld-conclusion-note')).toBeNull();
  });

  it('没有 P2P 时整句不出现', () => {
    const clean = ok({
      actual: { host: 'cn-jsnt-ct-01-07.bilivideo.com', cls: 'official', flavor: 'self-built' },
      hosts: [
        {
          host: 'cn-jsnt-ct-01-07.bilivideo.com',
          cls: 'official',
          flavor: 'self-built',
          count: 12,
        },
      ],
    });
    expect(loadingDetailPane(clean, spyActions()).querySelector('.ld-conclusion-note')).toBeNull();
  });

  it('★ 时间轴：9 条事件渲染成 6 行（配对后不再交错）', () => {
    const box = loadingDetailPane(ok(), spyActions());
    const rows = [...box.querySelectorAll('.ld-row')];
    expect(rows).toHaveLength(6);
    expect(rows[0]?.querySelector('.ld-title')?.textContent).toBe('卡了一下');
    expect(rows[1]?.querySelector('.ld-title')?.textContent).toBe('下载视频片段');
    expect(rows[1]?.querySelector('.ld-delta')?.textContent).toBe('2.53s → 2.82s · 0.29s');
    // 里程碑只有时刻（首条没有上一条）
    expect(rows[0]?.querySelector('.ld-delta')?.textContent).toBe('1.77s');
    // 配对行有 host 明细，里程碑没有
    expect(rows[0]?.querySelector('.ld-detail')).toBeNull();
    expect(rows[1]?.querySelector('.ld-detail')?.textContent).toBe(
      'cn-jsnt-ct-01-07.bilivideo.com',
    );
  });

  it('★ 里程碑画短竖线（.ld-tick），线路行画圆点（.ld-node）', () => {
    const box = loadingDetailPane(ok(), spyActions());
    const rows = [...box.querySelectorAll('.ld-row')];
    // 3 个里程碑（卡了一下 / 可以播放 / 开始播放）
    expect(box.querySelectorAll('.ld-tick')).toHaveLength(3);
    expect(rows[0]?.querySelector('.ld-node')).toBeNull();
    expect(rows[0]?.querySelector('.ld-tick')).not.toBeNull();
    // 3 段配对
    expect(box.querySelectorAll('.ld-node')).toHaveLength(3);
    expect(rows[1]?.querySelector('.ld-tick')).toBeNull();
  });

  it('★ 图例只列本次真的出现过的线路（官方 + P2P），不写死四项', () => {
    /**
     * 反例：把图例改回固定四项 → 会多出「第三方」「扩展介入」，
     * 而这次的事件里一个都没有 —— 图例承诺了不存在的形状。
     */
    const box = loadingDetailPane(ok(), spyActions());
    const items = [...box.querySelectorAll('.ld-legend-item')];
    expect(items.map((i) => i.querySelector('.ld-legend-text')?.textContent)).toEqual([
      '官方',
      'P2P',
    ]);
    // 每一项都画了形状，不是只有一个色块
    for (const i of items) expect(i.querySelector('svg')).not.toBeNull();
    expect(box.textContent).not.toContain('扩展介入');
  });

  it('★ 本次出现 ext-patch → 图例追加「○ 扩展介入」，排在线路类别之后', () => {
    const withPatch = ok({
      events: [{ t: 900, stage: 'ext-patch' }, ...snapshot().events],
    });
    expect(legendHasExtPatch(withPatch.kind === 'ok' ? withPatch.snapshot : snapshot())).toBe(true);

    const box = loadingDetailPane(withPatch, spyActions());
    const items = [...box.querySelectorAll('.ld-legend-item')];
    expect(items.map((i) => i.querySelector('.ld-legend-text')?.textContent)).toEqual([
      '官方',
      'P2P',
      '扩展介入',
    ]);

    const cell = items[2];
    // 色调是 accent（蓝 = 我方动作），与时间轴那一行同一个造型
    expect(cell?.className).toContain('ld-tone-accent');
    /**
     * 形状必须是**空心圆**：`markerSvg('ring')` 只给 svg 挂 stroke，
     * 内部 circle 不带 fill；`disc`（官方）的内部 circle 是 `fill="currentColor"`。
     * 断言 fill 属性就能分辨"实心圆"与"空心圆"，不需要真的渲染。
     */
    const circle = cell?.querySelector('svg circle');
    expect(circle).not.toBeNull();
    expect(circle?.getAttribute('fill')).toBeNull();
  });

  it('⛔ 没有 ext-patch 时，图例里连「扩展介入」这四个字都没有', () => {
    const box = loadingDetailPane(ok(), spyActions());
    const texts = [...box.querySelectorAll('.ld-legend-text')].map((n) => n.textContent);
    expect(texts).not.toContain('扩展介入');
    expect(box.textContent).not.toContain('扩展介入');
  });

  it('只有「扩展介入」、一条线路类别都没有时，图例仍然画（那个形状真的出现了）', () => {
    const onlyPatch = ok({
      confidence: 'none',
      actual: null,
      hosts: [],
      events: [{ t: 500, stage: 'ext-patch' }],
    });
    const box = loadingDetailPane(onlyPatch, spyActions());
    expect([...box.querySelectorAll('.ld-legend-text')].map((n) => n.textContent)).toEqual([
      '扩展介入',
    ]);
  });

  /**
   * 图例条目的纯函数出口（DOM 之外也能被别的视图复用）。
   *
   * 反例：`legendEntries()` 忘了 push `LEGEND_EXT_PATCH` → 图例少一项，
   * 而时间轴上那一行照样画圆点，于是"有个形状没人解释"。
   */
  it('legendEntries：线路类别在前、扩展介入在后', () => {
    const snap = snapshot({ events: [{ t: 100, stage: 'ext-patch' }, ...snapshot().events] });
    expect(legendEntries(snap).map((e) => e.text)).toEqual(['官方', 'P2P', '扩展介入']);
    expect(legendEntries(snapshot()).map((e) => e.text)).toEqual(['官方', 'P2P']);
  });

  it('★ 空档在 DOM 里是 `.ld-gap`：只有一条细横线，没有圆点 / 短竖线 / 竖线', () => {
    const gapped = ok({
      events: [
        { t: 1000, stage: 'playing' },
        { t: 7210, stage: 'stall' },
      ],
    });
    const box = loadingDetailPane(gapped, spyActions());
    const gaps = [...box.querySelectorAll('.ld-gap')];
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.textContent).toBe('⋯ 6.21s（这段时间没有采集到分片请求）');

    // 它不是事件：三种"节点"标记一个都不许有
    expect(gaps[0]?.querySelector('.ld-node')).toBeNull();
    expect(gaps[0]?.querySelector('.ld-tick')).toBeNull();
    expect(gaps[0]?.querySelector('.ld-conn')).toBeNull();
    // 时间轴本身仍然按顺序排：里程碑 → 空档 → 里程碑
    expect(
      [...box.querySelectorAll('.ld-row')].map((r) =>
        r.classList.contains('ld-gap') ? 'gap' : 'row',
      ),
    ).toEqual(['row', 'gap', 'row']);
  });

  it('★ 一个线路类别都没有时，图例整块不渲染（不画空图例）', () => {
    const empty = ok({
      confidence: 'none',
      actual: null,
      hosts: [],
      events: [{ t: 100, stage: 'canplay' }],
    });
    const box = loadingDetailPane(empty, spyActions());
    expect(box.querySelector('.ld-legend')).toBeNull();
    // 小标题也不留
    expect(box.textContent).not.toContain('图例');
  });

  it('★ truncated → 明说"更早的事件被丢掉了"（不许静默）', () => {
    const silent = loadingDetailPane(ok(), spyActions());
    expect(silent.textContent).not.toContain('更早的事件被丢掉了');

    const truncated = loadingDetailPane(ok({ truncated: true }), spyActions());
    expect(truncated.textContent).toContain('更早的事件被丢掉了');
  });

  it('没人应答：一句实话 + 诊断入口，**不画空时间轴**', () => {
    const box = loadingDetailPane({ kind: 'unanswered' }, spyActions());
    expect(box.textContent).toContain('读取失败 · 刷新页面后重试');
    expect(box.querySelector('.pane-note')?.className).toContain('ld-tone-bad');
    // 空时间轴会让人以为"这次加载什么都没发生"，而实际是没读到
    expect(box.querySelector('.ld-timeline')).toBeNull();
    expect(box.querySelector('.ld-conclusion')).toBeNull();
    // 出口不能少：诊断仍然要能进
    expect(box.textContent).toContain('查看完整诊断');
  });

  it('absent / undefined：同样不画空壳，且不谎报读取失败', () => {
    for (const outcome of [{ kind: 'absent' } as const, undefined]) {
      const box = loadingDetailPane(outcome, spyActions());
      expect(box.querySelector('.ld-timeline')).toBeNull();
      expect(box.textContent).not.toContain('读取失败');
    }
  });

  it('三个出口都接上了（返回 / ⟳ / 查看完整诊断）', () => {
    const a = spyActions();
    const box = loadingDetailPane(ok(), a);

    box.querySelector('.sub-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(a.back).toHaveBeenCalledTimes(1);

    box
      .querySelector('[aria-label="重新读取加载数据"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(a.refresh).toHaveBeenCalledTimes(1);

    box.querySelector('.sub-entry')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(a.openDiagnostics).toHaveBeenCalledTimes(1);
  });

  it('尾注说清时间基准与 +x.xs 的含义', () => {
    /**
     * ⚠️ 必须喂一份**带 `nav`** 的快照：默认 fixture 没有 `nav`，会走
     * 「本集从 0:01.77 开始」那一版（无 nav ⇒ 换锚点句）。本用例要钉的是
     * **基准版**那句时基，所以把 nav 补上，别让它在两版之间漂移。
     */
    const box = loadingDetailPane(
      ok({ events: [{ t: 0, stage: 'nav' }, ...snapshot().events] }),
      spyActions(),
    );
    expect(box.textContent).toContain('时间从页面开始加载算起');
    // 2026-11-19 精简后：不再写"比上一条多花的时间"，改说"与上一条的间隔"
    expect(box.textContent).toContain('与上一条的间隔');
  });
});

// ─────────────────────────── 桥：三种结局 ───────────────────────────

/** 模拟同页的 `content.ts`：应答 `loading-snapshot` */
function installContentScript(mode: 'ok' | 'garbage' | 'silent'): { replies: () => number } {
  let replied = 0;
  const handler = (ev: MessageEvent): void => {
    const d = ev.data as { __ns?: string; type?: string } | null;
    if (!d || d.__ns !== '__PLUMA__' || d.type !== 'loading-snapshot') return;
    if (mode === 'silent') return;
    replied += 1;
    window.postMessage(
      {
        __ns: '__PLUMA__',
        type: 'loading-snapshot-reply',
        // 老版本 content script 会漏字段：形状不对必须被当成"没人应答"
        snapshot: mode === 'ok' ? snapshot() : { hello: 'world' },
      },
      '*',
    );
  };
  window.addEventListener('message', handler);
  cleanup.push(() => window.removeEventListener('message', handler));
  return { replies: () => replied };
}

const cleanup: (() => void)[] = [];

/**
 * 清场。
 *
 * ⚠️ **每个用例前都要调**（不只是 `afterEach`）：一个用例装下的假 content script
 * 会活到下一条用例，把下一条的请求也答了 —— 表现是"单独跑必过、跑全文件必挂"。
 * 这正是 `panel-page-channel.test.ts` 记过的坑，那里用 `beforeEach(reset)` 做结构化保证。
 */
function resetBridge(): void {
  while (cleanup.length > 0) cleanup.pop()?.();
}

beforeEach(resetBridge);

afterEach(resetBridge);

describe('取加载快照的桥', () => {
  it('★ 同页 content.ts 应答 → ok + 快照', async () => {
    installContentScript('ok');
    const out = await fetchLoadingSnapshotViaPage(10_000);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.snapshot.hosts).toHaveLength(3);
  });

  it('★ 没人应答 → unanswered（不是 absent）', async () => {
    installContentScript('silent');
    const out = await fetchLoadingSnapshotViaPage(30);
    expect(out.kind).toBe('unanswered');
  });

  it('★ 应答形状不对 → 也算 unanswered（拿不到数据这件事相同）', async () => {
    installContentScript('garbage');
    const out = await fetchLoadingSnapshotViaPage(10_000);
    expect(out.kind).toBe('unanswered');
  });

  it('⛔ 只缺 `hosts` 也必须拒收（不是"差不多能画"）', async () => {
    /**
     * ## 这条是这次发现的一个真缺口（2026-11-20）
     *
     * 桥原先只认 `present` 与 `events`（理由写在那里：一个布尔 + 一个数组
     * 足够判"不是垃圾对象"）。但 `describeSnapshotLine()` 第一件事就是
     * `snapshot.hosts.filter(...)` —— `hosts` 缺席时，一条**能过桥**的应答会在
     * `qualityTab()` → `buildLoadingQuick()` 的渲染栈里抛
     * `Cannot read properties of undefined (reading 'filter')`。那段调用没人
     * `await`，异常只落成控制台一行；用户看到的是**面板整块消失**，
     * 连"读取失败 · 刷新页面后重试"都不会出现。
     *
     * 所以判据必须放在**边界**：`window.postMessage` 的来源是页面上下文，
     * 这是唯一的不信任输入口。拒收之后走既有的 `unanswered` —— 面板会
     * 老老实实说「读取失败」，比整块消失好得多。
     */
    let replied = 0;
    const handler = (ev: MessageEvent): void => {
      const d = ev.data as { __ns?: string; type?: string } | null;
      if (!d || d.__ns !== '__PLUMA__' || d.type !== 'loading-snapshot') return;
      replied += 1;
      const { hosts: _dropped, ...withoutHosts } = snapshot();
      window.postMessage(
        { __ns: '__PLUMA__', type: 'loading-snapshot-reply', snapshot: withoutHosts },
        '*',
      );
    };
    window.addEventListener('message', handler);
    cleanup.push(() => window.removeEventListener('message', handler));

    const out = await fetchLoadingSnapshotViaPage(10_000);
    expect(replied).toBe(1); // 确实收到了账，不是没人应答
    expect(out.kind).toBe('unanswered');
  });

  it('★ 非播放页 → absent，且**根本不发消息**（不发也就不会白等 2 秒）', async () => {
    const spy = installContentScript('ok');
    const out = await fetchLoadingSnapshot({ pageKind: 'other' });
    expect(out.kind).toBe('absent');
    expect(spy.replies()).toBe(0);
  });

  it('★ 三种结局互相可辨（归并成 null 就分不出"没有"与"没通"）', async () => {
    installContentScript('ok');
    const a = await fetchLoadingSnapshot({ pageKind: 'play', timeoutMs: 10_000 });

    // 换一个"没人应答"的现场：不清场的话上一条假 content script 还会抢答
    resetBridge();
    installContentScript('silent');
    const b = await fetchLoadingSnapshotViaPage(30);

    const c = await fetchLoadingSnapshot({ pageKind: 'other' });

    expect([a.kind, b.kind, c.kind]).toEqual(['ok', 'unanswered', 'absent']);
  });
});

/**
 * 让同页"content.ts"发一条 `loading-changed` 推送（换集后的通知）。
 *
 * ⚠️ 用真 `window.postMessage`（不是直接调 listener）：要验的是**消息形状判据**
 * （`__ns` + `type` 两个字段都得对上），绕过 postMessage 就只测到了回调。
 */
function pushLoadingChanged(): void {
  window.postMessage({ __ns: '__PLUMA__', type: 'loading-changed' }, '*');
}

/**
 * 把 jsdom 的 `postMessage` 宏任务队列跑干净。
 *
 * ⚠️ `await Promise.resolve()` **不够**：jsdom 的 `postMessage` 派发走的是一个
 * 真实的**宏任务**（`setTimeout(0)` 级别），微任务队列清空时监听器还没跑到。
 * 这个坑先用一条空宏任务把它等掉，避免"单独跑必过、连跑必挂"。
 */
async function flushPostMessage(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('换集推送的订阅（onLoadingChanged）', () => {
  /**
   * ## 这一组修的是什么（真机实测的空白）
   *
   * 面板开着累计 900.4 秒、**0 次取数**；换集本身一条取数都不产生 ——
   * 只有用户手点 ⟳ 或「收起→再展开」才会重取。于是换完集把鼠标移到侧边条，
   * 时间轴还是上一集的数据。
   *
   * 修法是**推送**：采集器 reset 后发一条 `loading-changed`，面板收到就重取。
   * 不是轮询（项目硬纪律：不许常驻定时器，曾因此挂后台白屏）。
   */
  it('★ 收到 loading-changed → 回调被调（推送链路通了）', async () => {
    resetBridge();
    let calls = 0;
    const stop = onLoadingChanged(() => {
      calls += 1;
    });
    cleanup.push(stop);

    pushLoadingChanged();
    await flushPostMessage();

    expect(calls).toBe(1);
  });

  it('★ 取消订阅之后不再回调（面板卸载必须能摘掉监听）', async () => {
    resetBridge();
    let calls = 0;
    const stop = onLoadingChanged(() => {
      calls += 1;
    });

    pushLoadingChanged();
    await flushPostMessage();
    expect(calls).toBe(1);

    stop();
    pushLoadingChanged();
    await flushPostMessage();

    // `window` 上的监听器不跟着 DOM 走：不摘的话每重挂一层就多一次重取
    expect(calls).toBe(1);
  });

  it('取消函数**幂等**：重复调用无害（卸载路径可能走两遍）', async () => {
    resetBridge();
    let calls = 0;
    const stop = onLoadingChanged(() => {
      calls += 1;
    });

    stop();
    expect(() => {
      stop();
    }).not.toThrow();

    pushLoadingChanged();
    await flushPostMessage();
    expect(calls).toBe(0);
  });

  it('⛔ 别的消息类型 / 别的命名空间 → 一次都不回调（判据两个字段都要对上）', async () => {
    resetBridge();
    let calls = 0;
    const stop = onLoadingChanged(() => {
      calls += 1;
    });
    cleanup.push(stop);

    // 同命名空间、不同类型（应答 / 请求都不是"变化"通知）
    window.postMessage({ __ns: '__PLUMA__', type: 'loading-snapshot-reply' }, '*');
    window.postMessage({ __ns: '__PLUMA__', type: 'loading-snapshot' }, '*');
    // 同类型、不同命名空间（别的扩展 / 页面自己的消息）
    window.postMessage({ __ns: 'other', type: 'loading-changed' }, '*');
    // 垃圾
    window.postMessage(null, '*');
    window.postMessage('loading-changed', '*');
    await flushPostMessage();

    expect(calls).toBe(0);
  });
});

// ─────────────────────────── 边界：面板不 import 采集器 ───────────────────────────

/**
 * 一段源码里有没有**从 `content/isolated/**` 值导入**。
 *
 * ## 为什么守的是"值导入"而不是"必须写成 `import type`"
 *
 * 判据是**编译产物里有没有模块依赖**，不是语法风格：
 * - `import type { X } from …` → 整句消失，✅
 * - `import { type X } from …` → 同样消失（每个 specifier 都带 `type`），✅
 * - `import { type X, getLoadingSnapshot } from …` → 后者是**值**，❌
 *
 * 只查 `import type` 前缀会把第二种误判成违规（它是合法的），
 * 而那种"误报"会让人把检查改松 —— 于是真正的值导入跟着漏过去。
 * 所以这里逐个 specifier 判。
 *
 * @param src 一个文件的内容
 * @returns 命中行（已 trim）；空数组 = 干净
 */
function valueImportsFromIsolated(src: string): string[] {
  const offenders: string[] = [];

  for (const raw of src.split('\n')) {
    const line = raw.trim();
    // 注释 / 字符串里提到路径不算（本项目大量注释都在指路）
    if (!line.startsWith('import ') || !line.includes('content/isolated')) continue;
    // 整句都是类型
    if (/^import\s+type\s/.test(line)) continue;

    const braced = /^import\s*\{([^}]*)\}\s*from/.exec(line);
    if (braced) {
      const specifiers = (braced[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // 每个 specifier 都带 `type ` 前缀 → 整句仍然是纯类型导入
      if (specifiers.every((s) => /^type\s+/.test(s))) continue;
    }

    offenders.push(line);
  }

  return offenders;
}

describe('依赖方向：panel/ 不许值导入 content/isolated/**', () => {
  /**
   * ## 为什么这条必须是源码断言
   *
   * 面板与视频内容脚本是**两个 content script 实例**。如果面板真的 import 了
   * `loading-trace.ts` 的值（`getLoadingSnapshot()`），它会拿到自己那一份
   * **空的**模块级状态 —— 面板会永远显示"还没有数据"，而且**不报任何错**。
   *
   * 类型导入是允许的：不产生模块依赖，编译后整句消失，
   * 因此不会在面板侧造出第二个实例。
   */
  it('src/content/panel/** 里一条值导入都没有', () => {
    const dir = join(process.cwd(), 'src', 'content', 'panel');
    const offenders: string[] = [];

    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const src = readFileSync(join(dir, name), 'utf8');
      for (const hit of valueImportsFromIsolated(src)) offenders.push(`${name}: ${hit}`);
    }

    expect(offenders).toEqual([]);
  });

  /**
   * 检查器自己的反例验证 —— 否则"永远返回空"的实现也能让上一条变绿。
   *
   * 反向验证（实测过）：把 `loading-pane.ts:41` 的 `import type` 改成
   * `import { getLoadingSnapshot }`，上一条会红在
   * `loading-pane.ts: import { getLoadingSnapshot } from '@/src/content/isolated/loading-trace';`
   */
  it('★ 检查器本身有效：值导入 / 混合导入被抓，纯类型导入放过', () => {
    const P = "from '@/src/content/isolated/loading-trace';";
    expect(valueImportsFromIsolated(`import { getLoadingSnapshot } ${P}`)).toHaveLength(1);
    expect(valueImportsFromIsolated(`import { type A, getLoadingSnapshot } ${P}`)).toHaveLength(1);
    expect(valueImportsFromIsolated(`import { type A, type B } ${P}`)).toEqual([]);
    expect(valueImportsFromIsolated(`import type { A } ${P}`)).toEqual([]);
    // 注释里提到路径不算违规
    expect(valueImportsFromIsolated(` * 见 src/content/isolated/loading-trace.ts`)).toEqual([]);
  });
});
