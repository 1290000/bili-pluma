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
  describeCounts,
  describeLine,
  describeKindPill,
  describePcdnCaveat,
  legendKinds,
  loadingDetailPane,
  loadingQuickRow,
  stageLabel,
} from '../../../src/content/panel/loading-pane';
import type { LoadingOutcome } from '../../../src/content/panel/loading-pane';
import {
  buildPanelModel,
  buildQualityView,
  fetchLoadingSnapshot,
  fetchLoadingSnapshotViaPage,
} from '../../../src/content/panel/panel-data';
import { qualityTab } from '../../../src/content/panel/tabs';
import type { LoadingSnapshotLite } from '../../../src/content/isolated/loading-trace';
import type { LoadEvent } from '../../../src/core/loading/timeline';

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
    const quick = buildLoadingQuick(ok({ confidence: 'none', actual: null, hosts: [] }));
    expect(quick?.title).toBe('还不知道走哪条线路');
  });

  it('★ 没人应答 → 危险色的「读取失败」，且**不是**「还没有数据」', () => {
    const quick = buildLoadingQuick({ kind: 'unanswered' });
    expect(quick?.title).toBe('读取失败 · 刷新页面后重试');
    expect(quick?.tone).toBe('bad');
    expect(quick?.title).not.toContain('还没有');
  });

  it('unknown 类别落「还不知道」，不当成 PCDN（不替用户拦来源不明的域）', () => {
    expect(describeLine({ cls: 'unknown', flavor: null }).title).toBe('还不知道走哪条线路');
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
    expect(rows.map((r) => r.label)).toEqual([
      '卡了一下',
      '下载分片',
      '可以播放',
      '开始播放',
      '下载分片',
      '下载分片',
    ]);
    expect(rows.map((r) => r.meta)).toEqual([
      '1.77s',
      '2.53s → 2.82s · 0.29s',
      '3.27s +0.45s',
      '3.27s +0.00s',
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

  it('error / blocked 的标题走危险色', () => {
    const special = buildTimelineRows([
      { t: 10, stage: 'error', note: 'code=3' },
      { t: 30, stage: 'blocked', host: 'a.bilivideo.com', kind: 'official' },
    ]);
    for (const row of special) {
      expect(row.dangerTitle).toBe(true);
      // 里程碑仍然不用圆点
      expect(row.marker).toBeNull();
    }
  });

  it('`switch` 带 kind 时用线路形状（它是"换到哪条线"，不是里程碑）', () => {
    const switched = buildTimelineRows([
      { t: 10, stage: 'switch', host: 'a.bilivideo.com', kind: 'pcdn' },
    ]);
    expect(switched[0]).toMatchObject({ kind: 'event', marker: 'diamond', tone: 'warn' });
  });

  it('12 个阶段都有中文名（漏一个会显示成英文）', () => {
    const stages = [
      'nav',
      'playurl-req',
      'playurl-res',
      'ext-patch',
      'seg-req',
      'seg-res',
      'canplay',
      'playing',
      'switch',
      'stall',
      'error',
      'blocked',
    ] as const;
    for (const s of stages) expect(stageLabel(s)).not.toBe(s);
    expect(stageLabel('switch')).toBe('换了一条线路');
    expect(stageLabel('playurl-res')).toBe('B站 返回线路清单');
    // 配对行用更短的「下载分片」，但技术名映射本身不变（诊断页还在用）
    expect(stageLabel('seg-req')).toBe('开始下载分片');
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
    expect(rows[1]?.querySelector('.ld-title')?.textContent).toBe('下载分片');
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
    const box = loadingDetailPane(ok(), spyActions());
    expect(box.textContent).toContain('时间从页面开始加载算起');
    expect(box.textContent).toContain('比上一条多花的时间');
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
