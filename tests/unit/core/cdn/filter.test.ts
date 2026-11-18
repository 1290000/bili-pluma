// @vitest-environment node

/**
 * `rewritePcdnCandidates()` 的判据表（ADR 0039 八条硬边界 + 工程约束）。
 *
 * ## 为什么每条判据都要单独立一条用例
 *
 * 这个函数**换 authority 但不增删候选**，两种失败都可能是静默的：
 *
 * | 方向 | 后果 | 什么时候被发现 |
 * | --- | --- | --- |
 * | 该换没换 | 用户照旧走 PCDN，界面一切正常 | **永远不会** |
 * | 换了不该换的 / 动了 path / 改了条数 | 少一条备份，或 403 | **只在故障那天** |
 *
 * 没有一条会在 CI 里自然暴露，所以只能靠这里的断言把两个方向都钉住。
 *
 * ## 核心不变量（取代 ADR 0038 的"输出 URL 集合 ⊆ 输入"）
 *
 * **输出 URL 的 `pathname + search` 多重集合必须等于输入的**，条数严格相等，
 * 只有 authority 可变（proxy 包装那条把原 URL 编码进 `?url=`，解码后再比）。
 * 这条钉住"只换 authority、不增删、不动 path/query"。
 *
 * ## 用例与判据的对应关系
 *
 * 文件头 `src/core/cdn/filter.ts` 里列的判据逐条都有对应用例，
 * 用例名前面标了编号（`判据1 …`），改判据时按编号找。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REWRITE_RULES,
  filterPcdnCandidates,
  rewriteDashOf,
  rewritePcdnCandidates,
  type CandidateTrack,
  type DashFilterStats,
} from '@core/cdn/filter';

// ─────────────────────────── 样本 ───────────────────────────

/** 官方自建边缘（`cn-*` 命中 `SELF_BUILT_RE`），带取流凭据形状的 query */
const OFFICIAL = 'https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s?upsig=aa&deadline=20390101';
const OFFICIAL_2 = 'https://cn-jsnt-ct-01-08.bilivideo.com/v.m4s?upsig=bb&deadline=20390101';
/** 真实 PCDN 形状：`mcdn` 独立成标签 + 端口 */
const PCDN = 'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/v.m4s?upsig=cc';
const PCDN_2 = 'https://xy220x180x77x45xy.mcdn.bilivideo.cn:8082/v.m4s?upsig=dd';
/** mcdn 的 `/v1/resource/upgcxcode/` 变体 —— ADR 0039 实测换 host 403，须走 proxy */
const MCDN_PROXY =
  'https://xy116x196x140x25xy.mcdn.bilivideo.cn/v1/resource/upgcxcode/2026/x.m4s?upsig=ee';
/** 第三方 CDN（Akamai 形状） */
const THIRD = 'https://e1.akamaized.net/v.m4s?upsig=ff';
/** 认不出来源的域（`classifyCdn` 返回 unknown） */
const UNKNOWN = 'https://xyz.example-cdn.com/video/a.m4s?upsig=gg';

/** 造一条下划线风格的轨（其余字段用来验"透传不改"） */
function snake(
  base: string,
  backups: string[] = [],
  extra: Record<string, unknown> = {},
): CandidateTrack {
  return { base_url: base, backup_url: backups, ...extra };
}

/** 按默认规则换 host 后的期望串（用 URL API 算，避免手抄导致假绿） */
function mirrorOf(url: string): string {
  const parsed = new URL(url);
  const target = new URL(`https://${DEFAULT_REWRITE_RULES.mirrorHost}/`);
  parsed.hostname = target.hostname;
  parsed.port = target.port; // 只赋 host 会保留原 port
  return parsed.href;
}

/** 按默认规则走 proxy 包装后的期望串 */
function proxyOf(url: string): string {
  return `https://${DEFAULT_REWRITE_RULES.proxyHost}?url=${encodeURIComponent(url)}`;
}

/**
 * 取一条 URL 的 `pathname + search`。
 *
 * proxy 包装的那条把原 URL 编码进 `?url=`；只有确认 host 是下发的 proxyHost 时才解码，
 * 否则一条普通的 `?url=` 官方地址会被误当成包装（那样 invariant 就测空了）。
 */
function pathSearchOf(url: string | undefined): string {
  if (url === undefined) return '<undefined>';
  const parsed = new URL(url);
  if (parsed.hostname === DEFAULT_REWRITE_RULES.proxyHost) {
    const inner = parsed.searchParams.get('url');
    if (inner !== null) {
      const original = new URL(inner);
      return original.pathname + original.search;
    }
  }
  return parsed.pathname + parsed.search;
}

/** 从一条轨取出全部候选（两种命名都收） */
function urlsOf(track: CandidateTrack): Array<string | undefined> {
  return [track.base_url, track.baseUrl, ...(track.backup_url ?? []), ...(track.backupUrl ?? [])];
}

describe('rewritePcdnCandidates', () => {
  // ── 判据 1：只换 pcdn ──

  it('判据1 · 3 条全官方 → 原样返回（不产生新对象）', () => {
    const track = snake(OFFICIAL, [OFFICIAL_2, THIRD]);
    const { tracks, stats } = rewritePcdnCandidates([track], DEFAULT_REWRITE_RULES);

    expect(stats).toEqual({ rewritten: 0, proxied: 0, fallbackKept: 0 });
    // 引用相等：一条都没改时不该造新对象
    expect(tracks[0]).toBe(track);
    expect(tracks[0]?.base_url).toBe(OFFICIAL);
    expect(tracks[0]?.backup_url).toEqual([OFFICIAL_2, THIRD]);
  });

  it('判据1 · third-party 与 unknown 都原样（unknown ≠ 该换）', () => {
    const track = snake(THIRD, [UNKNOWN]);
    const { tracks, stats } = rewritePcdnCandidates([track], DEFAULT_REWRITE_RULES);

    expect(stats).toEqual({ rewritten: 0, proxied: 0, fallbackKept: 0 });
    expect(tracks[0]).toBe(track);
    expect(tracks[0]?.base_url).toBe(THIRD);
    expect(tracks[0]?.backup_url).toEqual([UNKNOWN]);
  });

  // ── 判据 2：必须传 search ──

  it('判据2 · 官方域 + `os=mcdn` → 判 PCDN 并换 host（证明 search 真的传进去了）', () => {
    const mirror = 'https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s?os=mcdn&upsig=hh';
    const { tracks, stats } = rewritePcdnCandidates(
      [snake(OFFICIAL, [mirror])],
      DEFAULT_REWRITE_RULES,
    );

    expect(stats.rewritten).toBe(1);
    expect(tracks[0]?.base_url).toBe(OFFICIAL);
    expect(tracks[0]?.backup_url).toEqual([mirrorOf(mirror)]);
    // query 一字不动（os=mcdn 也留着）
    expect(new URL(tracks[0]?.backup_url?.[0] ?? '').search).toBe('?os=mcdn&upsig=hh');
  });

  // ── 判据 3：只改 authority ──

  it('判据3 · ★ 换后 host 是 mirrorHost，path / query / hash 一字不动', () => {
    const withHash = 'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/v/a.m4s?x=1&y=2#frag';
    const { tracks, stats } = rewritePcdnCandidates(
      [snake(OFFICIAL, [withHash])],
      DEFAULT_REWRITE_RULES,
    );

    const out = new URL(tracks[0]?.backup_url?.[0] ?? '');
    expect(out.host).toBe(DEFAULT_REWRITE_RULES.mirrorHost);
    expect(out.pathname).toBe('/v/a.m4s');
    expect(out.search).toBe('?x=1&y=2');
    expect(out.hash).toBe('#frag');
    expect(stats).toEqual({ rewritten: 1, proxied: 0, fallbackKept: 0 });
  });

  it('判据3 · ★ 输出 URL 的 path+search **多重集合 == 输入**（条数相等、authority 可变）', () => {
    /**
     * ADR 0039 的结构性回归：不管以后算法怎么改，
     * 只要输出多出/少掉一条 path+search（或改了路径），就是越界。
     * 与旧的"输出 ⊆ 输入"相反 —— 现在 host 必须能变。
     */
    const inputs = [
      snake(PCDN, [PCDN_2, OFFICIAL]),
      snake(OFFICIAL_2, [MCDN_PROXY], { height: 2160 }),
      { baseUrl: PCDN, backupUrl: [OFFICIAL, OFFICIAL_2, UNKNOWN] },
    ];
    const before = inputs.flatMap(urlsOf);

    const { tracks } = rewritePcdnCandidates(inputs, DEFAULT_REWRITE_RULES);
    const after = tracks.flatMap(urlsOf);

    expect(after.length).toBe(before.length); // 条数严格不变
    expect(after.map(pathSearchOf).sort()).toEqual(before.map(pathSearchOf).sort());
    // 至少有一条 host 真的变了，否则这条 invariant 可能因为"什么都没做"而假绿
    expect(after.some((u, i) => u !== before[i])).toBe(true);
  });

  // ── 判据 4：条数不变 ──

  it('判据4 · 3 条全 PCDN → 3 条全换，不删轨（removed 路线已退休）', () => {
    const track = snake(PCDN, [PCDN_2, PCDN]);
    const { tracks, stats } = rewritePcdnCandidates([track], DEFAULT_REWRITE_RULES);

    expect(stats).toEqual({ rewritten: 3, proxied: 0, fallbackKept: 0 });
    expect(tracks[0]?.base_url).toBe(mirrorOf(PCDN));
    expect(tracks[0]?.backup_url).toEqual([mirrorOf(PCDN_2), mirrorOf(PCDN)]);
    expect(tracks[0]?.backup_url).toHaveLength(2);
  });

  it('判据4 · 2 PCDN + 1 官方 → 条数仍 3，两条换 host、官方不动', () => {
    const track = snake(PCDN, [PCDN_2, OFFICIAL]);
    const { tracks, stats } = rewritePcdnCandidates([track], DEFAULT_REWRITE_RULES);

    expect(stats).toEqual({ rewritten: 2, proxied: 0, fallbackKept: 0 });
    expect(tracks[0]?.base_url).toBe(mirrorOf(PCDN));
    expect(tracks[0]?.backup_url).toEqual([mirrorOf(PCDN_2), OFFICIAL]);
  });

  // ── 判据 5：proxy 包装 ──

  it('判据5 · ★ path 含 proxyPathPrefix 的 PCDN → proxy 包装（原 URL 完整编码）', () => {
    const { tracks, stats } = rewritePcdnCandidates(
      [snake(OFFICIAL, [MCDN_PROXY])],
      DEFAULT_REWRITE_RULES,
    );

    expect(stats).toEqual({ rewritten: 1, proxied: 1, fallbackKept: 0 });
    expect(tracks[0]?.backup_url).toEqual([proxyOf(MCDN_PROXY)]);
    const wrapped = new URL(tracks[0]?.backup_url?.[0] ?? '');
    expect(wrapped.hostname).toBe(DEFAULT_REWRITE_RULES.proxyHost);
    expect(wrapped.searchParams.get('url')).toBe(MCDN_PROXY);
  });

  it('判据5 · ★ 官方候选即使 path 命中前缀也不许走 proxy', () => {
    const officialMcdnPath = `https://cn-jsnt-ct-01-07.bilivideo.com${DEFAULT_REWRITE_RULES.proxyPathPrefix}x.m4s`;
    const { tracks, stats } = rewritePcdnCandidates(
      [snake(officialMcdnPath)],
      DEFAULT_REWRITE_RULES,
    );

    expect(stats).toEqual({ rewritten: 0, proxied: 0, fallbackKept: 0 });
    expect(tracks[0]).toBeDefined();
    expect(tracks[0]?.base_url).toBe(officialMcdnPath);
    // 用数组再包一层，确认它在新对象里也是原样
    const wrappedTrack = snake(OFFICIAL, [officialMcdnPath]);
    const second = rewritePcdnCandidates([wrappedTrack], DEFAULT_REWRITE_RULES);
    expect(second.tracks[0]).toBe(wrappedTrack);
  });

  // ── 判据 6：换不了就原样 ──

  it('判据6 · ★ `new URL()` 抛错的候选原样保留，fallbackKept++', () => {
    const broken = 'not a url at all';
    const { tracks, stats } = rewritePcdnCandidates(
      [snake(PCDN, [broken, OFFICIAL])],
      DEFAULT_REWRITE_RULES,
    );

    expect(stats).toEqual({ rewritten: 1, proxied: 0, fallbackKept: 1 });
    expect(tracks[0]?.base_url).toBe(mirrorOf(PCDN));
    expect(tracks[0]?.backup_url).toEqual([broken, OFFICIAL]);
  });

  it('判据6 · ★ 规则缺项（null / 空字段）→ 全原样 + fallbackKept 计数', () => {
    const track = snake(PCDN, [OFFICIAL, PCDN_2]);
    const missing = rewritePcdnCandidates([track], null);
    expect(missing.tracks[0]).toBe(track);
    expect(missing.stats).toEqual({ rewritten: 0, proxied: 0, fallbackKept: 2 });

    const partial = rewritePcdnCandidates([track], {
      mirrorHost: '',
      proxyHost: DEFAULT_REWRITE_RULES.proxyHost,
      proxyPathPrefix: DEFAULT_REWRITE_RULES.proxyPathPrefix,
    });
    expect(partial.tracks[0]).toBe(track);
    expect(partial.stats).toEqual({ rewritten: 0, proxied: 0, fallbackKept: 2 });
  });

  // ── 判据 7：命名风格跟着输入走 ──

  it('判据7 · `baseUrl` / `backupUrl` 驼峰形态 → 输出仍是驼峰（不许混用）', () => {
    const camel: CandidateTrack = { baseUrl: PCDN, backupUrl: [OFFICIAL, PCDN_2] };
    const { tracks } = rewritePcdnCandidates([camel], DEFAULT_REWRITE_RULES);
    const out = tracks[0] as Record<string, unknown>;

    expect(out.baseUrl).toBe(mirrorOf(PCDN));
    expect(out.backupUrl).toEqual([OFFICIAL, mirrorOf(PCDN_2)]);
    expect(out.base_url).toBeUndefined();
    expect(out.backup_url).toBeUndefined();
  });

  // ── 判据 8：其它键一律透传 ──

  it('判据8 · quality / height / codecid / bandwidth 等字段原样透传', () => {
    const track = snake(PCDN, [OFFICIAL], {
      quality: 120,
      height: 2160,
      codecid: 7,
      bandwidth: 12345678,
      duration: 1166,
    });
    const { tracks } = rewritePcdnCandidates([track], DEFAULT_REWRITE_RULES);

    expect(tracks[0]).toMatchObject({
      quality: 120,
      height: 2160,
      codecid: 7,
      bandwidth: 12345678,
      duration: 1166,
      base_url: mirrorOf(PCDN),
    });
  });

  it('判据8 · 没有 `backup_url` 字段也不崩（单候选轨）', () => {
    const { tracks, stats } = rewritePcdnCandidates([{ base_url: PCDN }], DEFAULT_REWRITE_RULES);

    expect(stats).toEqual({ rewritten: 1, proxied: 0, fallbackKept: 0 });
    expect(tracks[0]?.base_url).toBe(mirrorOf(PCDN));
  });

  // ── 判据 9：纯函数 ──

  it('判据9 · 不修改入参（调用前后 deepEqual）', () => {
    const track = snake(PCDN, [PCDN_2, OFFICIAL]);
    const before = JSON.parse(JSON.stringify(track)) as CandidateTrack;

    const { tracks } = rewritePcdnCandidates([track], DEFAULT_REWRITE_RULES);

    expect(track).toEqual(before);
    expect(tracks[0]).not.toBe(track); // 改过的那条必须是新对象
  });

  // ── 顺序与组合 ──

  it('顺序保持：1 官方 + 2 PCDN + 1 官方 → 换后仍是 4 条，相对顺序不变', () => {
    const track = snake(OFFICIAL, [PCDN, PCDN_2, OFFICIAL_2]);
    const { tracks, stats } = rewritePcdnCandidates([track], DEFAULT_REWRITE_RULES);

    expect(stats.rewritten).toBe(2);
    expect(tracks[0]?.base_url).toBe(OFFICIAL);
    expect(tracks[0]?.backup_url).toEqual([mirrorOf(PCDN), mirrorOf(PCDN_2), OFFICIAL_2]);
  });

  it('多轨累计：rewritten / proxied / fallbackKept 各自累加', () => {
    const { stats } = rewritePcdnCandidates(
      [
        snake(PCDN, [OFFICIAL]), // 换 1
        snake(PCDN, [MCDN_PROXY]), // 换 2，其中 proxy 1
        snake(OFFICIAL, [OFFICIAL_2]), // 不动
        snake('broken', [PCDN]), // fallback 1 + 换 1
      ],
      DEFAULT_REWRITE_RULES,
    );

    expect(stats).toEqual({ rewritten: 4, proxied: 1, fallbackKept: 1 });
  });

  it('空输入 → 空输出、统计为零', () => {
    expect(rewritePcdnCandidates([], DEFAULT_REWRITE_RULES)).toEqual({
      tracks: [],
      stats: { rewritten: 0, proxied: 0, fallbackKept: 0 },
    });
  });

  it('一条轨都没有候选字段 → 原样返回（认不出形态就不动）', () => {
    const bare: CandidateTrack = {};
    const { tracks, stats } = rewritePcdnCandidates([bare], DEFAULT_REWRITE_RULES);

    expect(tracks[0]).toBe(bare);
    expect(stats).toEqual({ rewritten: 0, proxied: 0, fallbackKept: 0 });
  });

  it('幂等：换过的结果再换一遍 → 原对象（镜像域已被 classify 判为 official）', () => {
    const once = rewritePcdnCandidates([snake(PCDN, [MCDN_PROXY])], DEFAULT_REWRITE_RULES);
    const twice = rewritePcdnCandidates(once.tracks, DEFAULT_REWRITE_RULES);

    expect(twice.stats).toEqual({ rewritten: 0, proxied: 0, fallbackKept: 0 });
    expect(twice.tracks[0]).toBe(once.tracks[0]);
  });

  it('旧名 filterPcdnCandidates 是薄封装：语义已是替换，不是删除', () => {
    const track = snake(PCDN, [OFFICIAL]);
    const viaAlias = filterPcdnCandidates([track]);
    const viaNew = rewritePcdnCandidates([track], DEFAULT_REWRITE_RULES);

    expect(viaAlias).toEqual(viaNew);
    expect(viaAlias.tracks[0]?.backup_url).toEqual([OFFICIAL]); // 条数不变
    expect(viaAlias.tracks[0]?.base_url).toBe(mirrorOf(PCDN)); // host 已换
  });
});

/**
 * ## `rewriteDashOf()`：容器层入口（四个容器，形状各不一样）
 *
 * `rewritePcdnCandidates()` 只认「一个轨数组」，而 `dash` 里带候选地址的容器有四个：
 *
 * | 容器 | 形状 | 外层非候选字段 |
 * | --- | --- | --- |
 * | `dash.video` | track 数组 | — |
 * | `dash.audio` | track 数组 | — |
 * | `dash.flac.audio` | **单个** track 对象 | `display` 是布尔 |
 * | `dash.dolby.audio` | track 数组 | `vision` 是布尔 |
 *
 * 这一层存在的理由就是**后两个容器**：漏掉它们不会报错、界面也正常，
 * 只是那几轨照旧走 PCDN —— 静默失败。
 *
 * ## ⚠️ 与主世界 `filterDashOf()` 必须逐条等价
 *
 * 主世界是裸 JS、不能 import 本文件，所以容器遍历存在**两份实现**。
 * 这里的用例守 `core` 这一份的语义；**等价性**由
 * `tests/unit/content/pcdn-filter-wiring.test.ts` 用同一批 fixture 同时喂两个实现来守。
 */
describe('rewriteDashOf（容器层入口，ADR 0039 边界 1/2/5）', () => {
  /** 空统计（形状不对时的期望值） */
  const NONE: DashFilterStats = { changed: false, rewritten: 0, proxied: 0, fallbackKept: 0 };

  /** 造一条下划线风格的音/视轨（其余字段用来验"透传不改"） */
  function track(
    base: string,
    backups: string[] = [],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { base_url: base, backup_url: backups, ...extra };
  }

  /**
   * 收窄成 `Record<string, unknown>` 再读字段。
   *
   * `rewriteDashOf()` 的入参是 `{ dash?: unknown }`（它要能接住任意畸形输入），
   * 所以测试侧的 `holder.dash.video[0]` 是 `unknown`。断言里读具体字段要显式收窄 ——
   * 这里统一走一个 helper，比每行写一次 `as Record<string, unknown>` 干净。
   *
   * @param v 任意值（通常是容器里的一个元素）
   * @returns 同一个对象，按记录视图读
   */
  function rec(v: unknown): Record<string, unknown> {
    return v as Record<string, unknown>;
  }

  it('容器1 · `dash.video[]`：只换 authority，条数与 path/search 不变', () => {
    const holder = {
      dash: {
        duration: 1166,
        video: [
          track(PCDN, [PCDN_2, OFFICIAL], { id: 120, height: 2160, codecid: 12 }),
          track(OFFICIAL_2, [OFFICIAL]),
        ],
        audio: [],
      },
    };

    const stats = rewriteDashOf(holder, DEFAULT_REWRITE_RULES);

    // 第一条轨：base 换 1 + backups 里 PCDN_2 换 1 = 2 条；第二条全官方不计数
    expect(stats).toEqual({ changed: true, rewritten: 2, proxied: 0, fallbackKept: 0 });
    const dash = rec(holder.dash);
    const video = dash.video as Array<Record<string, unknown>>;
    expect(video[0]?.base_url).toBe(mirrorOf(PCDN));
    expect(video[0]?.backup_url).toEqual([mirrorOf(PCDN_2), OFFICIAL]);
    expect(video[0]?.backup_url).toHaveLength(2);
    // 边界 1：path + search 一字不动
    const parsed = new URL(video[0]?.base_url as string);
    expect(parsed.pathname + parsed.search).toBe('/v.m4s?upsig=cc');
    // 边界 3：非候选字段透传
    expect(video[0]?.height).toBe(2160);
    expect(video[0]?.codecid).toBe(12);
    // 非候选的 dash 字段不动
    expect(dash.duration).toBe(1166);
  });

  it('容器2 · `dash.audio[]`：proxy 命中的那条走包装，其余只换 host', () => {
    const holder = {
      dash: {
        video: [],
        audio: [track(OFFICIAL_2, [MCDN_PROXY], { id: 30280, bandwidth: 320000 })],
      },
    };

    const stats = rewriteDashOf(holder, DEFAULT_REWRITE_RULES);

    expect(stats).toEqual({ changed: true, rewritten: 1, proxied: 1, fallbackKept: 0 });
    const out = holder.dash.audio[0];
    expect(out?.base_url).toBe(OFFICIAL_2); // 官方候选不动
    expect(out?.backup_url).toEqual([proxyOf(MCDN_PROXY)]);
    expect(out?.bandwidth).toBe(320000);
  });

  it('容器3 · ★ `dash.flac.audio` 是**单个对象**：换 host、条数不变、`display` 不动', () => {
    const holder = {
      dash: {
        video: [],
        audio: [],
        flac: {
          display: true,
          audio: track(PCDN, [OFFICIAL], { id: 30251, bandwidth: 1_500_000 }),
        },
      },
    };

    const stats = rewriteDashOf(holder, DEFAULT_REWRITE_RULES);

    expect(stats).toEqual({ changed: true, rewritten: 1, proxied: 0, fallbackKept: 0 });
    const flac = rec(holder.dash).flac as {
      display: boolean;
      audio: Record<string, unknown>;
    };
    // `display` 是外层布尔，原样带过
    expect(flac.display).toBe(true);
    expect(flac.audio.base_url).toBe(mirrorOf(PCDN));
    expect(flac.audio.backup_url).toEqual([OFFICIAL]);
    expect(flac.audio.backup_url).toHaveLength(1);
    expect(flac.audio.id).toBe(30251);
    // 边界 1：path/search 不动
    const parsed = new URL(flac.audio.base_url as string);
    expect(parsed.pathname + parsed.search).toBe('/v.m4s?upsig=cc');
  });

  it('容器4 · ★ `dash.dolby.audio[]` 两条轨：各自换 host，顺序与条数不变、`vision` 不动', () => {
    const DOLBY_PCDN = 'https://a1.szbdyd.com/d.m4s?upsig=zz';
    const holder = {
      dash: {
        video: [],
        audio: [],
        dolby: {
          vision: true,
          type: 2,
          audio: [
            // ① base PCDN + 官方 backup → 换 1
            track(DOLBY_PCDN, [OFFICIAL], { id: 30250 }),
            // ② 官方 base + backup 里一条 proxy 的 PCDN → 换 1（其中 proxy 1）
            track(OFFICIAL_2, [MCDN_PROXY, OFFICIAL], { id: 30251 }),
          ],
        },
      },
    };

    const stats = rewriteDashOf(holder, DEFAULT_REWRITE_RULES);

    expect(stats).toEqual({ changed: true, rewritten: 2, proxied: 1, fallbackKept: 0 });
    const dolby = holder.dash.dolby;
    expect(dolby.vision).toBe(true);
    expect(dolby.type).toBe(2);
    expect(dolby.audio).toHaveLength(2);
    expect(dolby.audio[0]?.base_url).toBe(mirrorOf(DOLBY_PCDN));
    expect(dolby.audio[0]?.backup_url).toEqual([OFFICIAL]);
    expect(dolby.audio[1]?.base_url).toBe(OFFICIAL_2);
    expect(dolby.audio[1]?.backup_url).toEqual([proxyOf(MCDN_PROXY), OFFICIAL]);
    // 轨身份/顺序没被换位
    expect(dolby.audio[0]?.id).toBe(30250);
    expect(dolby.audio[1]?.id).toBe(30251);
  });

  it('★ 四个容器同时出现：统计累加、各自独立生效', () => {
    const holder = {
      dash: {
        video: [track(PCDN)],
        audio: [track(PCDN_2)],
        flac: { display: true, audio: track(MCDN_PROXY) },
        dolby: { vision: false, audio: [track(PCDN, [OFFICIAL_2])] },
      },
    };

    const stats = rewriteDashOf(holder, DEFAULT_REWRITE_RULES);

    // video 1 + audio 1 + flac 1（proxy）+ dolby 1
    expect(stats).toEqual({ changed: true, rewritten: 4, proxied: 1, fallbackKept: 0 });
    expect(holder.dash.video[0]?.base_url).toBe(mirrorOf(PCDN));
    expect(holder.dash.audio[0]?.base_url).toBe(mirrorOf(PCDN_2));
    expect(holder.dash.flac.audio.base_url).toBe(proxyOf(MCDN_PROXY));
    expect(holder.dash.dolby.audio[0]?.base_url).toBe(mirrorOf(PCDN));
  });

  it('★ 一个候选都没改（四个容器都官方）→ `changed:false` 且 `holder.dash` **引用不变**', () => {
    const holder = {
      dash: {
        duration: 1166,
        video: [track(OFFICIAL, [OFFICIAL_2])],
        audio: [track(OFFICIAL_2)],
        flac: { display: false, audio: track(OFFICIAL) },
        dolby: { vision: false, audio: [track(OFFICIAL_2, [OFFICIAL])] },
      },
    };
    const dashBefore = holder.dash;

    const stats = rewriteDashOf(holder, DEFAULT_REWRITE_RULES);

    expect(stats).toEqual(NONE);
    // 不制造无谓 diff：整份 dash 连引用都不换
    expect(holder.dash).toBe(dashBefore);
  });

  it('★ 只在 flac 改了 → `dash.dolby` 保持原引用；未改动的**轨**也保持原引用', () => {
    const officialVideo = track(OFFICIAL);
    const officialAudio = track(OFFICIAL_2);
    const officialDolby = track(OFFICIAL);
    const holder = {
      dash: {
        video: [officialVideo],
        audio: [officialAudio],
        flac: { display: true, audio: track(PCDN) },
        dolby: { vision: false, audio: [officialDolby] },
      },
    };
    const dolbyBefore = holder.dash.dolby;
    const flacBefore = holder.dash.flac;

    expect(rewriteDashOf(holder, DEFAULT_REWRITE_RULES).changed).toBe(true);
    // dolby 一条都没改 → 外层对象原引用（不制造无谓 diff）
    expect(holder.dash.dolby).toBe(dolbyBefore);
    // flac 改了 → 外层对象是新的（`display` 被带过去）
    expect(holder.dash.flac).not.toBe(flacBefore);
    expect(holder.dash.flac.display).toBe(true);
    expect(holder.dash.flac.audio.base_url).toBe(mirrorOf(PCDN));
    /**
     * ⚠️ `video` / `audio` 的**数组**在 `changed: true` 时必然换新 ——
     * 那是主世界 `filterDashOf()` 的既有形状（它无条件 `nextVideo = []` 再逐个 push，
     * 只在完全没有改动时提前 return）。两份实现共用这个形状，等价性测试比对的是
     * `dash` **深相等**，不受数组引用影响。但**元素身份**必须保留：
     * 未改动的轨是两个实现都必须返回原对象（幂等性靠它）。
     */
    expect(holder.dash.video[0]).toBe(officialVideo);
    expect(holder.dash.audio[0]).toBe(officialAudio);
  });

  it('★ 只在 video 改了 → `dash.flac` / `dash.dolby` 保持原引用', () => {
    const holder = {
      dash: {
        video: [track(PCDN)],
        audio: [],
        flac: { display: false, audio: track(OFFICIAL) },
        dolby: { vision: true, audio: [track(OFFICIAL_2)] },
      },
    };
    const flacBefore = holder.dash.flac;
    const dolbyBefore = holder.dash.dolby;

    expect(rewriteDashOf(holder, DEFAULT_REWRITE_RULES).changed).toBe(true);
    expect(holder.dash.flac).toBe(flacBefore);
    expect(holder.dash.dolby).toBe(dolbyBefore);
  });

  it('★ 幂等：跑两遍 = 跑一遍（第二遍 `changed:false`、`dash` 引用不变）', () => {
    const holder = {
      dash: {
        video: [track(PCDN, [PCDN_2])],
        audio: [track(PCDN_2)],
        flac: { display: true, audio: track(PCDN) },
        dolby: { vision: true, audio: [track(PCDN)] },
      },
    };

    expect(rewriteDashOf(holder, DEFAULT_REWRITE_RULES).changed).toBe(true);
    const dashAfterFirst = holder.dash;

    expect(rewriteDashOf(holder, DEFAULT_REWRITE_RULES)).toEqual(NONE);
    expect(holder.dash).toBe(dashAfterFirst);
  });

  it('★ 畸形输入一律不抛错、返回全 0', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      {},
      { dash: null },
      { dash: 'nope' },
      { dash: [] },
      // 四个容器一个都没认出来
      { dash: { duration: 1166 } },
      // video / audio 不是数组
      { dash: { video: 'nope', audio: { base_url: PCDN } } },
      // flac 各种畸形
      { dash: { video: [], audio: [], flac: null } },
      { dash: { video: [], audio: [], flac: { display: true } } },
      { dash: { video: [], audio: [], flac: { display: true, audio: 'nope' } } },
      { dash: { video: [], audio: [], flac: { display: true, audio: [] } } },
      { dash: { video: [], audio: [], flac: 'nope' } },
      // dolby 各种畸形
      { dash: { video: [], audio: [], dolby: null } },
      { dash: { video: [], audio: [], dolby: { vision: true } } },
      { dash: { video: [], audio: [], dolby: { vision: true, audio: { base_url: PCDN } } } },
      // 只有畸形容器、没有 video/audio
      { dash: { flac: null, dolby: { vision: true } } },
    ];

    for (const [i, h] of malformed.entries()) {
      expect(
        () => rewriteDashOf(h as undefined, DEFAULT_REWRITE_RULES),
        `case #${String(i)}`,
      ).not.toThrow();
      expect(rewriteDashOf(h as undefined, DEFAULT_REWRITE_RULES), `case #${String(i)}`).toEqual(
        NONE,
      );
    }
  });

  it('★ 容器数组里塞了非对象（null / 字符串 / 数字）→ 原样保留、其余照改', () => {
    const holder = {
      dash: {
        video: [null, 'nope', 42, track(PCDN)],
        audio: [],
      },
    };

    const stats = rewriteDashOf(holder, DEFAULT_REWRITE_RULES);

    expect(stats).toEqual({ changed: true, rewritten: 1, proxied: 0, fallbackKept: 0 });
    const video = rec(holder.dash).video as unknown[];
    expect(video).toHaveLength(4);
    expect(video[0]).toBeNull();
    expect(video[1]).toBe('nope');
    expect(video[2]).toBe(42);
    expect(rec(video[3]).base_url).toBe(mirrorOf(PCDN));
  });

  it('★ 轨里的候选是非 URL 串 → 原样保留 + `fallbackKept++`，其它容器照旧改', () => {
    const holder = {
      dash: {
        video: [],
        audio: [],
        flac: { display: true, audio: { id: 30251 } }, // 没有候选字段
        dolby: {
          vision: false,
          audio: [track('not a url'), track(PCDN)],
        },
      },
    };

    const stats = rewriteDashOf(holder, DEFAULT_REWRITE_RULES);

    expect(stats.changed).toBe(true);
    expect(stats.rewritten).toBe(1);
    expect(stats.fallbackKept).toBe(1);
    expect(holder.dash.dolby.audio[0]?.base_url).toBe('not a url');
    expect(holder.dash.dolby.audio[1]?.base_url).toBe(mirrorOf(PCDN));
  });

  it('★ 规则缺项 → 一条都不改、`changed:false`、`dash` 引用不变', () => {
    const holder = {
      dash: {
        video: [track(PCDN)],
        audio: [track(PCDN_2)],
        flac: { display: true, audio: track(PCDN) },
        dolby: { vision: true, audio: [track(PCDN)] },
      },
    };
    const dashBefore = holder.dash;

    const stats = rewriteDashOf(holder, null);

    // 四条 PCDN 都"想换但换不了" → fallbackKept 计数，但 changed 为 false
    expect(stats).toEqual({ changed: false, rewritten: 0, proxied: 0, fallbackKept: 4 });
    expect(holder.dash).toBe(dashBefore);
  });

  it('⛔ `durl` / `durls` 一个字节都不动（FLV 那条路本轮不做）', () => {
    const holder = {
      dash: {
        video: [track(PCDN)],
        audio: [],
      },
      durl: [{ url: 'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/keep-me.flv' }],
      durls: [{ durl: [{ url: 'https://a1.szbdyd.com/keep-me-too.flv' }] }],
    };
    const durlBefore = JSON.parse(JSON.stringify(holder.durl)) as unknown;
    const durlsBefore = JSON.parse(JSON.stringify(holder.durls)) as unknown;

    expect(rewriteDashOf(holder, DEFAULT_REWRITE_RULES).changed).toBe(true);
    expect(holder.durl).toEqual(durlBefore);
    expect(holder.durls).toEqual(durlsBefore);
  });

  it('★ 纯 `durl` 响应（没有 dash）→ 整块跳过、不抛错', () => {
    const holder: Record<string, unknown> = {
      durl: [{ url: 'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/x.flv' }],
      quality: 80,
    };

    // 没有 `dash` 键 → 走"缺 dash"那条早退（`{ dash?: unknown }` 允许它存在与否）
    expect(rewriteDashOf(holder as { dash?: unknown }, DEFAULT_REWRITE_RULES)).toEqual(NONE);
    expect(rec((holder.durl as unknown[])[0]).url).toBe(
      'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/x.flv',
    );
  });

  it('★ `dash` 里其它键（`minBufferTime` / 未知键）逐字段透传', () => {
    const holder = {
      dash: {
        duration: 1166,
        minBufferTime: 1.5,
        unknownKey: { nested: [1, 2, 3] },
        video: [track(PCDN)],
        audio: [],
      },
    };

    expect(rewriteDashOf(holder, DEFAULT_REWRITE_RULES).changed).toBe(true);
    expect(holder.dash.duration).toBe(1166);
    expect(holder.dash.minBufferTime).toBe(1.5);
    expect(holder.dash.unknownKey).toEqual({ nested: [1, 2, 3] });
    // 键集合没变（只是把候选换了）
    expect(Object.keys(holder.dash).sort()).toEqual(
      ['audio', 'duration', 'minBufferTime', 'unknownKey', 'video'].sort(),
    );
  });

  it('★ 驼峰形态（`baseUrl` / `backupUrl`）在容器里同样只输出驼峰', () => {
    const holder = {
      dash: {
        video: [{ baseUrl: PCDN, backupUrl: [OFFICIAL] }],
        audio: [{ baseUrl: OFFICIAL_2, backupUrl: [PCDN_2] }],
      },
    };

    const stats = rewriteDashOf(holder, DEFAULT_REWRITE_RULES);

    expect(stats.rewritten).toBe(2);
    const v = holder.dash.video[0] as Record<string, unknown>;
    expect(v.baseUrl).toBe(mirrorOf(PCDN));
    expect(v.backupUrl).toEqual([OFFICIAL]);
    expect(v.base_url).toBeUndefined();
    const a = holder.dash.audio[0] as Record<string, unknown>;
    expect(a.backupUrl).toEqual([mirrorOf(PCDN_2)]);
    expect(a.backup_url).toBeUndefined();
  });

  it('★ 不修改入参里的**轨**（未改动的容器保持原引用，改动的造新对象）', () => {
    const untouched = track(OFFICIAL);
    const before = JSON.parse(JSON.stringify(untouched)) as CandidateTrack;
    const holder = { dash: { video: [untouched, track(PCDN)], audio: [] } };

    rewriteDashOf(holder, DEFAULT_REWRITE_RULES);

    expect(untouched).toEqual(before);
    expect(holder.dash.video[0]).toBe(untouched);
    expect(holder.dash.video[1]).not.toBe(untouched);
  });
});
