// @vitest-environment node

/**
 * `explainCdn()` —— 判据的**命中来源**（ADR 0042）。
 *
 * ## 这个文件守的是什么
 *
 * `classifyCdn()` 只回答"是不是 PCDN"，而面板要回答的是"**为什么**是 PCDN"。
 * 两者分开之后，最危险的失败形态变了：
 *
 * | 失败 | 后果 | 谁来发现 |
 * | --- | --- | --- |
 * | `classifyCdn()` 判错 | 开关开着却在走 PCDN / 正常镜像被拦 | `classify.test.ts` + `baseline.test.ts`（30 处精确断言） |
 * | `rule` 标错 | 面板把官方镜像说成 P2P（本轮要修的那个 bug 复发） | **本文件** |
 * | 两份判据实现漂移 | 判定与解释各说一套 | 本文件的「恒相等」对拍 + `classify.ts` 只有一份实现 |
 *
 * ## ⚠️ 这里**不重抄**期望语义
 *
 * 每条用例的 `cls` 都与 `classify.test.ts` 的同名用例一字不差 ——
 * 只是多断言一个 `rule`。若哪天两条用例的 `cls` 不一致，说明判据被搬了两处。
 *
 * ## ⚠️ 取舍：`ip` 与 `label` 都判 `pcdn`，能区分它们的**只有 `rule`**
 *
 * 所以「十步每条一例」不是形式主义：`rule` 是唯一能证明"第 3 条抢在第 5 条前面"
 * 的信号（`xy116x…mcdn.bilivideo.cn` + `os=mcdn` 两条件同时成立，`cls` 永远是 pcdn）。
 */

import { describe, expect, it } from 'vitest';

import {
  classifyCdn,
  explainCdn,
  type CdnKind,
  type CdnRule,
  type OfficialFlavor,
} from '@core/cdn/classify';

/** 把 `explainCdn()` 的结果压成 `cls/flavor` 分桶键（与 `baseline.test.ts` 同口径） */
function bucketOf(cls: CdnKind, flavor: OfficialFlavor): string {
  return `${cls}/${flavor === null ? 'null' : flavor}`;
}

describe('explainCdn：十步判据各返回正确的 rule', () => {
  it('第 1 条 · 不是主机名 → unknown / rule=unknown', () => {
    // `<video src>` 上的 `blob:` 串与纯空白都实测出现过
    expect(explainCdn('')).toEqual({ cls: 'unknown', flavor: null, rule: 'unknown' });
    expect(explainCdn('blob:https://www.bilibili.com/x')).toEqual({
      cls: 'unknown',
      flavor: null,
      rule: 'unknown',
    });
    // 单标签（localhost）既不是域名也不是 IP —— 也走第 1 条
    expect(explainCdn('localhost')).toEqual({ cls: 'unknown', flavor: null, rule: 'unknown' });
  });

  it('第 2 条 · 裸 IPv4 / IPv6 字面量 → pcdn / rule=ip', () => {
    expect(explainCdn('1.2.3.4')).toEqual({ cls: 'pcdn', flavor: null, rule: 'ip' });
    expect(explainCdn('2408:8207:1234::1')).toEqual({ cls: 'pcdn', flavor: null, rule: 'ip' });
  });

  it('第 3 条 · 任一标签是 mcdn / pcdn / gotcha → pcdn / rule=label', () => {
    expect(explainCdn('mcdn.bilivideo.com')).toEqual({
      cls: 'pcdn',
      flavor: null,
      rule: 'label',
    });
    expect(explainCdn('a.pcdn.foo')).toEqual({ cls: 'pcdn', flavor: null, rule: 'label' });
    // `gotcha` 也在标签表里，但从来没有单独一条用例 —— 顺手钉住
    expect(explainCdn('x.gotcha.example')).toEqual({ cls: 'pcdn', flavor: null, rule: 'label' });
  });

  it('第 4 条 · 供应商自有域 → pcdn / rule=domain', () => {
    expect(explainCdn('x.szbdyd.com')).toEqual({ cls: 'pcdn', flavor: null, rule: 'domain' });
    expect(explainCdn('a.mountaintoys.cn')).toEqual({
      cls: 'pcdn',
      flavor: null,
      rule: 'domain',
    });
    expect(explainCdn('a.qrstuvwxyzab.com')).toEqual({
      cls: 'pcdn',
      flavor: null,
      rule: 'domain',
    });
    expect(explainCdn('b.zhenidc.cn')).toEqual({ cls: 'pcdn', flavor: null, rule: 'domain' });
  });

  it('第 5 条 · query 里整段 os=mcdn（主机是别处认不出的官方域）→ rule=os-mcdn', () => {
    // `e.bilivideo.com` 既不带 `upos-` 也不带 `cn-`，前四条都不命中
    expect(explainCdn('e.bilivideo.com', 'os=mcdn')).toEqual({
      cls: 'pcdn',
      flavor: null,
      rule: 'os-mcdn',
    });
    // `os=cdn` 不命中 → 落回第 8 条
    expect(explainCdn('e.bilivideo.com', 'os=cdn')).toEqual({
      cls: 'official',
      flavor: null,
      rule: 'official',
    });
  });

  it('第 6 条 · cn-<单标签>.bilivideo.* → official / self-built / rule=self-built', () => {
    expect(explainCdn('cn-cq-gd-bcache-19.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: 'self-built',
      rule: 'self-built',
    });
    // 实测全集里"没有 bcache"的那两种也必须命中（否则 flavor 静默变 null）
    expect(explainCdn('cn-sccd-ct-02-13.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: 'self-built',
      rule: 'self-built',
    });
    expect(explainCdn('cn-jsnt-ct-01-06.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: 'self-built',
      rule: 'self-built',
    });
  });

  it('第 7 条 · upos-<单标签>.bilivideo.* → official / partner / rule=partner', () => {
    expect(explainCdn('upos-sz-mirrorcos.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: 'partner',
      rule: 'partner',
    });
    // 本轮实测的改写目标就是这一类
    expect(explainCdn('upos-sz-mirrorhw.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: 'partner',
      rule: 'partner',
    });
  });

  it('第 8 条 · 官方域兜底 → official / null / rule=official（认不出机型）', () => {
    expect(explainCdn('bvc.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: null,
      rule: 'official',
    });
    expect(explainCdn('bilivideo.com')).toEqual({
      cls: 'official',
      flavor: null,
      rule: 'official',
    });
  });

  it('第 9 条 · 第三方域 → third-party / rule=third-party', () => {
    expect(explainCdn('x.akamaized.net')).toEqual({
      cls: 'third-party',
      flavor: null,
      rule: 'third-party',
    });
  });

  it('第 10 条 · 没实测过的域 → unknown / rule=unknown（不擅自当 pcdn）', () => {
    expect(explainCdn('cdn.example.com')).toEqual({
      cls: 'unknown',
      flavor: null,
      rule: 'unknown',
    });
    // 标签边界：`evil-mcdn` 不算 `mcdn` → 落第 10 条而不是第 3 条
    expect(explainCdn('evil-mcdn.attacker.test')).toEqual({
      cls: 'unknown',
      flavor: null,
      rule: 'unknown',
    });
  });
});

describe('explainCdn：顺序即语义（rule 是唯一能证明它的信号）', () => {
  it("★ 第 3 条抢在第 5 条前面：`…mcdn.bilivideo.cn` + 'os=mcdn' → rule=label", () => {
    /**
     * 两个条件同时成立，`cls` 永远是 `pcdn` —— 只有 `rule` 能说出是谁先命中的。
     * 反例：把第 5 条挪到第 3 条前面 → 本条红（而 `classify.test.ts` 全绿，
     * 因为它只断言 `cls`）。这条就是"顺序即语义"的可观测证据。
     */
    expect(explainCdn('xy116x196x140x25xy.mcdn.bilivideo.cn', 'os=mcdn')).toEqual({
      cls: 'pcdn',
      flavor: null,
      rule: 'label',
    });
  });

  it('★ 第 4 条抢在第 5 条前面：`a.mountaintoys.cn` + os=mcdn → rule=domain', () => {
    // 实测 47 条带 os=mcdn 的 URL 里有 34 条落在这里
    expect(explainCdn('a.mountaintoys.cn', 'os=mcdn')).toEqual({
      cls: 'pcdn',
      flavor: null,
      rule: 'domain',
    });
  });

  it('★ 第 5 条抢在第 6/7/8 条前面：自建边缘 + os=mcdn → rule=os-mcdn（正是本轮的病）', () => {
    /**
     * 这就是改写后的真实形态：候选的 authority 被换成官方镜像、
     * `search` 一字不动 → `cls` 仍是 `pcdn`。`rule` 说出原因，
     * 采集侧再补 `hostCls: 'official'`，面板才敢如实显示。
     */
    expect(explainCdn('cn-bj-ct-01-01.bilivideo.com', 'os=mcdn')).toEqual({
      cls: 'pcdn',
      flavor: null,
      rule: 'os-mcdn',
    });
    expect(explainCdn('upos-sz-mirrorhw.bilivideo.com', 'os=mcdn')).toEqual({
      cls: 'pcdn',
      flavor: null,
      rule: 'os-mcdn',
    });
  });

  it("★ 第 2 条抢在一切之前：IP + 'os=mcdn' → rule=ip（不是 os-mcdn）", () => {
    expect(explainCdn('1.2.3.4', 'os=mcdn')).toEqual({ cls: 'pcdn', flavor: null, rule: 'ip' });
  });

  it("★ 第 1 条抢在一切之前：不是主机名 + 'os=mcdn' → unknown（不是 pcdn）", () => {
    // 关键：判不出主机时**不许**因为 query 就判 pcdn —— 那会让 blob: 串被拦
    expect(explainCdn('blob:https://www.bilibili.com/x', 'os=mcdn')).toEqual({
      cls: 'unknown',
      flavor: null,
      rule: 'unknown',
    });
  });

  it('第 6 条抢在第 8 条前面：自建边缘的 rule 是 self-built，不是 official', () => {
    expect(explainCdn('cn-cq-gd-bcache-19.bilivideo.com').rule).toBe('self-built');
    // `cn-` 不在行首 → 掉到兜底
    expect(explainCdn('xcn-abc.bilivideo.com').rule).toBe('official');
  });
});

describe('classifyCdn 与 explainCdn 恒一致（delegation 的证据）', () => {
  /**
   * ## 这一组是"没有第二份判据实现"的可执行证明
   *
   * `classifyCdn()` 现在是三行委托。如果哪天真有人为了"顺手改点东西"
   * 又写一份判据（哪怕只复制一部分），这一组会在**某条输入**上立刻对不上。
   *
   * 输入覆盖十步判据 + 边界（端口 / 大小写 / 尾点 / 单标签 / 坏输入 / query 形态）。
   */
  const CASES: ReadonlyArray<readonly [string, string | undefined]> = [
    // 第 1 条
    ['', undefined],
    ['   ', undefined],
    ['localhost', undefined],
    ['blob:https://www.bilibili.com/x', undefined],
    ['data:video/mp4;base64,AAAA', undefined],
    ['a.bilivideo.com/path', undefined],
    // 第 2 条
    ['1.2.3.4', undefined],
    ['2408:8207:1234::1', undefined],
    ['[::1]:8080', undefined],
    // 第 3 条
    ['mcdn.bilivideo.com', undefined],
    ['xy116x196x140x25xy.mcdn.bilivideo.cn:8082', undefined],
    ['a.pcdn.foo', undefined],
    ['evil-mcdn.attacker.test', undefined],
    // 第 4 条
    ['x.szbdyd.com', undefined],
    ['y.mountaintoys.cn', undefined],
    ['a.qrstuvwxyzab.com', undefined],
    ['b.zhenidc.cn', undefined],
    ['x.szbdyd.com.evil.test', undefined],
    // 第 5 条
    ['e.bilivideo.com', 'os=mcdn'],
    ['e.bilivideo.com', '?os=mcdn&platform=pc'],
    ['e.bilivideo.com', 'os=mcdnx'],
    ['e.bilivideo.com', 'xos=mcdn'],
    ['e.bilivideo.com', 'os=cdn'],
    ['upos-sz-mirrorhw.bilivideo.com', 'os=mcdn'],
    // 第 6 / 7 / 8 条
    ['cn-cq-gd-bcache-19.bilivideo.com', undefined],
    ['cn-sccd-ct-02-13.bilivideo.com', undefined],
    ['cn-jsnt-ct-01-06.bilivideo.com', undefined],
    ['cn-a.b.bilivideo.com', undefined],
    ['upos-sz-mirrorcos.bilivideo.com', undefined],
    ['UPOS-SZ-MIRRORCOS.BiliVideo.COM.', undefined],
    ['bvc.bilivideo.com', undefined],
    ['bilivideo.com', undefined],
    ['bilivideo.com.cn', undefined],
    ['xy1.some-new-edge.bilivideo.cn', undefined],
    // 第 9 / 10 条
    ['x.akamaized.net', undefined],
    ['cdn.example.com', undefined],
    ['notbilivideo.com', undefined],
    ['cn.example.com', undefined],
  ];

  it('★ 40 条输入：`classifyCdn()` 的前两个字段与 `explainCdn()` 恒相等', () => {
    const drifted: Array<{ host: string; search: string | undefined; want: string; got: string }> =
      [];
    for (const [host, search] of CASES) {
      const explained = explainCdn(host, search);
      const classified = classifyCdn(host, search);
      const want = bucketOf(explained.cls, explained.flavor);
      const got = bucketOf(classified.cls, classified.flavor);
      if (want !== got) drifted.push({ host, search, want, got });
    }
    expect(drifted).toEqual([]);
    // 反空转：输入表本身不许被清空成 0 条（否则循环跑 0 次、永远绿）
    expect(CASES.length).toBeGreaterThanOrEqual(35);
  });

  it('★ `classifyCdn()` **不带** `rule`（返回形状与语义一个字没变）', () => {
    /**
     * 这条钉的是 ADR 0042 边界 1 的一半：30 处 `toEqual({ cls, flavor })`
     * 精确深比较正是靠"没有第三个键"才过得去。给 `CdnClass` 加字段 → 本条必红。
     */
    expect(Object.keys(classifyCdn('e.bilivideo.com')).sort()).toEqual(['cls', 'flavor']);
    expect(classifyCdn('e.bilivideo.com')).not.toHaveProperty('rule');
  });

  it('★ `explainCdn()` 恰好有 cls / flavor / rule 三个键（不多不少）', () => {
    expect(Object.keys(explainCdn('e.bilivideo.com')).sort()).toEqual(['cls', 'flavor', 'rule']);
  });
});

/**
 * ## 关键回归：真实数据里第 5 条**从未单独生效**
 *
 * 数据来源与提取方式（**不含任何凭据**）：
 *
 * | 项 | 值 |
 * | --- | --- |
 * | 原始导出 | `poc/probe/pcdn-diag/` 三份（`remaining-candidates.json` / `mcdn-candidates.json` / `rewrite-4k-candidates.json`，均 gitignored） |
 * | 日期 | 2026-11-17 |
 * | 抽取口径 | 所有落在 `/upgcxcode/` 下的 URL，去重后 141 条；其中带整段 `os=mcdn` 的 **47 条** |
 * | 本 fixture | 只留 `[host, os 段]`，**URL 的其余部分一个字节都没留** |
 *
 * ⚠️ **为什么不内联完整 URL**：那些 URL 里有 `upsig` / `uparams`，是**取流凭据**。
 * `loading-trace.ts` 文件头边界 1 说的是"凭据不许留存"，测试 fixture 也算留存 ——
 * 而且是**进 git** 的那种。所以只留 host 与那一个 `os` 段。
 *
 * ## 这条钉的是什么
 *
 * 47 条带 `os=mcdn` 的 URL 里：
 *
 * | 最先命中 | 条数 |
 * | --- | --- |
 * | 第 4 条（供应商域 `mountaintoys.cn`） | 34 |
 * | 第 3 条（`mcdn` 标签） | 13 |
 * | **第 5 条（`os=mcdn`，前面都不命中）** | **0** |
 *
 * ⇒ 第 5 条在**原始数据**上是"从未单独生效的保险丝"，而在**改写后的数据**上
 * 100% 命中。所以修法只能是"把命中来源说出来"（保留判据），
 * 不能是"收窄判据"（那会漏判真实 PCDN）。
 *
 * ⚠️ 反例：若哪天有人"顺手"把第 5 条挪到第 3/4 条前面，这张表会变成
 * 0 / 0 / 47 → 本条立刻红。
 */
describe('★ 关键回归：47 条实测带 os=mcdn 的 URL，rule 分布 = domain 34 / label 13 / os-mcdn 0', () => {
  /** `[host, os 段]` —— 只有 host 与那一个 query 段，没有 URL、没有签名 */
  const OS_MCDN_PROBES: ReadonlyArray<readonly [string, string]> = [
    ['x5zy69j.edge.mountaintoys.cn', 'os=mcdn'],
    ['b-baaaw30uqv1hzw3czupt73k9fsi.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5zy69j.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5zu89j.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5z800k.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5zu89j.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5z800k.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5zu89j.edge.mountaintoys.cn', 'os=mcdn'],
    ['b-baaad67mq03az5cwy5fxglsy0c.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5zu89j.edge.mountaintoys.cn', 'os=mcdn'],
    ['b-baaaw79txv1hrw3c8upt73k9fsi.edge.mountaintoys.cn', 'os=mcdn'],
    ['b-baaaw30uqv1hzw3czupt73k9fsi.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5zy69j.edge.mountaintoys.cn', 'os=mcdn'],
    ['b-baaai49df92fej1bd75ienuahi8c.edge.mountaintoys.cn', 'os=mcdn'],
    ['b-baaac7sz23d9pqc11bnwzc8xyw.edge.mountaintoys.cn', 'os=mcdn'],
    ['b-baaac7sz23d9pqc11bnwzc8xyw.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5z800k.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5z800k.edge.mountaintoys.cn', 'os=mcdn'],
    ['x5zy69j.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x41xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['mv0bw83m.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x41xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['rq3a904j.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x3xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['b-baaaw90ujv1h7w3cqupt73k9fsi.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x3xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['b-baaa9ic0255d3c4bi3ygwqsbdk4b.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy116x196x157x78xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['b-baaca0d9742atlnff6n6w6af6zf.edge.mountaintoys.cn', 'os=mcdn'],
    ['b-baaca0d9742atlnff6n6w6af6zf.edge.mountaintoys.cn', 'os=mcdn'],
    ['b-baaca0d9742atlnff6n6w6af6zf.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x3xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['9svq90p.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x89xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['9svq90p.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x3xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['mv0bw83m.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x205xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['mv0bm24m.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy116x196x140x21xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['b-iba80a272j4h3alp2dvdrz7fe7rc48za.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x36xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['b-iba7yw07j4h3alp2dhcrl9fe7rc48za.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x89xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['b-iba9z996j4h3alp2d9cro8fe7rc48za.edge.mountaintoys.cn', 'os=mcdn'],
    ['xy180x129x222x181xy.mcdn.bilivideo.cn', 'os=mcdn'],
    ['xu5bp87a.edge.mountaintoys.cn', 'os=mcdn'],
  ];

  /** fixture 自己：47 条、`[host, os]` 两元素、**不含 URL / 凭据** */
  it('fixture 本身：47 条、每行只有 host 与 os 段', () => {
    expect(OS_MCDN_PROBES).toHaveLength(47);
    for (const [host, os] of OS_MCDN_PROBES) {
      expect(os).toBe('os=mcdn');
      // 只有 hostname：不许出现 URL 分隔符 / 凭据参数名
      expect(host).not.toContain('/');
      expect(host).not.toContain('?');
      expect(host).not.toContain('&');
      expect(host).not.toContain('upsig');
      expect(host).not.toContain('uparams');
    }
    // 27 个 distinct host —— 与实测一致
    expect(new Set(OS_MCDN_PROBES.map(([h]) => h)).size).toBe(27);
  });

  it('★ rule 分布恰好是 domain 34 / label 13 / os-mcdn 0（第 5 条从未单独生效）', () => {
    const byRule = new Map<CdnRule, number>();
    for (const [host, os] of OS_MCDN_PROBES) {
      const { rule } = explainCdn(host, os);
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    }

    expect(byRule.get('domain'), '第 4 条（供应商域 mountaintoys.cn）').toBe(34);
    expect(byRule.get('label'), '第 3 条（mcdn 独立标签）').toBe(13);
    /**
     * ⚠️ **这一行是整条 ADR 的核心证据**：
     * `os=mcdn` 在原始数据里**一次都没单独起作用** —— 34 + 13 = 47 已经全部分配完。
     * 而在改写后的数据（官方镜像 + 原 query）上它是 100% 命中。
     * 所以"收窄判据"是错的，"输出命中来源"才对（ADR 0042 第四节）。
     *
     * 写成 `get(...) ?? 0` 而不是 `toBeUndefined()`：前者对着**语义**断言
     * （"第 5 条命中 0 次"），后者只是"这个键恰好没被写过"。
     */
    expect(byRule.get('os-mcdn') ?? 0, '第 5 条在原始数据上从未单独生效').toBe(0);
    // 反空转：47 条全部被分类，没有落进别的桶
    expect([...byRule.values()].reduce((a, b) => a + b, 0)).toBe(47);
    // 而且分布里**真的没有第三个键**（不是"键存在但值为 0"）
    expect([...byRule.keys()].sort()).toEqual(['domain', 'label']);
  });

  it('★ 这 47 条全部仍判 pcdn（收窄判据会让其中 0 条漏判 —— 所以不许收窄）', () => {
    for (const [host, os] of OS_MCDN_PROBES) {
      expect(explainCdn(host, os).cls, host).toBe('pcdn');
      // 而且只看主机也全是 pcdn：它们本来就是真实 PCDN 主机
      expect(explainCdn(host).cls, host).toBe('pcdn');
    }
  });
});

/**
 * ## 改写后的真实形态：`hostCls === 'official'` 且 `rule === 'os-mcdn'`
 *
 * 19 / 20 条改写后的候选都落在这里（ADR 0042 §1 实测量化）。
 * 这里用实测的 host 全集作标本（`rewrite-4k-candidates.json` 的 `officialHosts`）。
 *
 * ⚠️ 这条钉的是**面板那条文案的判据**：`rule === 'os-mcdn'` 单独不够
 * （`e.bilivideo.com` 也会得到它，但那台机器认不出机型）；要再问一次"只看主机"。
 */
describe('★ 改写后的形态：os-mcdn + 官方镜像 ⇒ cls=pcdn / hostCls=official', () => {
  /**
   * 实测的镜像目标（`rewrite-4k-results.json` 的 `records[].targetHost`，
   * 取 `hasOsMcdn === true` 且 HTTP 2xx 的那批，去重）。
   *
   * ⚠️ `proxy-tf-all-ws.bilivideo.com` 是 ADR 0039 的 proxy 模板主机 ——
   * 它同样是 `bilivideo.com` 子域、同样认不出机型，因此 `hostCls` 也是 `official`。
   */
  const REWRITE_TARGETS: readonly string[] = [
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-sz-mirrorcoso1.bilivideo.com',
    'upos-sz-estgoss.bilivideo.com',
    'proxy-tf-all-ws.bilivideo.com',
  ];

  it('★ 每一个改写目标 + os=mcdn：cls 仍是 pcdn，但 hostCls 是 official', () => {
    for (const host of REWRITE_TARGETS) {
      const withQuery = explainCdn(host, 'os=mcdn');
      const hostOnly = explainCdn(host);
      // 过滤链路看的是这个 —— 一个字不许变（ADR 0042 边界 2）
      expect(withQuery.cls, host).toBe('pcdn');
      expect(withQuery.rule, host).toBe('os-mcdn');
      // 面板看的是这个 —— 主机本身是官方镜像（所以流量不走 PCDN）
      expect(hostOnly.cls, host).toBe('official');
    }
    // 其中三条是服务商镜像，机器可辨；proxy 那条认不出机型（不猜）
    for (const host of REWRITE_TARGETS.slice(0, 3)) {
      expect(explainCdn(host).flavor, host).toBe('partner');
    }
    expect(explainCdn('proxy-tf-all-ws.bilivideo.com').flavor).toBeNull();
  });

  it('真实的改写前主机（mountaintoys）两个都是 pcdn —— 面板仍画橙色 P2P', () => {
    const before = 'x5zy69j.edge.mountaintoys.cn';
    expect(explainCdn(before, 'os=mcdn')).toMatchObject({ cls: 'pcdn', rule: 'domain' });
    // 只看主机也是 pcdn ⇒ 不是"改写产物"，不许折回官方
    expect(explainCdn(before).cls).toBe('pcdn');
  });
});
