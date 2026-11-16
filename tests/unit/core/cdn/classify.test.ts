import { describe, expect, it } from 'vitest';

import { classifyCdn } from '@core/cdn/classify';

/**
 * 守的是"屏蔽开关真的拦得住 PCDN，且不误伤官方线路"。
 *
 * ## 为什么每条判据都要独立用例
 *
 * 这个函数的错误方向不对称：把 PCDN 判成官方，界面**一切正常**、没有报错，
 * 开关看着开着但 PCDN 照跑 —— 只能靠测试发现。所以下面不是"抽几个样本意思一下"，
 * 而是**逐条判据一个用例**，并且刻意把最容易互相抢答的几条放在最前面
 * （`mcdn.bilivideo.com` 同时满足"含 mcdn"与"bilivideo.com 子域"）。
 *
 * 用例里的域名全部来自真实观测（`docs/plans/2026-11-17-pcdn-diag-plan.md` §3.2 那张对照表，
 * 以及 F9 实测的 `cn-*-bcache-*` / `upos-sz-mirrorcos`），不是编出来的字符串。
 */

describe('classifyCdn：PCDN 判据必须抢在"官方域兜底"之前', () => {
  it('mcdn.bilivideo.com → pcdn（同域兜底不许抢答）', () => {
    // 它是 bilivideo.com 的子域，公共 DNS 返回 0.0.0.0。若第 8 条排在前面，
    // 这条会变成 official —— 开关开了也拦不住，而且界面显示一切正常。
    expect(classifyCdn('mcdn.bilivideo.com')).toEqual({ cls: 'pcdn', flavor: null });
  });

  it('xy116x196x140x25xy.mcdn.bilivideo.cn:8082 → pcdn（带端口）', () => {
    // 带端口时若没先剥端口，`bilivideo.cn` 后缀匹配与官方正则都会失效
    const result = classifyCdn('xy116x196x140x25xy.mcdn.bilivideo.cn:8082');
    expect(result).toEqual({ cls: 'pcdn', flavor: null });
  });

  it('a.pcdn.foo → pcdn（标签级关键词，不要求已知域）', () => {
    expect(classifyCdn('a.pcdn.foo')).toEqual({ cls: 'pcdn', flavor: null });
  });

  it('x.szbdyd.com / y.mountaintoys.cn → pcdn（供应商自有域）', () => {
    expect(classifyCdn('x.szbdyd.com')).toEqual({ cls: 'pcdn', flavor: null });
    expect(classifyCdn('y.mountaintoys.cn')).toEqual({ cls: 'pcdn', flavor: null });
  });

  it('供应商域的另外两个也认（qrstuvwxyzab.com / zhenidc.cn）', () => {
    expect(classifyCdn('a.qrstuvwxyzab.com')).toEqual({ cls: 'pcdn', flavor: null });
    expect(classifyCdn('b.zhenidc.cn')).toEqual({ cls: 'pcdn', flavor: null });
  });

  it('1.2.3.4 → pcdn（裸 IPv4 直连）', () => {
    expect(classifyCdn('1.2.3.4')).toEqual({ cls: 'pcdn', flavor: null });
  });

  it('IPv6 字面量 → pcdn', () => {
    expect(classifyCdn('2408:8207:1234::1')).toEqual({ cls: 'pcdn', flavor: null });
  });
});

describe('classifyCdn：官方域的三种 flavor，且不许猜机型', () => {
  it('upos-sz-mirrorcos.bilivideo.com → official / partner', () => {
    // 播放页右键「Video Hosts」把它标为服务商 CDN，我们的括号必须与之一致
    expect(classifyCdn('upos-sz-mirrorcos.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: 'partner',
    });
  });

  it('cn-cq-gd-bcache-19.bilivideo.com → official / self-built', () => {
    expect(classifyCdn('cn-cq-gd-bcache-19.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: 'self-built',
    });
  });

  it('cn-sccd-ct-02-13.bilivideo.com → official / self-built（没有 bcache 也算自建）', () => {
    // 实测（2026-11-17，20 个视频 host 全集）：自建的真实命名是
    // `cn-<地区>-<运营商>-<节点>`，`bcache` 只是其中一种节点类型。
    // 第一版正则强制 `-bcache-`，这条会掉到官方域兜底 → flavor 变 null →
    // 用户那块「（自建 CDN）」括号静默不显示。
    expect(classifyCdn('cn-sccd-ct-02-13.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: 'self-built',
    });
  });

  it('cn-jsnt-ct-01-06.bilivideo.com → official / self-built（同上，不带 bcache）', () => {
    expect(classifyCdn('cn-jsnt-ct-01-06.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: 'self-built',
    });
  });

  it('bvc.bilivideo.com → official / null（既非 cn- 也非 upos-，不为它特判）', () => {
    // 实测它在取流域里，但认不出机型 —— 加括号就等于替 B站 编归属
    expect(classifyCdn('bvc.bilivideo.com')).toEqual({ cls: 'official', flavor: null });
  });

  it('some-new-edge.bilivideo.com → official / null（认不出机型就不猜）', () => {
    // 给 null 加括号等于替 B站 编一个机型归属，用户一对照右键统计就发现说错了
    expect(classifyCdn('some-new-edge.bilivideo.com')).toEqual({ cls: 'official', flavor: null });
  });

  it('bilivideo.cn 域同样兜底成 official / null', () => {
    expect(classifyCdn('xy1.some-new-edge.bilivideo.cn')).toEqual({
      cls: 'official',
      flavor: null,
    });
  });

  it('大小写与尾点不影响判定', () => {
    expect(classifyCdn('UPOS-SZ-MIRRORCOS.BiliVideo.COM.')).toEqual({
      cls: 'official',
      flavor: 'partner',
    });
  });
});

describe('classifyCdn：域名匹配必须按标签边界', () => {
  it('evil-mcdn.attacker.test → unknown（不是 pcdn）', () => {
    // 用 includes('mcdn') 判会把它当 PCDN。攻击者只要注册带关键词的域就能骗过开关，
    // 而这条的"正确"方向是**不拦**：来源不明的东西不该被当 PCDN 屏蔽。
    expect(classifyCdn('evil-mcdn.attacker.test')).toEqual({ cls: 'unknown', flavor: null });
  });

  it('notbilivideo.com / szbdyd.com.evil.test → 不属于官方域或供应商域', () => {
    expect(classifyCdn('notbilivideo.com')).toEqual({ cls: 'unknown', flavor: null });
    expect(classifyCdn('x.szbdyd.com.evil.test')).toEqual({ cls: 'unknown', flavor: null });
  });

  it('裸后缀不算（bilivideo.com 本身要算官方，bilivideo.com.cn 不算）', () => {
    expect(classifyCdn('bilivideo.com')).toEqual({ cls: 'official', flavor: null });
    expect(classifyCdn('bilivideo.com.cn')).toEqual({ cls: 'unknown', flavor: null });
  });

  it('x.akamaized.net → third-party（不是 PCDN，不许拦）', () => {
    expect(classifyCdn('x.akamaized.net')).toEqual({ cls: 'third-party', flavor: null });
  });

  it('cn.example.com → unknown（`cn-` 前缀本身不是自建判据）', () => {
    // 自建正则必须同时要求官方域，否则任何 `cn-` 开头的域都会被说成"B站自建 CDN"
    expect(classifyCdn('cn.example.com')).toEqual({ cls: 'unknown', flavor: null });
  });

  it('xcn-abc.bilivideo.com → official / null（`^cn-` 行首锚定生效，不许判成 self-built）', () => {
    // 这条才是行首锚定的证据：`cn-` 出现在中间不算自建。
    // 但它是 bilivideo.com 的子域，仍走第 8 条兜底 → official/null（不加括号），
    // **不是** unknown：域名归属明确，只是认不出机型。
    expect(classifyCdn('xcn-abc.bilivideo.com')).toEqual({
      cls: 'official',
      flavor: null,
    });
  });

  it('cn- 后面不能跨标签（cn-a.b.example 不算自建的单标签形式）', () => {
    // 自建判据只允许 `cn-<单标签>.bilivideo.*`：中间出现点就不该命中
    expect(classifyCdn('cn-a.b.bilivideo.com')).toEqual({ cls: 'official', flavor: null });
  });
});

describe('classifyCdn：query 里的 os=mcdn 必须整段相等', () => {
  it("e.bilivideo.com + 'os=cdn' → official（不许误命中）", () => {
    // 正规镜像也会代理 mcdn 资源，但 os=cdn 说明这是普通线路
    expect(classifyCdn('e.bilivideo.com', 'os=cdn')).toEqual({ cls: 'official', flavor: null });
  });

  it("e.bilivideo.com + 'os=mcdn' → pcdn", () => {
    expect(classifyCdn('e.bilivideo.com', 'os=mcdn')).toEqual({ cls: 'pcdn', flavor: null });
  });

  it("'?os=mcdn&platform=pc' 也命中（按 & 切段后整段相等）", () => {
    expect(classifyCdn('e.bilivideo.com', '?os=mcdn&platform=pc')).toEqual({
      cls: 'pcdn',
      flavor: null,
    });
  });

  it("'os=mcdnx' / 'xos=mcdn' 都不命中（不是子串匹配）", () => {
    expect(classifyCdn('e.bilivideo.com', 'os=mcdnx')).toEqual({ cls: 'official', flavor: null });
    expect(classifyCdn('e.bilivideo.com', 'xos=mcdn')).toEqual({ cls: 'official', flavor: null });
  });
});

describe('classifyCdn：不是主机名的输入一律 unknown', () => {
  it("'' → unknown", () => {
    expect(classifyCdn('')).toEqual({ cls: 'unknown', flavor: null });
  });

  it("'blob:https://www.bilibili.com/x' → unknown（<video src> 上真实存在）", () => {
    expect(classifyCdn('blob:https://www.bilibili.com/x')).toEqual({
      cls: 'unknown',
      flavor: null,
    });
  });

  it("'data:video/mp4;base64,AAAA' → unknown", () => {
    expect(classifyCdn('data:video/mp4;base64,AAAA')).toEqual({ cls: 'unknown', flavor: null });
  });

  it('单标签与带路径的串 → unknown', () => {
    expect(classifyCdn('localhost')).toEqual({ cls: 'unknown', flavor: null });
    expect(classifyCdn('a.bilivideo.com/path')).toEqual({ cls: 'unknown', flavor: null });
  });

  it("'   ' → unknown（只有空白）", () => {
    expect(classifyCdn('   ')).toEqual({ cls: 'unknown', flavor: null });
  });

  it('没实测过的域 → unknown（不擅自当 pcdn 去拦）', () => {
    expect(classifyCdn('cdn.example.com')).toEqual({ cls: 'unknown', flavor: null });
  });
});
