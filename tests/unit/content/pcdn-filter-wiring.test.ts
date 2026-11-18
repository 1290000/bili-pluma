// @vitest-environment jsdom

/**
 * 候选改写接线（ADR 0038 → **ADR 0039**）—— 主世界侧的判据与三个变换点。
 *
 * ## 这个文件守什么
 *
 * 改写代码在主世界（裸 JS），`filter.ts` 在 `core/`。两份实现**必须逐条结论一致**，
 * 否则"开关开着却在走 PCDN"或"官方候选被误改"都会静默发生 —— 前者的表现是
 * 功能不生效，后者只有真出故障那天才发现。
 *
 * 所以这里有两条主线：
 *
 * 1. **对账**：`isPcdnUrl()` vs `classifyCdn()`（跑 84 条实测 host 全集）、
 *    `filterOneTrack()` vs `rewritePcdnCandidates()`（同一批 fixture，含 host/path/条数）；
 * 2. **接线语义**：开关关闭时**一个字节都不改**、任一份规则缺失时不动响应体并报
 *    `reason: 'rulesMissing'`、进度 + 改写**一次解析一次序列化**、幂等、三处调用点。
 *
 * ## ADR 0039 的新不变量
 *
 * 输出**条数恒等于输入**，PCDN 的 host 换成下发的 mirrorHost、path/query/hash 不变，
 * 命中 `/v1/resource/upgcxcode/` 的走 proxy 包装。"删到只剩 1 条"的旧断言全部退休。
 *
 * ## 为什么用 `spliceTestExports` 而不是驱动 XHR
 *
 * 驱动 XHR 能覆盖"整条链路"，但很难断言"哪一次 JSON.parse 发生了"。
 * 这些判据要的正是后者（一次解析、两个变换）。所以把纯函数挂到测试出口上直接调，
 * 链路本身由 `main-world-progress.test.ts` / `main-world-pgc.test.ts` 覆盖。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { classifyCdn, PCDN_RULES } from '@core/cdn/classify';
import {
  DEFAULT_REWRITE_RULES,
  rewritePcdnCandidates,
  type CandidateTrack,
} from '@core/cdn/filter';
import { assertTestExports, spliceTestExports } from './helpers/main-world-exports';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');

const EXPOSED = [
  'isPcdnUrl',
  'rewriteCandidateUrl',
  'filterOneTrack',
  'filterDashOf',
  'patchPlayurlBody',
  'pcdnFilterReady',
  'pgcSwapPlayviewBody',
] as const;
const SPLICED = spliceTestExports(SOURCE, EXPOSED);

const VIDEO_URL = 'https://www.bilibili.com/video/BV1xx411c7mD';
const PGC_URL = 'https://www.bilibili.com/bangumi/play/ss34412';

/** 等一轮宏任务（jsdom 的 `postMessage` 是异步排队的） */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** 收集这一页里所有 `pcdn-filter-stats` 上报 */
function statsOf(sent: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return sent.filter((m) => m.type === 'pcdn-filter-stats');
}

interface TestPage extends Record<string, unknown> {
  __PLUMA_TEST__: Record<string, (...args: never[]) => unknown>;
}

interface Sandbox {
  win: JSDOM['window'];
  page: TestPage;
  sent: Array<Record<string, unknown>>;
}

/**
 * 起一个主世界沙盒并下发 `cfg`。
 *
 * @param filterOn 候选改写开关
 * @param withRules 是否带判据规则（`false` 用来构造"规则缺失"）
 * @param withRewriteRules 是否带镜像/proxy 规则（ADR 0039 的第二道门）
 */
async function boot(
  filterOn: boolean,
  withRules = true,
  withRewriteRules = true,
): Promise<Sandbox> {
  return bootAt(VIDEO_URL, filterOn, withRules, withRewriteRules);
}

/**
 * 在指定页面上起沙盒。
 *
 * `cfg` 的字段按真实链路发：`enabled` / `rewriteGate` 都是 `true`（否则 PGC 注入与
 * 响应体改写会被更早的门控拦下，这批用例会**因为错误的原因**变红）。
 */
async function bootAt(
  url: string,
  filterOn: boolean,
  withRules = true,
  withRewriteRules = true,
): Promise<Sandbox> {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url,
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const sent: Array<Record<string, unknown>> = [];

  win.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as Record<string, unknown> | null;
    if (d && d.__ns === '__PLUMA__') sent.push(d);
  });

  win.eval(SPLICED);
  const page = win as unknown as TestPage;
  assertTestExports(page as unknown as Record<string, unknown>, EXPOSED);

  win.postMessage(
    {
      __ns: '__PLUMA__',
      type: 'cfg',
      token: 'test-token',
      enabled: true,
      rewriteGate: true,
      filterCandidates: filterOn,
      ...(withRules ? { pcdnRules: PCDN_RULES } : {}),
      ...(withRewriteRules ? { pcdnRewriteRules: DEFAULT_REWRITE_RULES } : {}),
    },
    '*',
  );
  // jsdom 的 postMessage 是异步排队的（见 `main-world-pgc.test.ts` 的同一句注释）
  await flush();

  return { win, page, sent };
}

/** 按默认规则换 host 后的期望串（URL.host= 会保留原 port，须显式清掉） */
function mirrorOf(url: string): string {
  const parsed = new URL(url);
  const target = new URL(`https://${DEFAULT_REWRITE_RULES.mirrorHost}/`);
  parsed.hostname = target.hostname;
  parsed.port = target.port;
  return parsed.href;
}

/** 按默认规则走 proxy 包装后的期望串 */
function proxyOf(url: string): string {
  return `https://${DEFAULT_REWRITE_RULES.proxyHost}?url=${encodeURIComponent(url)}`;
}

/** 一条最小可用的 playurl 响应（dash 里两条轨，各带 1 base + 2/1 backup） */
function playurlJson(): string {
  return JSON.stringify({
    code: 0,
    data: {
      last_play_time: 0,
      last_play_cid: 0,
      dash: {
        duration: 1166,
        video: [
          {
            id: 80,
            height: 1080,
            base_url: 'https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s',
            backup_url: [
              'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/v.m4s',
              'https://cn-jsnt-ct-01-08.bilivideo.com/v.m4s',
            ],
          },
        ],
        audio: [
          {
            id: 30280,
            base_url: 'https://xy220x180x77x45xy.mcdn.bilivideo.cn:8082/a.m4s',
            backup_url: ['https://cn-jsnt-ct-01-07.bilivideo.com/a.m4s'],
          },
        ],
      },
    },
  });
}

/** 主世界 stats 的类型（与 core 的 FilterStats 对齐，额外带 changed） */
interface MwStats {
  changed: boolean;
  rewritten: number;
  proxied: number;
  fallbackKept: number;
}

describe('主世界判据 vs `classifyCdn`（对账）', () => {
  const BASELINE: Array<{ host: string }> = JSON.parse(
    readFileSync(resolve(process.cwd(), 'tests/fixtures/pcdn-hosts-baseline.json'), 'utf8'),
  ) as Array<{ host: string }>;

  it('★ 84 条实测 host：`isPcdnUrl()` 与 `classifyCdn()` **逐条一致**', async () => {
    const { page } = await boot(true);
    const isPcdnUrl = page.__PLUMA_TEST__.isPcdnUrl as unknown as (u: string) => boolean;

    const drift = BASELINE.map((row) => {
      const want = classifyCdn(row.host).cls === 'pcdn';
      const got = isPcdnUrl(`https://${row.host}/v.m4s`);
      return { host: row.host, want, got };
    }).filter((r) => r.want !== r.got);

    // 失败时把每一条漂移列出来，而不是只说"第 N 条不对"
    expect(drift).toEqual([]);
  });

  it('边角形态：`os=mcdn` / IP 直连 / 大写 / unknown / third-party', async () => {
    const { page } = await boot(true);
    const isPcdnUrl = page.__PLUMA_TEST__.isPcdnUrl as unknown as (u: string) => boolean;

    const cases: Array<[string, boolean]> = [
      // 官方域 + os=mcdn → PCDN（`classify.ts` 第 5 条，唯一能识破镜像代理的信号）
      ['https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s?os=mcdn', true],
      // 大写域名：URL 解析会小写化，判据不该因此失效
      ['https://XY116X196X140X25XY.MCDN.BILIVIDEO.CN/v.m4s', true],
      // 裸 IP：PCDN 节点多是 IP 直连
      ['http://123.45.67.89:8082/v.m4s', true],
      // 认不出 / 第三方 → **都不该换**
      ['https://xyz.example-cdn.com/v.m4s', false],
      ['https://e1.akamaized.net/v.m4s', false],
      // 官方自建 / 服务商镜像 → 保留
      ['https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s', false],
      ['https://upos-sz-mirrorcoso1.bilivideo.com/v.m4s', false],
      // 非法 URL → 判不了就别改
      ['not a url', false],
    ];

    for (const [url, want] of cases) {
      expect(isPcdnUrl(url), url).toBe(want);
      // 与 core 的分类器结论对齐（IP / 非法串那边 core 的口径见下）
      if (url.startsWith('http')) {
        expect(isPcdnUrl(url), url).toBe(
          classifyCdn(new URL(url).hostname, new URL(url).search).cls === 'pcdn',
        );
      }
    }
  });
});

describe('主世界 `rewriteCandidateUrl()` vs core 的两条规则', () => {
  const PCDN = 'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/v.m4s?upsig=cc';
  const PROXY_PATH =
    'https://xy116x196x140x25xy.mcdn.bilivideo.cn/v1/resource/upgcxcode/x.m4s?upsig=dd';

  it('★ 普通 PCDN → mirrorHost，path/query 原样；port 一并换掉', async () => {
    const { page } = await boot(true);
    const rewrite = page.__PLUMA_TEST__.rewriteCandidateUrl as unknown as (
      u: string,
      stats?: MwStats,
    ) => string;
    const stats: MwStats = { changed: false, rewritten: 0, proxied: 0, fallbackKept: 0 };

    const out = rewrite(PCDN, stats);
    expect(out).toBe(mirrorOf(PCDN));
    expect(new URL(out).host).toBe(DEFAULT_REWRITE_RULES.mirrorHost);
    expect(new URL(out).pathname + new URL(out).search).toBe('/v.m4s?upsig=cc');
    expect(stats).toEqual({ changed: false, rewritten: 1, proxied: 0, fallbackKept: 0 });
  });

  it('★ `/v1/resource/upgcxcode/` → proxy 包装（原 URL 完整编码）', async () => {
    const { page } = await boot(true);
    const rewrite = page.__PLUMA_TEST__.rewriteCandidateUrl as unknown as (
      u: string,
      stats?: MwStats,
    ) => string;
    const stats: MwStats = { changed: false, rewritten: 0, proxied: 0, fallbackKept: 0 };

    expect(rewrite(PROXY_PATH, stats)).toBe(proxyOf(PROXY_PATH));
    expect(stats).toEqual({ changed: false, rewritten: 1, proxied: 1, fallbackKept: 0 });
  });

  it('规则没到 / 非法 URL → 返回原串（判不了就别改）', async () => {
    const noRules = await boot(true, true, false);
    const rewriteNoRules = noRules.page.__PLUMA_TEST__.rewriteCandidateUrl as unknown as (
      u: string,
    ) => string;
    expect(rewriteNoRules(PCDN)).toBe(PCDN);

    const { page } = await boot(true);
    const rewrite = page.__PLUMA_TEST__.rewriteCandidateUrl as unknown as (
      u: string,
      stats?: MwStats,
    ) => string;
    const stats: MwStats = { changed: false, rewritten: 0, proxied: 0, fallbackKept: 0 };
    expect(rewrite('not a url', stats)).toBe('not a url');
    expect(stats.fallbackKept).toBe(1);
    // 官方候选一字不动，且不计数
    expect(rewrite('https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s', stats)).toBe(
      'https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s',
    );
    expect(stats.rewritten).toBe(0);
    expect(stats.fallbackKept).toBe(1);
    // 对照：真的 PCDN 仍会计数（确认上面的 0 不是"函数走空"）
    expect(rewrite(PCDN, stats)).toBe(mirrorOf(PCDN));
    expect(stats.rewritten).toBe(1);
  });
});

describe('`filterOneTrack()` vs `rewritePcdnCandidates()`（对账）', () => {
  const OFFICIAL = 'https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s';
  const OFFICIAL_2 = 'https://cn-jsnt-ct-01-08.bilivideo.com/v.m4s';
  const PCDN = 'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/v.m4s';
  const PROXY_PATH = 'https://xy116x196x140x25xy.mcdn.bilivideo.cn/v1/resource/upgcxcode/x.m4s';

  const TRACKS: Array<CandidateTrack & Record<string, unknown>> = [
    { base_url: OFFICIAL, backup_url: [OFFICIAL_2, PCDN] },
    { base_url: PCDN, backup_url: [PCDN, PCDN] },
    { baseUrl: PCDN, backupUrl: [OFFICIAL] },
    { base_url: 'https://e1.akamaized.net/v.m4s', backup_url: [] },
    { base_url: 'not a url', backup_url: [PCDN, OFFICIAL] },
    { base_url: PROXY_PATH, backup_url: [] },
    // 没有候选字段、只有元信息 → 两个实现都该原样返回
    { quality: 120 },
  ];

  it('★ 七条轨逐条一致（含全 PCDN、驼峰、非法 URL、proxy、无候选字段）', async () => {
    const { page } = await boot(true);
    const filterOneTrack = page.__PLUMA_TEST__.filterOneTrack as unknown as (
      t: unknown,
      stats: MwStats,
    ) => unknown;

    const core = rewritePcdnCandidates(TRACKS, DEFAULT_REWRITE_RULES);
    const mwStats: MwStats = { changed: false, rewritten: 0, proxied: 0, fallbackKept: 0 };

    for (const [i, track] of TRACKS.entries()) {
      const got = filterOneTrack(track, mwStats);
      expect(got, `track #${String(i)}`).toEqual(core.tracks[i]);
    }
    expect(mwStats).toEqual({
      changed: true,
      rewritten: core.stats.rewritten,
      proxied: core.stats.proxied,
      fallbackKept: core.stats.fallbackKept,
    });
  });
});

describe('接线语义：开关 / 规则 / 一次解析 / 幂等', () => {
  const RAW = playurlJson();

  it('★ 开关关闭 → 输出与输入**逐字节相同**（返回 null，调用方保持原响应）', async () => {
    const { page } = await boot(false);
    const patchPlayurlBody = page.__PLUMA_TEST__.patchPlayurlBody as unknown as (
      raw: string,
      prog: unknown,
      wantFilter: boolean,
    ) => string | null;

    expect(patchPlayurlBody(RAW, null, false)).toBeNull();
    // 传了进度但值本来就相等 → 同样不动
    expect(patchPlayurlBody(RAW, { time: 0, cid: 0 }, false)).toBeNull();
  });

  it('★ 组合：进度 + 改写**一次解析一次序列化**，两者同时生效', async () => {
    const { page, sent } = await boot(true);
    const patchPlayurlBody = page.__PLUMA_TEST__.patchPlayurlBody as unknown as (
      raw: string,
      prog: unknown,
      wantFilter: boolean,
    ) => string | null;

    const out = patchPlayurlBody(RAW, { time: 42, cid: 99 }, true);
    expect(out).not.toBeNull();

    const parsed = JSON.parse(out ?? '{}') as {
      data: {
        last_play_time: number;
        last_play_cid: number;
        dash: {
          duration: number;
          video: Array<Record<string, unknown>>;
          audio: Array<Record<string, unknown>>;
        };
      };
    };
    // ① 进度生效
    expect(parsed.data.last_play_time).toBe(42);
    expect(parsed.data.last_play_cid).toBe(99);
    // ② 改写生效：官方 base 不动，PCDN backup 换 host 但**条数不变**
    const video = parsed.data.dash.video[0];
    expect(video?.base_url).toBe('https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s');
    expect(video?.backup_url).toEqual([
      mirrorOf('https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/v.m4s'),
      'https://cn-jsnt-ct-01-08.bilivideo.com/v.m4s',
    ]);
    expect((video?.backup_url as string[]).length).toBe(2);
    const audio = parsed.data.dash.audio[0];
    expect(audio?.base_url).toBe(
      mirrorOf('https://xy220x180x77x45xy.mcdn.bilivideo.cn:8082/a.m4s'),
    );
    expect(audio?.backup_url).toEqual(['https://cn-jsnt-ct-01-07.bilivideo.com/a.m4s']);
    // ③ `dash` 的其它键一个字节没动
    expect(parsed.data.dash.duration).toBe(1166);
    // ④ 上报了一条改写统计
    await new Promise((r) => setTimeout(r, 0));
    const stat = sent.find((m) => m.type === 'pcdn-filter-stats');
    expect(stat).toMatchObject({ applied: true, where: 'playurl' });
  });

  it('★ 幂等：连跑两次 = 跑一次（第二次返回 null）', async () => {
    const { page } = await boot(true);
    const patchPlayurlBody = page.__PLUMA_TEST__.patchPlayurlBody as unknown as (
      raw: string,
      prog: unknown,
      wantFilter: boolean,
    ) => string | null;

    const once = patchPlayurlBody(RAW, null, true);
    expect(once).not.toBeNull();
    // 把结果再喂一遍：候选已经全是非 PCDN，且没有进度要改 → 一个字节都不用动
    expect(patchPlayurlBody(once ?? '', null, true)).toBeNull();
  });

  it('★ 规则缺失 → 不改 + `applied:false` + `reason:rulesMissing`（每页只报一次）', async () => {
    const { page, sent } = await boot(true, false, false);
    const pcdnFilterReady = page.__PLUMA_TEST__.pcdnFilterReady as unknown as () => boolean;
    const patchPlayurlBody = page.__PLUMA_TEST__.patchPlayurlBody as unknown as (
      raw: string,
      prog: unknown,
      wantFilter: boolean,
    ) => string | null;

    const ready = pcdnFilterReady();
    expect(ready).toBe(false);
    expect(patchPlayurlBody(RAW, null, ready)).toBeNull();

    await flush();
    const stats = statsOf(sent);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      applied: false,
      rewritten: 0,
      proxied: 0,
      fallbackKept: 0,
      reason: 'rulesMissing',
    });

    expect(pcdnFilterReady()).toBe(false);
    await flush();
    expect(statsOf(sent)).toHaveLength(1);
  });

  it('★ ADR 0039 第二道门：判据到了但镜像规则没到 → 不动响应体', async () => {
    const sb = await boot(true, true, false);
    const pcdnFilterReady = sb.page.__PLUMA_TEST__.pcdnFilterReady as unknown as () => boolean;
    const patchPlayurlBody = sb.page.__PLUMA_TEST__.patchPlayurlBody as unknown as (
      raw: string,
      prog: unknown,
      wantFilter: boolean,
    ) => string | null;

    expect(pcdnFilterReady()).toBe(false);
    expect(patchPlayurlBody(RAW, null, false)).toBeNull();
    await flush();
    expect(statsOf(sb.sent)[0]).toMatchObject({ applied: false, reason: 'rulesMissing' });
  });

  it('规则到了之后同一个判定点返回 true（缺失不等于永久关闭）', async () => {
    const { page } = await boot(true, true, true);
    const pcdnFilterReady = page.__PLUMA_TEST__.pcdnFilterReady as unknown as () => boolean;
    expect(pcdnFilterReady()).toBe(true);
  });

  it('`dash` 缺失 / `dash.video` 不是数组 → 原样返回，不抛错', async () => {
    const { page } = await boot(true);
    const patchPlayurlBody = page.__PLUMA_TEST__.patchPlayurlBody as unknown as (
      raw: string,
      prog: unknown,
      wantFilter: boolean,
    ) => string | null;
    const filterDashOf = page.__PLUMA_TEST__.filterDashOf as unknown as (h: unknown) => {
      changed: boolean;
    };

    expect(filterDashOf({}).changed).toBe(false);
    expect(filterDashOf({ dash: null }).changed).toBe(false);
    expect(filterDashOf({ dash: { video: 'nope' } }).changed).toBe(false);
    expect(filterDashOf(null).changed).toBe(false);

    // 整份响应没有 dash（纯 durl / FLV）→ 一个字节都不改
    const durlOnly = JSON.stringify({ code: 0, data: { durl: [{ url: 'https://x/v.m4s' }] } });
    expect(patchPlayurlBody(durlOnly, null, true)).toBeNull();
  });

  it('⛔ 不碰 `durl` / `durls`（FLV 那条路本轮不做）', async () => {
    const { page } = await boot(true);
    const filterDashOf = page.__PLUMA_TEST__.filterDashOf as unknown as (h: unknown) => MwStats;

    const holder = {
      dash: {
        video: [
          {
            base_url: 'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/v.m4s',
            backup_url: ['https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s'],
          },
        ],
      },
      durl: [{ url: 'keep-me' }],
      durls: [{ durl: [{ url: 'keep-me-too' }] }],
    };
    expect(filterDashOf(holder).rewritten).toBe(1);
    expect(holder.durl).toEqual([{ url: 'keep-me' }]);
    expect(holder.durls).toEqual([{ durl: [{ url: 'keep-me-too' }] }]);
  });
});

/**
 * ## `dash.flac.audio` 与 `dash.dolby.audio[]`：两个曾经完全没被过滤的容器
 *
 * `filterDashOf()` 原先只遍历 `dash.video` / `dash.audio`，而 B站 playurl 里还有
 * 两处同样带候选地址的音轨容器，形状各不相同：
 *
 * | 容器 | 形状 | 依据 |
 * | --- | --- | --- |
 * | `dash.flac.audio` | **单个** track 对象（外层 `dash.flac.display` 是布尔） | `core/playinfo/parse.ts` 的 `parseDash()` 用 `isRecord(flacObj?.audio)` |
 * | `dash.dolby.audio` | track **数组**（外层 `dash.dolby.vision` 是布尔） | 同一处用 `arr(dolbyObj?.audio)` |
 *
 * 漏掉的后果是**静默失败**：Hi-Res / 杜比全景声那几轨照旧走 PCDN，
 * 而开关是开着的、界面一切正常 —— 正是 `core/cdn/classify.ts` 点名的
 * 「最坏失败方向」。历史上没测到，是因为 `poc/probe/pcdn-diag/remaining-candidates.json`
 * 那 8 个 UGC 视频的 `flac` / `dolby` 全是 null，样本没覆盖到这一块。
 *
 * 不变量与 `video` / `audio` **完全相同**（ADR 0039 八条硬边界）：
 * 条数不变、只换 authority、`pathname`/`search`/`hash` 一字不动、其余字段透传。
 */
describe('`filterDashOf()` 也覆盖 `dash.flac.audio` / `dash.dolby.audio[]`', () => {
  const OFFICIAL = 'https://cn-jsnt-ct-01-07.bilivideo.com/a.m4s';
  const PCDN = 'https://xy220x180x77x45xy.mcdn.bilivideo.cn:8082/a.m4s?upsig=aa';
  const PCDN_PROXY = 'https://xy116x196x140x25xy.mcdn.bilivideo.cn/v1/resource/upgcxcode/f.m4s';
  const PCDN_DOMAIN = 'https://a1.szbdyd.com/d.m4s';

  /** 每个用例都重新取一次出口（沙盒里的闭包状态互不影响） */
  async function filterDashOfOf(): Promise<(h: unknown) => MwStats> {
    const { page } = await boot(true);
    return page.__PLUMA_TEST__.filterDashOf as unknown as (h: unknown) => MwStats;
  }

  it('★ flac：单个 track 里的 PCDN 候选换 host，条数不变、path/search 不动', async () => {
    const filterDashOf = await filterDashOfOf();

    const holder = {
      dash: {
        duration: 1166,
        video: [],
        audio: [],
        flac: {
          display: true,
          audio: {
            id: 30251,
            bandwidth: 1500000,
            base_url: PCDN,
            backup_url: [OFFICIAL],
          },
        },
      },
    };

    const stats = filterDashOf(holder);
    expect(stats).toEqual({ changed: true, rewritten: 1, proxied: 0, fallbackKept: 0 });

    const flac = (holder.dash as Record<string, unknown>).flac as Record<string, unknown>;
    const track = flac.audio as Record<string, unknown>;
    expect(track.base_url).toBe(mirrorOf(PCDN));
    // 条数严格不变（ADR 0039 边界 2）
    expect(track.backup_url).toEqual([OFFICIAL]);
    expect((track.backup_url as string[]).length).toBe(1);
    // path/search 一字不动（边界 1）
    const parsed = new URL(track.base_url as string);
    expect(parsed.pathname + parsed.search).toBe('/a.m4s?upsig=aa');
    // 同一条轨上的非候选字段透传
    expect(track.id).toBe(30251);
    expect(track.bandwidth).toBe(1500000);
  });

  it('★ dolby：数组里至少两条轨各自换 host，且顺序与条数不变', async () => {
    const filterDashOf = await filterDashOfOf();

    const holder = {
      dash: {
        video: [],
        audio: [],
        dolby: {
          vision: true,
          audio: [
            // ① base PCDN + 官方 backup
            { id: 30250, base_url: PCDN, backup_url: [OFFICIAL] },
            // ② backup 里有一整条走 proxy 的 PCDN，另一条是官方
            { id: 30251, base_url: OFFICIAL, backup_url: [PCDN_PROXY, OFFICIAL] },
          ],
        },
      },
    };

    const stats = filterDashOf(holder);
    // ① 的 base（1 条）+ ② 的 backup 里的 proxy 那一条 = 2 条
    expect(stats.rewritten).toBe(2);
    expect(stats.proxied).toBe(1);
    expect(stats.changed).toBe(true);

    const dolby = (holder.dash as Record<string, unknown>).dolby as Record<string, unknown>;
    const list = dolby.audio as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);

    expect(list[0]?.base_url).toBe(mirrorOf(PCDN));
    expect(list[0]?.backup_url).toEqual([OFFICIAL]);
    expect(new URL(list[0]?.base_url as string).pathname).toBe('/a.m4s');

    expect(list[1]?.base_url).toBe(OFFICIAL);
    expect(list[1]?.backup_url).toEqual([proxyOf(PCDN_PROXY), OFFICIAL]);
    expect((list[1]?.backup_url as string[]).length).toBe(2);
    // 轨顺序/身份没被换位（只是就地换 authority）
    expect(list[0]?.id).toBe(30250);
    expect(list[1]?.id).toBe(30251);
  });

  it('★ `flac.display` / `dolby.vision` / `dash.duration` 逐字段不动（深比较）', async () => {
    const filterDashOf = await filterDashOfOf();

    const holder = {
      dash: {
        duration: 1166,
        minBufferTime: 1.5,
        video: [],
        audio: [],
        flac: {
          display: true,
          audio: { base_url: PCDN, backup_url: [OFFICIAL] },
        },
        dolby: {
          vision: true,
          type: 2,
          audio: [{ base_url: PCDN_DOMAIN, backup_url: [] }],
        },
      },
    };
    /**
     * 深拷一份原文做对照 —— 只比对**非候选字段**，
     * 因为候选字段本来就该变（这正是本函数的职责）。
     */
    const before = JSON.parse(JSON.stringify(holder)) as {
      dash: Record<string, unknown>;
    };

    expect(filterDashOf(holder).changed).toBe(true);

    const dash = holder.dash as Record<string, unknown>;
    expect(dash.duration).toBe(before.dash.duration);
    expect(dash.minBufferTime).toBe(before.dash.minBufferTime);
    expect((dash.flac as Record<string, unknown>).display).toBe(true);
    expect((dash.dolby as Record<string, unknown>).vision).toBe(true);
    expect((dash.dolby as Record<string, unknown>).type).toBe(2);
    // 非候选字段集合与顺序都没变（候选三键之外一模一样）
    const stripCandidates = (o: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) {
        if (k === 'base_url' || k === 'backup_url' || k === 'baseUrl' || k === 'backupUrl')
          continue;
        out[k] = o[k];
      }
      return out;
    };
    const flacNow = dash.flac as Record<string, unknown>;
    const dolbyNow = dash.dolby as Record<string, unknown>;
    expect(stripCandidates(flacNow.audio as Record<string, unknown>)).toEqual(
      stripCandidates(
        (before.dash.flac as Record<string, unknown>).audio as Record<string, unknown>,
      ),
    );
    expect(stripCandidates((dolbyNow.audio as Array<Record<string, unknown>>)[0] ?? {})).toEqual(
      stripCandidates(
        (
          (before.dash.dolby as Record<string, unknown>).audio as Array<Record<string, unknown>>
        )[0] ?? {},
      ),
    );
  });

  it('★ 一个候选都没改（含 flac/dolby）→ `holder.dash` 引用不变（不制造无谓 diff）', async () => {
    const filterDashOf = await filterDashOfOf();

    const holder = {
      dash: {
        video: [],
        audio: [],
        flac: { display: false, audio: { base_url: OFFICIAL, backup_url: [] } },
        dolby: { vision: false, audio: [{ base_url: OFFICIAL, backup_url: [OFFICIAL] }] },
      },
    };
    const dashBefore = holder.dash;

    const stats = filterDashOf(holder);
    expect(stats.changed).toBe(false);
    expect(stats.rewritten).toBe(0);
    expect(holder.dash).toBe(dashBefore);
  });

  it('★ 只在 flac 改了时，`dash.dolby` 保持原引用（只复制真变了的那一层）', async () => {
    const filterDashOf = await filterDashOfOf();

    const holder = {
      dash: {
        video: [],
        audio: [],
        flac: { display: true, audio: { base_url: PCDN, backup_url: [] } },
        dolby: { vision: false, audio: [{ base_url: OFFICIAL, backup_url: [] }] },
      },
    };
    const dolbyBefore = holder.dash.dolby;

    expect(filterDashOf(holder).changed).toBe(true);
    expect((holder.dash as Record<string, unknown>).dolby).toBe(dolbyBefore);
    expect(((holder.dash as Record<string, unknown>).flac as Record<string, unknown>).display).toBe(
      true,
    );
  });

  it('★ 幂等：改过一遍再喂回去 → 第二次 `changed:false` 且 `dash` 引用不变', async () => {
    const filterDashOf = await filterDashOfOf();

    const holder = {
      dash: {
        video: [
          { base_url: 'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/v.m4s', backup_url: [] },
        ],
        audio: [],
        flac: { display: true, audio: { base_url: PCDN, backup_url: [OFFICIAL] } },
        dolby: { vision: true, audio: [{ base_url: PCDN_DOMAIN, backup_url: [] }] },
      },
    };

    expect(filterDashOf(holder).changed).toBe(true);
    const dashAfterFirst = holder.dash;

    const second = filterDashOf(holder);
    expect(second).toEqual({ changed: false, rewritten: 0, proxied: 0, fallbackKept: 0 });
    // 第二次一条都没改 → 连 `holder.dash` 都不该被替换
    expect(holder.dash).toBe(dashAfterFirst);
  });

  it('★ 畸形输入：`flac` 为 null / 缺 `audio` / `audio` 是字符串 / `dolby.audio` 非数组 → 不抛错', async () => {
    const filterDashOf = await filterDashOfOf();

    const malformed: unknown[] = [
      // flac 为 null
      { dash: { video: [], audio: [], flac: null } },
      // flac 是对象但缺 audio
      { dash: { video: [], audio: [], flac: { display: true } } },
      // flac.audio 是字符串
      { dash: { video: [], audio: [], flac: { display: true, audio: 'nope' } } },
      // flac.audio 是数组（形状不对：这里当"不是单个 record"处理 → 跳过）
      { dash: { video: [], audio: [], flac: { display: true, audio: [] } } },
      // flac 本身是个字符串
      { dash: { video: [], audio: [], flac: 'nope' } },
      // dolby 缺 audio
      { dash: { video: [], audio: [], dolby: { vision: true } } },
      // dolby.audio 是对象而非数组
      { dash: { video: [], audio: [], dolby: { vision: true, audio: { base_url: PCDN } } } },
      // dolby 是 null
      { dash: { video: [], audio: [], dolby: null } },
      // 只有畸形容器、没有 video/audio → 整块跳过
      { dash: { flac: null, dolby: { vision: true } } },
    ];

    for (const [i, h] of malformed.entries()) {
      const out = filterDashOf(h);
      expect(out, `case #${String(i)}`).toEqual({
        changed: false,
        rewritten: 0,
        proxied: 0,
        fallbackKept: 0,
      });
    }
  });

  it('★ 容器里的轨本身缺候选字段 / 候选是非 URL 串 → 不抛错，其它容器照旧改', async () => {
    const filterDashOf = await filterDashOfOf();

    const holder = {
      dash: {
        video: [],
        audio: [],
        // 只有元信息，没有候选 → filterOneTrack 原样返回
        flac: { display: true, audio: { id: 30251, bandwidth: 1500000 } },
        dolby: {
          vision: false,
          audio: [
            // 非法 URL → 边界 5：判不了就别改（fallbackKept++）
            { base_url: 'not a url', backup_url: [] },
            { base_url: PCDN, backup_url: [] },
          ],
        },
      },
    };

    const stats = filterDashOf(holder);
    expect(stats.changed).toBe(true);
    expect(stats.rewritten).toBe(1);
    expect(stats.fallbackKept).toBe(1);

    const dolby = (holder.dash as Record<string, unknown>).dolby as Record<string, unknown>;
    const list = dolby.audio as Array<Record<string, unknown>>;
    expect(list[0]?.base_url).toBe('not a url'); // 原样保留
    expect(list[1]?.base_url).toBe(mirrorOf(PCDN));
  });
});

/**
 * ## 三处调用点，一处都不能少（ADR 0038 背景 §二的核心事实）
 *
 * 候选来源有**三条消费路径**，不是一条：
 *
 * | 场景 | 数据来源 | 谁在消费 |
 * | --- | --- | --- |
 * | `/video` | playurl 的 XHR 响应 | 播放器（`__playinfo__` 已被藏掉） |
 * | PGC 整页 | 我们注入的 `__playinfo__.result.video_info` | 播放器 |
 * | PGC SPA 切集 | `GET /ogv/player/playview` 的响应 | 播放器（此时 `__playinfo__` 完全不动） |
 *
 * 第三行是**番剧切集唯一走的那条**，也正是"只接 playurl"会整类漏掉的地方。
 */
describe('三处调用点各自真的改写（只接一处 = 一整类场景漏过去）', () => {
  const OFFICIAL = 'https://cn-jsnt-ct-01-07.bilivideo.com/v.m4s';
  const OFFICIAL_2 = 'https://cn-jsnt-ct-01-08.bilivideo.com/v.m4s';
  /** 标签判据（`mcdn` 子域挂在官方域下） */
  const PCDN = 'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/v.m4s';
  /** 供应商自有域判据 */
  const PCDN_DOMAIN = 'https://a1.szbdyd.com/x.m4s';

  it('① 普通视频 playurl → where=playurl，换的条数精确', async () => {
    const { page, sent } = await boot(true);
    const patchPlayurlBody = page.__PLUMA_TEST__.patchPlayurlBody as unknown as (
      raw: string,
      prog: unknown,
      wantFilter: boolean,
    ) => string | null;

    const out = patchPlayurlBody(playurlJson(), null, true);
    expect(out).not.toBeNull();

    const parsed = JSON.parse(out ?? '{}') as {
      data: {
        dash: { video: Array<Record<string, unknown>>; audio: Array<Record<string, unknown>> };
      };
    };
    // video：base 官方、backup [PCDN, 官方] → 换 1 条，backup 仍 2 条
    expect(parsed.data.dash.video[0]?.base_url).toBe(OFFICIAL);
    expect(parsed.data.dash.video[0]?.backup_url).toEqual([mirrorOf(PCDN), OFFICIAL_2]);
    // audio：base 是 PCDN → 换 host（不是被官方补位），backup 官方不动
    expect(parsed.data.dash.audio[0]?.base_url).toBe(
      mirrorOf('https://xy220x180x77x45xy.mcdn.bilivideo.cn:8082/a.m4s'),
    );
    expect(parsed.data.dash.audio[0]?.backup_url).toEqual([
      'https://cn-jsnt-ct-01-07.bilivideo.com/a.m4s',
    ]);

    await flush();
    expect(statsOf(sent).pop()).toMatchObject({
      where: 'playurl',
      applied: true,
      rewritten: 2,
      proxied: 0,
      fallbackKept: 0,
    });
  });

  it('② PGC 整页注入 → where=playinfo，注入的 dash 里 PCDN 已换 host', async () => {
    const CID = 281989571;
    const sb = await bootAt(PGC_URL, true);

    sb.win.sessionStorage.setItem(
      `pluma:pgc-vi:${String(CID)}`,
      JSON.stringify({ vi: cachedViWithPcdn(), exp: Date.now() + 60_000 }),
    );

    sb.page.__playinfo__ = ssrPreviewOf(CID);

    const vi = (
      sb.page.__playinfo__ as {
        result: { video_info: Record<string, unknown> };
      }
    ).result.video_info;
    const dash = vi.dash as { video: Array<Record<string, unknown>>; duration: number };

    expect(dash).toBeDefined();
    // base 换 host、backup 官方不动、条数不变
    expect(dash.video[0]?.base_url).toBe(mirrorOf(PCDN));
    expect(dash.video[0]?.backup_url).toEqual([OFFICIAL]);
    expect((dash.video[0]?.backup_url as string[]).length).toBe(1);
    // 边界 3：`height` / `codecid` 一个字节没动
    expect(dash.video[0]?.height).toBe(2160);
    expect(dash.video[0]?.codecid).toBe(12);
    expect(dash.duration).toBe(1441);

    await flush();
    expect(statsOf(sb.sent).pop()).toMatchObject({
      where: 'playinfo',
      applied: true,
      rewritten: 1,
    });
  });

  it('③ PGC SPA 切集换流 → where=playview，换进去的 dash 已改写', async () => {
    const sb = await bootAt(PGC_URL, true);
    const swap = sb.page.__PLUMA_TEST__.pgcSwapPlayviewBody as unknown as (
      body: unknown,
      fetchImpl: unknown,
    ) => Promise<string | null>;

    const full = {
      quality: 120,
      timelength: 1_440_000,
      format: 'hdflv2',
      type: 'DASH',
      accept_quality: [125, 120, 112, 80],
      dash: {
        duration: 1200,
        video: [
          {
            id: 120,
            height: 2160,
            codecid: 12,
            bandwidth: 9_000_000,
            base_url: PCDN,
            backup_url: [OFFICIAL, PCDN_DOMAIN],
          },
        ],
        audio: [{ id: 30280, base_url: OFFICIAL_2, backup_url: [] }],
      },
    };

    const fetchImpl = () =>
      Promise.resolve({ json: () => Promise.resolve({ code: 0, result: full }) });

    const out = await swap(playviewBodyOf(733318), fetchImpl);
    expect(out).not.toBeNull();

    const body = JSON.parse(out ?? '{}') as {
      data: { video_info: { dash: { video: Array<Record<string, unknown>>; duration: number } } };
    };
    const track = body.data.video_info.dash.video[0];

    // 两条 PCDN 都换 host，官方 backup 不动，条数不变
    expect(track?.base_url).toBe(mirrorOf(PCDN));
    expect(track?.backup_url).toEqual([OFFICIAL, mirrorOf(PCDN_DOMAIN)]);
    expect((track?.backup_url as string[]).length).toBe(2);
    // 边界 3：元信息不动
    expect(track?.height).toBe(2160);
    expect(track?.bandwidth).toBe(9_000_000);
    expect(body.data.video_info.dash.duration).toBe(1200);

    await flush();
    expect(statsOf(sb.sent).pop()).toMatchObject({
      where: 'playview',
      applied: true,
      rewritten: 2,
    });
  });

  it('②③ 开关关闭时，PGC 两条路都**一个字节都不改**', async () => {
    const CID = 281989571;
    const sb = await bootAt(PGC_URL, false);

    sb.win.sessionStorage.setItem(
      `pluma:pgc-vi:${String(CID)}`,
      JSON.stringify({ vi: cachedViWithPcdn(), exp: Date.now() + 60_000 }),
    );
    sb.page.__playinfo__ = ssrPreviewOf(CID);

    const vi = (
      sb.page.__playinfo__ as {
        result: { video_info: Record<string, unknown> };
      }
    ).result.video_info;
    const track = (vi.dash as { video: Array<Record<string, unknown>> }).video[0];

    expect(track?.base_url).toBe(PCDN);
    expect(track?.backup_url).toEqual([OFFICIAL]);

    const swap = sb.page.__PLUMA_TEST__.pgcSwapPlayviewBody as unknown as (
      body: unknown,
      fetchImpl: unknown,
    ) => Promise<string | null>;
    const full = {
      quality: 120,
      timelength: 1_440_000,
      format: 'hdflv2',
      type: 'DASH',
      dash: {
        duration: 1200,
        video: [{ id: 120, height: 2160, base_url: PCDN, backup_url: [OFFICIAL] }],
        audio: [],
      },
    };
    const out = await swap(playviewBodyOf(733318), () =>
      Promise.resolve({ json: () => Promise.resolve({ code: 0, result: full }) }),
    );
    const body = JSON.parse(out ?? '{}') as {
      data: { video_info: { dash: { video: Array<Record<string, unknown>> } } };
    };
    expect(body.data.video_info.dash.video[0]?.base_url).toBe(PCDN);
    expect(body.data.video_info.dash.video[0]?.backup_url).toEqual([OFFICIAL]);

    await flush();
    expect(statsOf(sb.sent)).toHaveLength(0);
  });

  /** 缓存里的完整流：video 轨的 base 是 PCDN、backup 是官方 */
  function cachedViWithPcdn() {
    return {
      quality: 120,
      timelength: 1_440_083,
      format: 'hdflv2',
      type: 'DASH',
      dash: {
        duration: 1441,
        video: [{ id: 120, height: 2160, codecid: 12, base_url: PCDN, backup_url: [OFFICIAL] }],
        audio: [{ id: 30280, base_url: OFFICIAL_2, backup_url: [] }],
      },
      accept_quality: [120, 112, 80],
    };
  }

  /** 主账号只能试看的 SSR（ADR 0020 的注入输入） */
  function ssrPreviewOf(cid: number) {
    return {
      code: 0,
      result: {
        play_video_type: 'preview',
        play_check: { play_detail: 'PLAY_PREVIEW' },
        arc: { cid },
        user_status: { is_login: true, has_paid: false },
        video_info: {
          is_preview: true,
          type: 3,
          format: 'mp4',
          quality: 80,
          timelength: 1_440_083,
          durls: [
            { quality: 80, durl: [{ length: 360_082, url: 'https://ssr.example/preview.m4s' }] },
          ],
        },
      },
    };
  }

  /** `playview` 的原始响应：4×6min 的试看流（`truncated === true`） */
  function playviewBodyOf(cid: number) {
    return {
      code: 0,
      data: {
        arc: { cid },
        play_video_type: 'preview',
        play_check: { play_detail: 'PLAY_PREVIEW' },
        video_info: {
          quality: 80,
          timelength: 1_440_000,
          accept_quality: [125, 120, 112, 80],
          durls: Array.from({ length: 4 }, () => ({ durl: [{ length: 360_109 }] })),
        },
      },
    };
  }
});
