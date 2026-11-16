/**
 * `src/content/isolated/loading-trace.ts` 的可测部分（T3）
 *
 * ## 只测"纯"的那半边
 *
 * 采集器分两半：
 *   - **纯函数**：URL → host、resource 条目 → 事件、计数累加、环形截断、快照
 *   - **浏览器壳**：`PerformanceObserver` / `MutationObserver` / `<video>` 监听
 *
 * 壳不在这里测（它要真扩展才有意义 —— 那正是 T3 真机验证要证明的东西）。
 * 这里守的是**一旦壳把数据交进来，处理逻辑不会把凭据带出去、也不会把计数算丢**。
 *
 * ## 最要紧的四条
 *
 * 1. **query 不许出现在任何输出里**：`upsig` / `uparams` 是取流凭据，
 *    进内存结构就等于埋了一颗泄漏的地雷。所以用例直接用带凭据的真实 URL
 *    形状去断言输出里**连 `?` 都没有**。
 *    （query 可以被 `classifyCdn` **判读一次**——`os=mcdn` 那条判据要靠它——
 *    但判读不等于留存，用例同时钉住"判读生效"与"没被留下"两件事。）
 * 2. **计数不能靠事件算**：事件会被环形截断，闸门又会压掉同类别的事件，
 *    `hosts[].count` 必须独立累加、一条不少。
 * 3. **线路判据只有一份**：这里不复制域名表，全部走 `classifyCdn()` 的结果。
 * 4. **换线闸门按线路类别（`cls`），不按 host**：B站 会在同一条官方 CDN 的
 *    两个边缘之间逐片轮转，按 host 计会把"轮转"报成"换线"（2026-11-19 真机：
 *    12 秒 23 次假换线）。用例里有专门一条守这个。
 */
import { describe, expect, it } from 'vitest';

import { buildTimeline, detectSwitches } from '@core/loading/timeline';
import {
  createTraceState,
  getLoadingSnapshot,
  hostFromUrl,
  noteExtPatch,
  pushEvent,
  recordExtPatch,
  recordNavStart,
  recordPlayurl,
  recordResource,
  recordVideoStage,
  resetLoadingTrace,
  resolveMediaHost,
  snapshotOf,
  type LoadingTraceState,
} from '@/src/content/isolated/loading-trace';

/** 一条真实形状的媒体分片 URL：**带取流凭据**（query 里有 upsig / uparams） */
const SEGMENT_URL =
  'https://xy116x196x140x25xy.mcdn.bilivideo.cn:8082/video.m4s?upsig=9f2c1e0b7a&uparams=0a1b,2c3d&deadline=20390101';

/** 万一 query 漏出来，这些片段会出现在输出里 */
const CREDENTIAL_MARKERS = ['?', 'upsig', 'uparams', 'deadline', 'm4s', '8082'];

describe('hostFromUrl —— 边界处只留纯 hostname', () => {
  it('带端口与取流凭据的 URL 只留下 hostname', () => {
    expect(hostFromUrl(SEGMENT_URL)).toBe('xy116x196x140x25xy.mcdn.bilivideo.cn');
  });

  it('输出里不含 `?`，也不含 query 的任何片段', () => {
    const serialized = JSON.stringify(hostFromUrl(SEGMENT_URL));
    for (const marker of CREDENTIAL_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
  });

  it('大小写归一成小写', () => {
    expect(hostFromUrl('https://UPOS-SZ-MIRRORCOS.BiliVideo.COM/x?y=1')).toBe(
      'upos-sz-mirrorcos.bilivideo.com',
    );
  });

  it('没有主机名的 URL 返回 null（不编一个出来）', () => {
    // blob: / data: 在 <video src> 与资源条目里都实测出现过
    expect(hostFromUrl('blob:https://www.bilibili.com/9f2c1e0b-1234')).toBeNull();
    expect(hostFromUrl('data:application/octet-stream;base64,AAAA')).toBeNull();
    expect(hostFromUrl('')).toBeNull();
    expect(hostFromUrl('   ')).toBeNull();
    expect(hostFromUrl('/video.m4s?upsig=1')).toBeNull();
  });
});

describe('resolveMediaHost —— 媒体域判据只有 classifyCdn 一份', () => {
  it('官方自建边缘 → official', () => {
    expect(resolveMediaHost('https://cn-cq-gd-bcache-19.bilivideo.com/x.m4s?upsig=1')).toEqual({
      host: 'cn-cq-gd-bcache-19.bilivideo.com',
      cls: 'official',
      flavor: 'self-built',
    });
  });

  it('`mcdn` 子域即使挂在官方域下也判 pcdn（顺序即语义）', () => {
    expect(resolveMediaHost(SEGMENT_URL)).toEqual({
      host: 'xy116x196x140x25xy.mcdn.bilivideo.cn',
      cls: 'pcdn',
      flavor: null,
    });
  });

  it('PCDN 供应商自有域 → pcdn', () => {
    expect(resolveMediaHost('https://a1.szbdyd.com/x.m4s')?.cls).toBe('pcdn');
  });

  it('Akamai → third-party', () => {
    expect(resolveMediaHost('https://e1.akamaized.net/x.m4s')?.cls).toBe('third-party');
  });

  it('没实测过的域 → null（不擅自当成媒体域）', () => {
    expect(resolveMediaHost('https://api.bilibili.com/x/player/playurl')).toBeNull();
    expect(resolveMediaHost('https://evil-mcdn.attacker.test/x.m4s')).toBeNull();
  });

  it('官方域 + query 里的 `os=mcdn` → pcdn（官方镜像代理 mcdn 资源）', () => {
    // 只看域名会把这条判成 official，等于对用户陈述错误事实
    expect(
      resolveMediaHost('https://cn-bj-ct-01-01.bilivideo.com/v.m4s?upsig=AA&uparams=BB&os=mcdn'),
    ).toEqual({ host: 'cn-bj-ct-01-01.bilivideo.com', cls: 'pcdn', flavor: null });
  });

  it('`os=mcdn` 必须整段相等，`os=mcdnx` / `xos=mcdn` 不算', () => {
    const official = 'official';
    expect(resolveMediaHost('https://cn-bj-ct-01-01.bilivideo.com/v.m4s?os=mcdnx')?.cls).toBe(
      official,
    );
    expect(resolveMediaHost('https://cn-bj-ct-01-01.bilivideo.com/v.m4s?xos=mcdn')?.cls).toBe(
      official,
    );
  });
});

describe('resolveMediaHost —— 路径判据：只认媒体分片（2026-11-19 真机假阳性）', () => {
  it('`.m4s` + `/upgcxcode/` → 计入', () => {
    // `cn-x-1.…` 命中自建边缘正则，所以 flavor 是 `self-built`（不是 null）
    expect(resolveMediaHost('https://cn-x-1.bilivideo.com/upgcxcode/99/91/x.m4s?upsig=A')).toEqual({
      host: 'cn-x-1.bilivideo.com',
      cls: 'official',
      flavor: 'self-built',
    });
  });

  it('无扩展名但落在 `/upgcxcode/` 下 → 计入（兜住"将来没有扩展名的分片"）', () => {
    expect(resolveMediaHost('https://cn-x-1.bilivideo.com/upgcxcode/99/91/noext')).toEqual({
      host: 'cn-x-1.bilivideo.com',
      cls: 'official',
      flavor: 'self-built',
    });
  });

  it('水印遮罩 `/cmaskboss/*.webmask` → 不计入（本次实测的直接回归守卫）', () => {
    // 实测：同域静态资源会被判成"官方线路"混进线路表；一旦它落在 pcdn 域上
    // 就是假警报 —— 而假警报正是这个功能唯一要避免的东西
    expect(
      resolveMediaHost('https://upos-sz-staticcos-cmask.bilivideo.com/cmaskboss/1_25_2.webmask'),
    ).toBeNull();
    // 换成 pcdn 域也一样不计入：路径判据先于线路判据
    expect(resolveMediaHost('https://n1.szbdyd.com/cmaskboss/1_25_2.webmask')).toBeNull();
  });

  it('播放器数据接口 `/pbp/data` → 不计入', () => {
    expect(resolveMediaHost('https://bvc.bilivideo.com/pbp/data')).toBeNull();
  });

  it('`.mp4` / `.flv` 也算媒体（非 DASH 场景兜底），且大小写不敏感', () => {
    expect(resolveMediaHost('https://cn-x-1.bilivideo.com/v/1.MP4')?.cls).toBe('official');
    expect(resolveMediaHost('https://cn-x-1.bilivideo.com/v/1.flv')?.cls).toBe('official');
  });

  it('pathname 只用来算布尔：快照序列化不含 path 的任何痕迹', () => {
    const state = createTraceState();
    recordResource(state, {
      name: 'https://cn-x-1.bilivideo.com/upgcxcode/99/91/x.m4s?upsig=A',
      startTime: 1,
      responseEnd: 2,
    });

    const serialized = JSON.stringify(snapshotOf(state, null));
    expect(serialized).not.toContain('pathname');
    expect(serialized).not.toContain('.m4s');
    expect(serialized).not.toContain('upgcxcode');
    expect(serialized).not.toContain('webmask');
    expect(serialized).not.toContain('?');
  });
});

describe('recordPlayurl —— 第二条通道：B站 取流接口（T12）', () => {
  /** 普通视频的 playurl（旧接口） */
  const PLAYURL = 'https://api.bilibili.com/x/player/playurl?avid=1&cid=999&qn=80&fnval=4048';
  /** PGC 的 playurl（路径更深一层，靠同一个子串命中） */
  const PGC_PLAYURL = 'https://api.bilibili.com/pgc/player/web/playurl/v2?ep_id=12345&qn=80';
  /** 同域但不是取流的接口 —— 这条如果被收，时间轴会被无关请求塞满 */
  const NAV_API = 'https://api.bilibili.com/x/web-interface/nav';

  it('★ playurl → 一对 playurl-req / playurl-res，时间戳原样', () => {
    const state = createTraceState();
    const hit = recordPlayurl(state, { name: PLAYURL, startTime: 210.5, responseEnd: 384.25 });

    expect(hit).toBe(true);
    expect(state.events.map((e) => [e.stage, e.t])).toEqual([
      ['playurl-req', 210.5],
      ['playurl-res', 384.25],
    ]);
  });

  it('★ 不带 host / kind（api.bilibili.com 不是线路）', () => {
    const state = createTraceState();
    recordPlayurl(state, { name: PLAYURL, startTime: 10, responseEnd: 20 });

    for (const event of state.events) {
      expect(event.host).toBeUndefined();
      expect(event.kind).toBeUndefined();
    }
  });

  it('⛔ 不增加 hosts 计数（「N 条线路」不许被接口请求污染）', () => {
    const state = createTraceState();
    recordResource(state, { name: SEGMENT_URL, startTime: 100, responseEnd: 200 });
    const before = state.hosts.size;

    recordResource(state, { name: PLAYURL, startTime: 210, responseEnd: 300 });

    expect(state.hosts.size).toBe(before);
    expect(state.hosts.has('api.bilibili.com')).toBe(false);
  });

  it('⛔ 其它 api 请求一条都不收（nav / 日志 / 心跳）', () => {
    const state = createTraceState();
    for (const name of [
      NAV_API,
      'https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD',
      'https://data.bilibili.com/log/web?type=1',
    ]) {
      expect(recordPlayurl(state, { name, startTime: 1, responseEnd: 2 })).toBe(false);
      recordResource(state, { name, startTime: 1, responseEnd: 2 });
    }

    expect(state.events).toEqual([]);
    expect(state.hosts.size).toBe(0);
  });

  it('PGC 的 /pgc/player/web/playurl/v2 也命中（番剧同样有取流这一步）', () => {
    const state = createTraceState();
    expect(recordPlayurl(state, { name: PGC_PLAYURL, startTime: 5, responseEnd: 9 })).toBe(true);
    expect(state.events.map((e) => e.stage)).toEqual(['playurl-req', 'playurl-res']);
  });

  it('每一次 playurl 都记（画质切换 / 换轨会重新拉，那是事实）', () => {
    const state = createTraceState();
    recordResource(state, { name: PLAYURL, startTime: 100, responseEnd: 150 });
    recordResource(state, { name: PLAYURL, startTime: 9000, responseEnd: 9080 });

    expect(state.events.filter((e) => e.stage === 'playurl-req')).toHaveLength(2);
    expect(state.events.filter((e) => e.stage === 'playurl-res')).toHaveLength(2);
  });

  it('★ 不打断分片闸门：playurl 夹在两条同类别分片之间，分片事件仍是 2 条', () => {
    /**
     * 反例：把 `recordPlayurl()` 放进闸门判断之后、或让它碰 `lastSegReqCls`，
     * 那么"取流 → 同类别分片"就会被误判成一次类别变化，时间轴上多出一对
     * 并不存在的分片节点（用户会以为换了线）。
     */
    const state = createTraceState();
    recordResource(state, { name: SEGMENT_URL, startTime: 100, responseEnd: 200 });
    recordResource(state, { name: PLAYURL, startTime: 210, responseEnd: 300 });
    recordResource(state, { name: SEGMENT_URL, startTime: 400, responseEnd: 500 });

    expect(state.events.filter((e) => e.stage === 'seg-req')).toHaveLength(1);
    expect(state.hosts.get('xy116x196x140x25xy.mcdn.bilivideo.cn')?.count).toBe(2);
    // 顺序：分片 → 取流 → 返回（playurl 事件没有把分片事件挤掉）
    expect(state.events.map((e) => e.stage)).toEqual([
      'seg-req',
      'seg-res',
      'playurl-req',
      'playurl-res',
    ]);
  });

  it('⛔ 别把任意域上的 /playurl 当取流（后缀判据要带点）', () => {
    const state = createTraceState();
    for (const name of [
      'https://evil.com/x/player/playurl',
      'https://evilbilibili.com/x/player/playurl',
      'https://bilibili.com.evil.com/x/player/playurl',
    ]) {
      expect(recordPlayurl(state, { name, startTime: 1, responseEnd: 2 })).toBe(false);
    }
    expect(state.events).toEqual([]);
  });

  it('非法时间戳的那一半被丢掉，不会只留下半条配对', () => {
    const state = createTraceState();
    recordPlayurl(state, { name: PLAYURL, startTime: Number.NaN, responseEnd: 300 });

    // pushEvent 的纪律：非有限数直接丢，不修正成 0
    expect(state.events.map((e) => [e.stage, e.t])).toEqual([['playurl-res', 300]]);
  });
});

describe('recordResource —— 首次产事件，之后只累加计数', () => {
  it('首条：一对 seg-req / seg-res，时间戳原样保留', () => {
    const state = createTraceState();
    const isNew = recordResource(state, {
      name: SEGMENT_URL,
      startTime: 1234.5,
      responseEnd: 1300.25,
    });

    expect(isNew).toBe(true);
    expect(state.events.map((e) => [e.stage, e.t])).toEqual([
      ['seg-req', 1234.5],
      ['seg-res', 1300.25],
    ]);
    expect(state.events[0]?.host).toBe('xy116x196x140x25xy.mcdn.bilivideo.cn');
    expect(state.events[0]?.kind).toBe('pcdn');
    expect(state.hosts.get('xy116x196x140x25xy.mcdn.bilivideo.cn')?.count).toBe(1);
  });

  it('同一 host 的后续分片只加计数，不再进时间轴', () => {
    const state = createTraceState();
    recordResource(state, { name: SEGMENT_URL, startTime: 10, responseEnd: 20 });
    const isNew = recordResource(state, { name: SEGMENT_URL, startTime: 30, responseEnd: 40 });

    expect(isNew).toBe(false);
    expect(state.events).toHaveLength(2);
    expect(state.hosts.get('xy116x196x140x25xy.mcdn.bilivideo.cn')?.count).toBe(2);
  });

  it('同一 host 连发 5 条 → 只有 1 个 seg-req（抗淹没），count=5', () => {
    const state = createTraceState();
    for (let i = 0; i < 5; i += 1) {
      recordResource(state, { name: SEGMENT_URL, startTime: 10 + i, responseEnd: 11 + i });
    }

    expect(state.events.filter((e) => e.stage === 'seg-req')).toHaveLength(1);
    expect(state.events).toHaveLength(2);
    expect(state.hosts.get('xy116x196x140x25xy.mcdn.bilivideo.cn')?.count).toBe(5);
  });

  it('A,A,B(同类别),B,C(pcdn),C,A(official) → 3 条 seg-req，类别变化才记', () => {
    const A = 'https://cn-bj-ct-01-01.bilivideo.com/v.m4s?upsig=a'; // official
    const B = 'https://cn-bj-ct-01-02.bilivideo.com/v.m4s?upsig=b'; // official（另一台机器）
    const C = 'https://n1.szbdyd.com/v.m4s?upsig=c'; // pcdn
    const state = createTraceState();

    // A A B B C C A，每条间隔 1ms，便于断言 t
    const sequence: Array<[string, number]> = [
      [A, 1],
      [A, 2],
      [B, 3],
      [B, 4],
      [C, 5],
      [C, 6],
      [A, 7],
    ];
    for (const [name, t] of sequence) {
      recordResource(state, { name, startTime: t, responseEnd: t + 0.5 });
    }

    const segReqs = state.events.filter((e) => e.stage === 'seg-req');
    // B 与 A 同属 official：不发事件；C 换了类别：发；回到 A 又换回来：再发
    expect(segReqs.map((e) => [e.host, e.kind, e.t])).toEqual([
      ['cn-bj-ct-01-01.bilivideo.com', 'official', 1],
      ['n1.szbdyd.com', 'pcdn', 5],
      ['cn-bj-ct-01-01.bilivideo.com', 'official', 7],
    ]);
    // seg-res 只配首条（不发就不发），别为了对称让它变多
    expect(state.events.filter((e) => e.stage === 'seg-res')).toHaveLength(3);

    // 关键的跨模块性质：core 的换线判据得出"2 次"，且两次都跨类别
    const switches = detectSwitches(buildTimeline(state.events).events);
    expect(switches).toEqual([
      { t: 5, from: 'cn-bj-ct-01-01.bilivideo.com', to: 'n1.szbdyd.com' },
      { t: 7, from: 'n1.szbdyd.com', to: 'cn-bj-ct-01-01.bilivideo.com' },
    ]);

    // 计数一条不少：A 真实出现 3 次，B 2 次，C 2 次（即使 B 一次事件都没发）
    expect(state.hosts.get('cn-bj-ct-01-01.bilivideo.com')?.count).toBe(3);
    expect(state.hosts.get('cn-bj-ct-01-02.bilivideo.com')?.count).toBe(2);
    expect(state.hosts.get('n1.szbdyd.com')?.count).toBe(2);
  });

  it('纯同类别轮转（真机现场 23 次"换线"的回归守卫）：3 个 official 轮转 → 1 条 seg-req / 0 次切换', () => {
    // 2026-11-19 真机实测：B站 播放器在同一条官方 CDN 的两个边缘之间逐片轮转。
    // 按 host 变化计数会在这里产出 3 条 seg-req 与 2 次"换线" —— 那正是要防的假信号。
    const A = 'https://cn-jsnt-ct-01-06.bilivideo.com/v.m4s?upsig=a';
    const B = 'https://cn-jsnt-ct-01-01.bilivideo.com/v.m4s?upsig=b';
    const C = 'https://cn-jsnt-ct-01-02.bilivideo.com/v.m4s?upsig=c';
    const state = createTraceState();

    for (const [i, name] of [A, B, C].entries()) {
      recordResource(state, { name, startTime: i + 1, responseEnd: i + 1.5 });
    }

    expect(state.events.filter((e) => e.stage === 'seg-req')).toHaveLength(1);
    expect(detectSwitches(buildTimeline(state.events).events)).toEqual([]);
    // 三个 host 都在，计数各 1 —— "用过哪些机器"仍然查得到
    expect(state.hosts.size).toBe(3);
    expect(state.hosts.get('cn-jsnt-ct-01-06.bilivideo.com')?.count).toBe(1);
    expect(state.hosts.get('cn-jsnt-ct-01-01.bilivideo.com')?.count).toBe(1);
    expect(state.hosts.get('cn-jsnt-ct-01-02.bilivideo.com')?.count).toBe(1);
  });

  it('非媒体域的条目整条丢掉（没有 host 就没有"线路"可说）', () => {
    const state = createTraceState();
    recordResource(state, {
      name: 'https://api.bilibili.com/x/web-interface/nav',
      startTime: 1,
      responseEnd: 2,
    });
    // 同域静态资源也不许混进线路表（实测假阳性）
    recordResource(state, {
      name: 'https://upos-sz-staticcos-cmask.bilivideo.com/cmaskboss/137649199_25_2.webmask',
      startTime: 3,
      responseEnd: 4,
    });
    recordResource(state, {
      name: 'https://bvc.bilivideo.com/pbp/data',
      startTime: 5,
      responseEnd: 6,
    });

    expect(state.events).toHaveLength(0);
    expect(state.hosts.size).toBe(0);
  });

  it('非法时间戳不进环形缓冲，但计数照加', () => {
    const state = createTraceState();
    recordResource(state, { name: SEGMENT_URL, startTime: Number.NaN, responseEnd: -1 });

    expect(state.events).toHaveLength(0);
    expect(state.hosts.get('xy116x196x140x25xy.mcdn.bilivideo.cn')?.count).toBe(1);
  });
});

describe('环形缓冲 —— 上限 200，丢的是最早的', () => {
  /** 造一个 PCDN 供应商域下的第 i 个 host */
  const hostUrl = (i: number): string =>
    `https://n${String(i)}.szbdyd.com/v.m4s?upsig=s${String(i)}`;

  it('缓冲满后再来一条 resource 事件 → 保留最新 200 条并置 truncated', () => {
    const state = createTraceState();
    // 先灌满 200 条（`nav` 只是占位阶段，与 resource 无关）
    for (let i = 1; i <= 200; i += 1) {
      pushEvent(state, { t: i, stage: 'nav' });
    }
    recordResource(state, { name: hostUrl(1), startTime: 201, responseEnd: 202 });

    expect(state.events).toHaveLength(200);
    expect(state.truncated).toBe(true);
    // 丢的是最早那两条（t=1、t=2 的 nav），最后一条是本条 resource 的 seg-res
    expect(state.events[0]?.t).toBe(3);
    expect(state.events[199]?.stage).toBe('seg-res');
    expect(state.events[199]?.t).toBe(202);
  });

  it('截断与闸门都不影响计数：150 个同类 host 各 2 条 → 只有 1 对事件，计数一条不少', () => {
    const state = createTraceState();
    for (let i = 1; i <= 150; i += 1) {
      recordResource(state, { name: hostUrl(i), startTime: i, responseEnd: i + 0.5 });
      // 每个 host 再来一条：只加计数
      recordResource(state, { name: hostUrl(i), startTime: i + 2, responseEnd: i + 3 });
    }

    // 150 个 host 全是 pcdn（同类别轮转）：按 cls 闸门只应产出第一对事件
    expect(state.events).toHaveLength(2);
    expect(state.truncated).toBe(false);
    // 但"用过哪些机器、各发了多少请求"必须完整可查
    expect(state.hosts.size).toBe(150);
    expect(state.hosts.get('n1.szbdyd.com')?.count).toBe(2);
    expect(state.hosts.get('n150.szbdyd.com')?.count).toBe(2);
  });

  it('恰好 200 条时不置 truncated（边界不要提前报丢）', () => {
    const state = createTraceState();
    for (let i = 1; i <= 200; i += 1) {
      pushEvent(state, { t: i, stage: 'nav' });
    }

    expect(state.events).toHaveLength(200);
    expect(state.truncated).toBe(false);
  });
});

describe('snapshotOf —— actual 取 count 最大的真实线路', () => {
  it('空状态：present=false / confidence=none / actual=null', () => {
    const snapshot = snapshotOf(createTraceState(), null);

    expect(snapshot).toEqual({
      present: false,
      confidence: 'none',
      actual: null,
      hosts: [],
      events: [],
      truncated: false,
      video: null,
    });
  });

  it('有 resource 条目即 confidence=measured', () => {
    const state = createTraceState();
    recordResource(state, { name: SEGMENT_URL, startTime: 1, responseEnd: 2 });

    expect(snapshotOf(state, null).confidence).toBe('measured');
  });

  it('actual 是 count 最大的那条，而不是最先出现的那条', () => {
    const state = createTraceState();
    // 官方先出现 1 次，PCDN 后出现 3 次
    recordResource(state, {
      name: 'https://cn-bj-ct-01-01.bilivideo.com/v.m4s',
      startTime: 1,
      responseEnd: 2,
    });
    for (let i = 0; i < 3; i += 1) {
      recordResource(state, { name: SEGMENT_URL, startTime: 10 + i, responseEnd: 11 + i });
    }

    const snapshot = snapshotOf(state, null);
    expect(snapshot.actual).toEqual({
      host: 'xy116x196x140x25xy.mcdn.bilivideo.cn',
      cls: 'pcdn',
      flavor: null,
    });
    // hosts 按 count 降序
    expect(snapshot.hosts.map((h) => [h.host, h.count])).toEqual([
      ['xy116x196x140x25xy.mcdn.bilivideo.cn', 3],
      ['cn-bj-ct-01-01.bilivideo.com', 1],
    ]);
  });

  it('快照序列化后不含 query / 凭据的任何片段', () => {
    const state = createTraceState();
    recordResource(state, { name: SEGMENT_URL, startTime: 1, responseEnd: 2 });
    recordResource(state, {
      name: 'https://e1.akamaized.net/v.m4s?upsig=SECRETSIG&uparams=a,b',
      startTime: 3,
      responseEnd: 4,
    });

    const serialized = JSON.stringify(snapshotOf(state, null));
    for (const marker of CREDENTIAL_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
    expect(serialized).not.toContain('SECRETSIG');
  });

  it('`os=mcdn` 只影响分类，不进快照：序列化后既没有凭据也没有 query', () => {
    const state = createTraceState();
    recordResource(state, {
      name: 'https://cn-bj-ct-01-01.bilivideo.com/v.m4s?upsig=SECRETUPSIG&uparams=SECRETPARAMS&os=mcdn',
      startTime: 1,
      responseEnd: 2,
    });

    const snapshot = snapshotOf(state, null);
    // 分类用到了 query（因此是 pcdn），但 query 本身没被留下
    expect(snapshot.hosts).toEqual([
      { host: 'cn-bj-ct-01-01.bilivideo.com', cls: 'pcdn', flavor: null, count: 1 },
    ]);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('?');
    expect(serialized).not.toContain('SECRETUPSIG');
    expect(serialized).not.toContain('SECRETPARAMS');
    expect(serialized).not.toContain('os=mcdn');
    expect(serialized).not.toContain('upsig');
    expect(serialized).not.toContain('uparams');
  });

  it('video 原样透传（页面上没有 video 时是 null）', () => {
    const state = createTraceState();
    const video = { readyState: 4, durationSec: 180, height: 1080, errorCode: 0 };

    expect(snapshotOf(state, video).video).toEqual(video);
  });
});

describe('recordVideoStage —— waiting 归一成 stall', () => {
  it('只写阶段与时间，不带 host', () => {
    const state: LoadingTraceState = createTraceState();
    recordVideoStage(state, 'playing', 1000);
    recordVideoStage(state, 'stall', 2000);
    recordVideoStage(state, 'error', 3000, 'code=2');

    expect(state.events.map((e) => [e.stage, e.t])).toEqual([
      ['playing', 1000],
      ['stall', 2000],
      ['error', 3000],
    ]);
    expect(state.events[2]?.note).toBe('code=2');
    // 视频事件没有 host：线路只能由 resource 条目给出，不猜
    expect(state.events.every((e) => e.host === undefined)).toBe(true);
  });

  it('非法时间戳整条丢掉', () => {
    const state = createTraceState();
    recordVideoStage(state, 'canplay', Number.POSITIVE_INFINITY);
    recordVideoStage(state, 'canplay', -5);

    expect(state.events).toHaveLength(0);
  });
});

describe('pushEvent —— 环形上限', () => {
  it('超过 200 条时丢最早的一条并置 truncated', () => {
    const state = createTraceState();
    for (let i = 0; i <= 200; i += 1) {
      pushEvent(state, { t: i, stage: 'nav' });
    }

    expect(state.events).toHaveLength(200);
    expect(state.truncated).toBe(true);
    expect(state.events[0]?.t).toBe(1);
    expect(state.events[199]?.t).toBe(200);
  });
});

describe('recordExtPatch —— 「扩展介入」一次页面只记一条', () => {
  /**
   * ## 这条打点的数据来源
   *
   * 主世界（`src/content/main-world.js` 的 `reportExtPatch()`）**只在真的改写了
   * playurl 响应**之后发一条 `{ __PLUMA_EXT_PATCH__, at }`；`content.ts` 校验后
   * 调 `noteExtPatch(at)`。切清晰度 / 换轨会重新拉 playurl，于是**可能连发好几条**，
   * 而"扩展介入了"在一次页面里只发生一次 —— 去重在这里做。
   */
  it('★ 上报一次 → 时间轴上多一条 ext-patch（t 就是主世界给的 at）', () => {
    const state = createTraceState();
    expect(recordExtPatch(state, 1234.5)).toBe(true);

    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ t: 1234.5, stage: 'ext-patch' });
    // 它是"扩展动手"这一刻，不归属任何线路 —— 不许带上 host / kind
    expect(state.events[0]?.host).toBeUndefined();
    expect(state.events[0]?.kind).toBeUndefined();
  });

  it('★ 连发 3 次仍然只有 1 条（重复改写不刷屏）', () => {
    const state = createTraceState();
    expect([
      recordExtPatch(state, 100),
      recordExtPatch(state, 200),
      recordExtPatch(state, 300),
    ]).toEqual([true, false, false]);

    expect(state.events).toHaveLength(1);
    // 保留的是**第一条**：那才是"扩展第一次介入"的时刻
    expect(state.events[0]?.t).toBe(100);
  });

  it('⛔ 一次都没上报 → 一条都没有（不补一个"看起来正常"的节点）', () => {
    const state = createTraceState();
    recordVideoStage(state, 'playing', 1000);

    expect(state.events.map((e) => e.stage)).toEqual(['playing']);
  });

  it('非法时间戳丢弃，且**不占用**那唯一的一次机会', () => {
    const state = createTraceState();
    expect(recordExtPatch(state, Number.NaN)).toBe(false);
    expect(recordExtPatch(state, Number.POSITIVE_INFINITY)).toBe(false);
    expect(recordExtPatch(state, -1)).toBe(false);
    expect(state.events).toHaveLength(0);
    // 抛掉三条非法上报之后，合法的那条仍然记得下来
    expect(recordExtPatch(state, 50)).toBe(true);
    expect(state.events.map((e) => e.t)).toEqual([50]);
  });

  it('createTraceState 的新页面是干净的（重置之后可以再记一条）', () => {
    const first = createTraceState();
    recordExtPatch(first, 10);
    const second = createTraceState();
    expect(second.extPatchRecorded).toBe(false);
    expect(recordExtPatch(second, 20)).toBe(true);
  });
});

describe('recordNavStart —— 时间轴的原点', () => {
  /**
   * 纯函数这一半。**接线**（安装时真的记了这条）在
   * `loading-trace-nav.test.ts`（jsdom，要 `document`）。
   */
  it('记一条 nav @ 0（时基原点就是导航开始，不是测量值）', () => {
    const state = createTraceState();
    recordNavStart(state);

    expect(state.events).toEqual([{ t: 0, stage: 'nav' }]);
  });

  it('★ 在 buildTimeline 里排在所有事件之前（哪怕它最后才被追加）', () => {
    const state = createTraceState();
    recordResource(state, { name: SEGMENT_URL, startTime: 1530, responseEnd: 1600 });
    recordNavStart(state);

    const events = buildTimeline(state.events, 200).events;
    expect(events.map((e) => e.stage)).toEqual(['nav', 'seg-req', 'seg-res']);
    expect(events[0]?.t).toBe(0);
  });
});

describe('单例：reset 清空、快照不抛', () => {
  it('resetLoadingTrace 清掉计数与时间轴', () => {
    // jsdom 不是本文件的运行环境（environment: node），所以这里只验
    // "没有 <video> 时 getLoadingSnapshot 仍然可用" —— DOM 壳由真机验证覆盖。
    resetLoadingTrace();
    const snapshot = getLoadingSnapshot();

    expect(snapshot.hosts).toEqual([]);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.present).toBe(false);
    expect(snapshot.confidence).toBe('none');
    expect(snapshot.video).toBeNull();
  });

  /**
   * `noteExtPatch()` 是 `content.ts` 唯一的入口（它拿不到模块单例）。
   *
   * 这条同时钉住"重置会清掉 `extPatchRecorded`"：漏掉的话，换集 / 重载之后
   * 时间轴上**永远**不会再出现「扩展介入」—— 而且不报任何错。
   */
  it('noteExtPatch 走模块单例；resetLoadingTrace 之后能再记一条', () => {
    resetLoadingTrace();
    expect(noteExtPatch(10)).toBe(true);
    expect(noteExtPatch(20)).toBe(false);
    expect(getLoadingSnapshot().events.map((e) => e.stage)).toEqual(['ext-patch']);

    resetLoadingTrace();
    expect(noteExtPatch(30)).toBe(true);
    expect(getLoadingSnapshot().events.map((e) => e.t)).toEqual([30]);
  });
});
