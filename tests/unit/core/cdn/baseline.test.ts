// @vitest-environment node

/**
 * `classifyCdn()` 的**真实 host 全集**回归基线（2026-11-17，审计 P2）。
 *
 * ## 这份数据从哪来（不许重写、不许"整理"）
 *
 * | 项 | 值 |
 * | --- | --- |
 * | 采集脚本 | `poc/probe/pcdn-diag/probe.mjs`（一次跑完 Q1 / Q8 / Q9 / Q10） |
 * | 原始导出 | `poc/probe/result-pcdn-diag.json` → `inventory.hosts`（**已 gitignore**，所以副本落在本 fixture） |
 * | 报告 | `poc/probe/pcdn-diag/REPORT.md` |
 * | 日期 | 2026-11-17 |
 * | 样本 | 20 个热门视频的**匿名 playurl**（未登录态，避免把个人观看记录带进仓库） |
 * | 环境 | Edge 157 / bsk 0.3.3 / 真实视频页播放 |
 *
 * fixture 里的 `cls` / `flavor` 是**用 `classifyCdn(host)` 生成的**（不是手抄），
 * 生成脚本只做一件事：把 84 条 host 逐条喂给分类器，然后落盘。**生成之后没有人
 * 改过任何一行** —— 这是它作为回归基线的全部价值。
 *
 * ## 为什么需要它
 *
 * 在此之前，`classify.test.ts` 的样例是**手写的十几个**：改一条正则（比如把
 * `SELF_BUILT_RE` 的 `cn-` 放宽成 `c`），只要那十几个还过，测试就全绿 ——
 * 而真实世界的 68 个 PCDN host 里可能已经有一半判错了。
 * 现在有 84 条真实 host 压着，正则一动就会有一批立刻变红。
 *
 * ## ⚠️ 分桶计数是**实测事实**，不是"让测试好过"的调参
 *
 * | 分桶 | 条数 | 说明 |
 * | --- | --- | --- |
 * | `pcdn` / `flavor: null` | **68** | `*.mcdn.bilivideo.cn`、`*.edge.mountaintoys.cn`（均带 `:端口`，`classifyCdn` 内部剥端口） |
 * | `official` / `partner` | **8** | `upos-*` 服务商镜像 |
 * | `official` / `self-built` | **8** | `cn-sccd-ct-02-*`（B站自建边缘） |
 * | `third-party` | **0** | 这批样本里没有第三方 CDN |
 * | `unknown` | **0** | 84 条全部认得出来 —— 所以 P0-1 那条"unknown 不再被丢弃"**不能**靠这份数据验，见下 |
 *
 * ### ⚠️ 与任务书的一处出入（已核对，不是实现的问题）
 *
 * 任务书里写的是「`official·flavor=null` 8 个（`bvc` 与 `cn-*` 那批）」，
 * 实测是 **`official/self-built` 8 个、`flavor === null` 的是 0 个**。
 * 原因：那 8 条是 `cn-sccd-ct-02-*`，正好命中
 * `SELF_BUILT_RE = /^cn-[a-z0-9-]+\.bilivideo\.(com|cn)$/`。
 *
 * 而探针自己的 bucket 名是 `official:unknown-flavor` —— 那是**探针没判机型**的
 * 意思（它只分 `pcdn` / `official:partner` / `official:unknown-flavor` 三桶），
 * 不等于 `classifyCdn` 会返回 `null`。**两个桶名长得像，含义不同。**
 * 这里按实测值断言，并在报告里点出这处出入。
 *
 * ## 这份数据**测不到**什么
 *
 * `unknown`（认不出来源的线路，2026-11-17 P0-1）在这 84 条里一条都没有 ——
 * 因为探针只收它能认出来的域。那一侧由 `loading-trace.test.ts` 的
 * `P0-1 · unknown 不再被丢弃` 用构造样本覆盖，两者互补，谁也替不了谁。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyCdn, type CdnKind, type OfficialFlavor } from '@core/cdn/classify';

/** fixture 里的一条 */
interface BaselineHost {
  host: string;
  cls: CdnKind;
  flavor: OfficialFlavor;
}

const BASELINE: BaselineHost[] = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/pcdn-hosts-baseline.json'), 'utf8'),
) as BaselineHost[];

/** 分桶键：`official/self-built` 这种，`flavor === null` 写成 `official/null` */
function bucketOf(cls: CdnKind, flavor: OfficialFlavor): string {
  return `${cls}/${flavor === null ? 'null' : flavor}`;
}

/** 基线里每个分桶的条数（**数的是 fixture**，不是分类器的输出） */
function countBuckets(rows: readonly BaselineHost[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = bucketOf(row.cls, row.flavor);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe('classifyCdn 真实 host 全集（84 条，2026-11-17 实测）', () => {
  /**
   * ⚠️ 反例守卫：fixture 被清空 / 被换成 3 条样例时，下面的循环会"全部通过"。
   * 所以条数先钉死。
   */
  it('fixture 本身：84 条、无重复 host', () => {
    expect(BASELINE).toHaveLength(84);
    const hosts = BASELINE.map((r) => r.host);
    expect(new Set(hosts).size).toBe(hosts.length);
    // 每条都必须是纯 host 字符串（fixture 是实测导出，不许夹 URL / 路径）
    for (const h of hosts) {
      expect(h).not.toContain('/');
      expect(h).not.toContain('?');
      expect(h.trim()).toBe(h);
    }
  });

  it('★ 84 条逐条与基线一致（改任何一条正则都会有一批变红）', () => {
    const drifted = BASELINE.map((row) => {
      const got = classifyCdn(row.host);
      return {
        host: row.host,
        want: bucketOf(row.cls, row.flavor),
        got: bucketOf(got.cls, got.flavor),
      };
    }).filter((r) => r.want !== r.got);

    // 失败时把每一条漂移都列出来，而不是只说"第 N 条不对"
    expect(drifted).toEqual([]);
  });

  it('★ 分桶计数 = 实测值（pcdn 68 / partner 8 / self-built 8）', () => {
    const counts = countBuckets(BASELINE);

    expect(counts.get('pcdn/null')).toBe(68);
    expect(counts.get('official/partner')).toBe(8);
    /**
     * ⚠️ 这里是 `self-built` 而不是 `null` —— 与任务书写的「official·null 8」不同。
     * 实测那 8 条是 `cn-sccd-ct-02-*`，命中 `SELF_BUILT_RE`。
     * 文件头「与任务书的一处出入」有完整核对过程。
     */
    expect(counts.get('official/self-built')).toBe(8);
    expect(counts.get('official/null')).toBeUndefined();

    // 这批样本里没有这两类 —— 出现了就说明分类器把什么吃进来了
    expect(counts.get('third-party/null')).toBeUndefined();
    expect(counts.get('unknown/null')).toBeUndefined();
  });

  it('分桶计数与分类器的**输出**也一致（fixture 不是手写的）', () => {
    /**
     * 反例：fixture 里的 `cls` 是人手抄错的 → 上一条（数 fixture）会过，
     * 但"分类器实际输出"的分布对不上。这条把两边钉在一起。
     */
    const fromClassifier = new Map<string, number>();
    for (const row of BASELINE) {
      const { cls, flavor } = classifyCdn(row.host);
      const key = bucketOf(cls, flavor);
      fromClassifier.set(key, (fromClassifier.get(key) ?? 0) + 1);
    }
    expect([...fromClassifier.entries()].sort()).toEqual(
      [...countBuckets(BASELINE).entries()].sort(),
    );
  });

  it('带端口的 host 也能判（实测 68 条 PCDN 全带 `:8082` / `:4483`）', () => {
    // 端口不改变线路归属：`classifyCdn` 内部 `stripPort`
    expect(classifyCdn('xy39x129x121x166xy.mcdn.bilivideo.cn:8082')).toEqual({
      cls: 'pcdn',
      flavor: null,
    });
    expect(BASELINE.filter((r) => r.host.includes(':')).length).toBe(68);
  });
});
