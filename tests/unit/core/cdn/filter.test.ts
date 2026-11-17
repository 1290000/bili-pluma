// @vitest-environment node

/**
 * `filterPcdnCandidates()` 的判据表（ADR 0038 五条硬边界 + 三条工程约束）。
 *
 * ## 为什么每条判据都要单独立一条用例
 *
 * 这个函数**只做减法**，所以它的两种失败都是"静默"的：
 *
 * | 方向 | 后果 | 什么时候被发现 |
 * | --- | --- | --- |
 * | 少删一条 PCDN | 用户照旧走 PCDN，界面一切正常 | **永远不会** |
 * | 多删一条官方候选 | 用户少一条备份；全删还会删轨 | **只在故障那天** |
 *
 * 没有一条会在 CI 里自然暴露，所以只能靠这里的断言把两个方向都钉住。
 *
 * ## 用例与判据的对应关系
 *
 * 文件头 `src/core/cdn/filter.ts` 里列的 8 条判据，逐条都有对应用例，
 * 用例名前面标了编号（`判据1 …`），改判据时按编号找。
 */

import { describe, expect, it } from 'vitest';

import { filterPcdnCandidates, type CandidateTrack } from '@core/cdn/filter';

// ─────────────────────────── 样本 ───────────────────────────

/** 官方自建边缘（`cn-*` 命中 `SELF_BUILT_RE`），带取流凭据形状的 query */
const OFFICIAL = 'https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s?upsig=aa&deadline=20390101';
const OFFICIAL_2 = 'https://cn-jsnt-ct-01-08.bilivideo.com/v.m4s?upsig=bb&deadline=20390101';
/** 真实 PCDN 形状：`mcdn` 独立成标签 + 端口 */
const PCDN = 'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/v.m4s?upsig=cc';
const PCDN_2 = 'https://xy220x180x77x45xy.mcdn.bilivideo.cn:8082/v.m4s?upsig=dd';
/** 第三方 CDN（Akamai 形状） */
const THIRD = 'https://e1.akamaized.net/v.m4s?upsig=ee';
/** 认不出来源的域（`classifyCdn` 返回 unknown） */
const UNKNOWN = 'https://xyz.example-cdn.com/video/a.m4s?upsig=ff';

/** 造一条下划线风格的轨（其余字段用来验"透传不改"） */
function snake(
  base: string,
  backups: string[] = [],
  extra: Record<string, unknown> = {},
): CandidateTrack {
  return { base_url: base, backup_url: backups, ...extra };
}

describe('filterPcdnCandidates', () => {
  // ── 判据 1：只剔除 pcdn ──

  it('判据1 · 3 条全官方 → 原样返回（不产生新对象）', () => {
    const track = snake(OFFICIAL, [OFFICIAL_2, THIRD]);
    const { tracks, stats } = filterPcdnCandidates([track]);

    expect(stats).toEqual({ removed: 0, keptIntact: 0 });
    // 引用相等：一条都没删时不该造新对象（接线那轮靠这个让 diff 面等于 removed）
    expect(tracks[0]).toBe(track);
    expect(tracks[0]?.base_url).toBe(OFFICIAL);
    expect(tracks[0]?.backup_url).toEqual([OFFICIAL_2, THIRD]);
  });

  it('判据1 · third-party 与 unknown 都保留（unknown ≠ 该删）', () => {
    /**
     * 反例：把判据写成 `cls !== 'official'` 就删 → 这两条会消失。
     * 而 `unknown` 的意思是"我们认不出这个域"，删它等于拿未知换更少的备份。
     */
    const track = snake(THIRD, [UNKNOWN]);
    const { tracks, stats } = filterPcdnCandidates([track]);

    expect(stats).toEqual({ removed: 0, keptIntact: 0 });
    expect(tracks[0]).toBe(track);
    expect(tracks[0]?.base_url).toBe(THIRD);
    expect(tracks[0]?.backup_url).toEqual([UNKNOWN]);
  });

  // ── 判据 2：必须传 search ──

  it('判据2 · 官方域 + `os=mcdn` → 判 PCDN 并剔除（证明 search 真的传进去了）', () => {
    /**
     * `os=mcdn` 是官方镜像代理 mcdn 资源时**唯一**的信号（`classify.ts` 第 5 条）。
     * 只传 host 的话这条会被判成 official 而保留 —— 那正是"开关开着却在走 PCDN"。
     */
    const mirror = 'https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s?os=mcdn&upsig=gg';
    const { tracks, stats } = filterPcdnCandidates([snake(OFFICIAL, [mirror])]);

    expect(stats.removed).toBe(1);
    expect(tracks[0]?.backup_url).toEqual([]);
    expect(tracks[0]?.base_url).toBe(OFFICIAL);
  });

  // ── 判据 3：剔完就没了 → 整条原样 ──

  it('判据3 · 3 条全 PCDN → 整条原样、keptIntact=1、removed=0', () => {
    // ADR 0038 硬边界 5：删掉那条轨 = 用户点了 4K 却没有 4K
    const track = snake(PCDN, [PCDN_2, PCDN]);
    const { tracks, stats } = filterPcdnCandidates([track]);

    expect(stats).toEqual({ removed: 0, keptIntact: 1 });
    expect(tracks[0]).toBe(track);
    expect(tracks[0]?.base_url).toBe(PCDN);
    expect(tracks[0]?.backup_url).toHaveLength(2);
  });

  // ── 判据 4：不许新增 ──

  it('判据4 · 2 PCDN + 1 官方 → base 变官方、backup 为 []、removed=2', () => {
    const track = snake(PCDN, [PCDN_2, OFFICIAL]);
    const { tracks, stats } = filterPcdnCandidates([track]);

    expect(stats).toEqual({ removed: 2, keptIntact: 0 });
    expect(tracks[0]?.base_url).toBe(OFFICIAL);
    expect(tracks[0]?.backup_url).toEqual([]);
  });

  it('判据4 · ★ 输出的 URL 集合 ⊆ 输入的 URL 集合（防凭空造 URL）', () => {
    /**
     * 这条是"只减不增"的**结构性**回归：不管以后算法怎么改，
     * 只要输出里出现一条输入没有的 URL，就是编数据（签名多半也不对）。
     */
    const inputs = [
      snake(PCDN, [PCDN_2, OFFICIAL]),
      snake(OFFICIAL_2, [PCDN], { height: 2160 }),
      { baseUrl: PCDN, backupUrl: [OFFICIAL, OFFICIAL_2] },
    ];
    const allInputUrls = new Set(
      inputs.flatMap((t) => [
        t.base_url,
        t.baseUrl,
        ...(t.backup_url ?? []),
        ...(t.backupUrl ?? []),
      ]),
    );

    const { tracks } = filterPcdnCandidates(inputs);
    const allOutputUrls = tracks.flatMap((t) => [
      t.base_url,
      t.baseUrl,
      ...(t.backup_url ?? []),
      ...(t.backupUrl ?? []),
    ]);

    for (const url of allOutputUrls) {
      if (url === undefined) continue;
      expect(allInputUrls.has(url), `输出里出现了输入没有的 URL：${url}`).toBe(true);
    }
    // 反向：条数只能不变或减少
    expect(allOutputUrls.filter((u) => u !== undefined).length).toBeLessThanOrEqual(
      allInputUrls.size,
    );
  });

  // ── 判据 5：命名风格跟着输入走 ──

  it('判据5 · `baseUrl` / `backupUrl` 驼峰形态 → 输出仍是驼峰（不许混用）', () => {
    const camel: CandidateTrack = { baseUrl: PCDN, backupUrl: [OFFICIAL, PCDN_2] };
    const { tracks } = filterPcdnCandidates([camel]);
    const out = tracks[0] as Record<string, unknown>;

    expect(out.baseUrl).toBe(OFFICIAL);
    expect(out.backupUrl).toEqual([]);
    // 混用的后果：播放器按另一个名字读 → 读到 undefined → "某条轨没有流"
    expect(out.base_url).toBeUndefined();
    expect(out.backup_url).toBeUndefined();
  });

  // ── 判据 6：其它键一律透传 ──

  it('判据6 · quality / height / codecid / bandwidth 等字段原样透传', () => {
    const track = snake(PCDN, [OFFICIAL], {
      quality: 120,
      height: 2160,
      codecid: 7,
      bandwidth: 12345678,
      duration: 1166,
    });
    const { tracks } = filterPcdnCandidates([track]);

    expect(tracks[0]).toMatchObject({
      quality: 120,
      height: 2160,
      codecid: 7,
      bandwidth: 12345678,
      duration: 1166,
      base_url: OFFICIAL,
    });
  });

  it('判据6 · 没有 `backup_url` 字段也不崩（单候选轨）', () => {
    const { tracks, stats } = filterPcdnCandidates([{ base_url: PCDN }]);

    // 只有一条候选且是 PCDN → 剔完就没了 → 原样保留（判据 3）
    expect(stats).toEqual({ removed: 0, keptIntact: 1 });
    expect(tracks[0]?.base_url).toBe(PCDN);
  });

  // ── 判据 7：纯函数 ──

  it('判据7 · 不修改入参（调用前后 deepEqual）', () => {
    const track = snake(PCDN, [PCDN_2, OFFICIAL]);
    const before = JSON.parse(JSON.stringify(track)) as CandidateTrack;

    const { tracks } = filterPcdnCandidates([track]);

    expect(track).toEqual(before);
    expect(tracks[0]).not.toBe(track); // 改过的那条必须是新对象
  });

  // ── 判据 8：非法 URL 保留 ──

  it('判据8 · `new URL()` 抛错的候选保留（判不了就别删）', () => {
    const broken = 'not a url at all';
    const { tracks, stats } = filterPcdnCandidates([snake(PCDN, [broken, OFFICIAL])]);

    expect(stats.removed).toBe(1); // 只删了 PCDN
    expect(tracks[0]?.base_url).toBe(broken); // 非法的留在原位
    expect(tracks[0]?.backup_url).toEqual([OFFICIAL]);
  });

  // ── 顺序与组合 ──

  it('顺序保持：1 官方 + 2 PCDN + 1 官方 → 剩 2 条官方，相对顺序不变', () => {
    const track = snake(OFFICIAL, [PCDN, PCDN_2, OFFICIAL_2]);
    const { tracks, stats } = filterPcdnCandidates([track]);

    expect(stats).toEqual({ removed: 2, keptIntact: 0 });
    // 第 1 条是播放器最初选中的那条，不许重排（没有测速依据）
    expect(tracks[0]?.base_url).toBe(OFFICIAL);
    expect(tracks[0]?.backup_url).toEqual([OFFICIAL_2]);
  });

  it('多轨累计：removed / keptIntact 各自累加', () => {
    const { stats } = filterPcdnCandidates([
      snake(PCDN, [OFFICIAL]), // 删 1
      snake(PCDN, [PCDN_2]), // 全 PCDN → 整条保留 +1
      snake(OFFICIAL, [OFFICIAL_2]), // 不动
      snake(PCDN, [PCDN_2, PCDN]), // 全 PCDN → +1
    ]);

    expect(stats).toEqual({ removed: 1, keptIntact: 2 });
  });

  it('空输入 → 空输出、统计为零', () => {
    expect(filterPcdnCandidates([])).toEqual({ tracks: [], stats: { removed: 0, keptIntact: 0 } });
  });

  it('一条轨都没有候选字段 → 原样返回（认不出形态就不动）', () => {
    const bare: CandidateTrack = {};
    const { tracks, stats } = filterPcdnCandidates([bare]);

    expect(tracks[0]).toBe(bare);
    expect(stats).toEqual({ removed: 0, keptIntact: 0 });
  });
});
