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
  rewritePcdnCandidates,
  type CandidateTrack,
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
    const { tracks, stats } = rewritePcdnCandidates(
      [{ base_url: PCDN }],
      DEFAULT_REWRITE_RULES,
    );

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
    expect(tracks[0]?.backup_url).toEqual([
      mirrorOf(PCDN),
      mirrorOf(PCDN_2),
      OFFICIAL_2,
    ]);
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
