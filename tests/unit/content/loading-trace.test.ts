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
  markTraceOrigin,
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
      hostCls: 'official',
    });
  });

  it('`mcdn` 子域即使挂在官方域下也判 pcdn（顺序即语义）', () => {
    expect(resolveMediaHost(SEGMENT_URL)).toEqual({
      host: 'xy116x196x140x25xy.mcdn.bilivideo.cn',
      cls: 'pcdn',
      flavor: null,
      /**
       * 只看主机也是 pcdn —— 它是**真实 PCDN 主机**（`mcdn` 独立标签），
       * 不是「官方镜像 + os=mcdn」那种改写产物。面板据此继续画橙色 P2P（ADR 0042）。
       */
      hostCls: 'pcdn',
    });
  });

  it('PCDN 供应商自有域 → pcdn', () => {
    expect(resolveMediaHost('https://a1.szbdyd.com/x.m4s')?.cls).toBe('pcdn');
  });

  it('Akamai → third-party', () => {
    expect(resolveMediaHost('https://e1.akamaized.net/x.m4s')?.cls).toBe('third-party');
  });

  it('★ 没实测过的域：**照常算媒体域**，`cls` 是 unknown（2026-11-17 P0-1）', () => {
    /**
     * 反例（旧行为，正是审计的 P0）：`cls === 'unknown'` 时 `return null` ——
     * B站 新增一个 PCDN 供应商域时，`hosts` 里没有它，面板显示「0 条线路 /
     * 没有 PCDN」，而流量确实在跑。
     *
     * 现在 unknown 照常返回（计数进 `hosts`），只是不参与"当前线路"的结论。
     * 非媒体路径仍然返回 null（下一组用例守着）。
     */
    expect(resolveMediaHost('https://evil-mcdn.attacker.test/x.m4s')).toEqual({
      host: 'evil-mcdn.attacker.test',
      cls: 'unknown',
      flavor: null,
      hostCls: 'unknown',
    });
    // 不是媒体分片 → 仍然不收（`isMediaPath` 是前置门，一个字没改）
    expect(resolveMediaHost('https://api.bilibili.com/x/player/playurl')).toBeNull();
  });

  it('官方域 + query 里的 `os=mcdn` → pcdn（官方镜像代理 mcdn 资源）', () => {
    // 只看域名会把这条判成 official，等于对用户陈述错误事实
    expect(
      resolveMediaHost('https://cn-bj-ct-01-01.bilivideo.com/v.m4s?upsig=AA&uparams=BB&os=mcdn'),
    ).toEqual({
      host: 'cn-bj-ct-01-01.bilivideo.com',
      cls: 'pcdn',
      flavor: null,
      /**
       * ★ **ADR 0042 的关键一格**：主机是官方自建边缘，只因资源标记 `os=mcdn`
       * 才被判成 pcdn。`cls` 不变（过滤链路仍看它，边界 2），
       * 新增的 `hostCls` 让面板如实说"走的是官方镜像"。
       */
      hostCls: 'official',
    });
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

/**
 * ## ADR 0042：`hostCls` —— 只看主机时的类别
 *
 * 这一组钉的是**改写后的真实形态**。候选项的 authority 被换到官方镜像、
 * `search` 一字不动（签名参数 `uparams` 含 `os`，删了 403），于是：
 *
 * ```
 * 改写前：x5zy69j.edge.mountaintoys.cn/...?os=mcdn    → cls=pcdn / hostCls=pcdn
 * 改写后：upos-sz-mirrorhw.bilivideo.com/...?os=mcdn  → cls=pcdn / hostCls=official
 * ```
 *
 * `cls` 不变（过滤链路仍看它，ADR 0042 边界 2）；`hostCls` 是新增的那一格，
 * 面板靠它把"已经是官方镜像"如实显示出来，而不是继续画橙色 P2P。
 *
 * ⚠️ 反例：把 `hostCls` 改成 `resolveMediaHost()` 里也传 `search`
 * （即 `classifyCdn(host, parsed.search)` 两次）→ 两条用例的 `hostCls`
 * 都会变成 `pcdn`，面板退回旧 bug。
 */
describe('resolveMediaHost —— hostCls：只看主机（ADR 0042）', () => {
  it('★ 改写后的真实形态：官方镜像 + os=mcdn → cls=pcdn **但 hostCls=official**', () => {
    expect(resolveMediaHost('https://upos-sz-mirrorhw.bilivideo.com/x.m4s?os=mcdn')).toEqual({
      host: 'upos-sz-mirrorhw.bilivideo.com',
      // 过滤链路看的仍是这个：官方镜像代理 mcdn 源，判据不许收窄（边界 4）
      cls: 'pcdn',
      flavor: null,
      // 面板看的是这个：这台机器本身就是官方服务商镜像
      hostCls: 'official',
    });
  });

  it('★ 真实 PCDN 主机：两个都是 pcdn（面板继续画橙色 P2P，一个字不改）', () => {
    expect(resolveMediaHost('https://x5zy69j.edge.mountaintoys.cn/x.m4s?os=mcdn')).toEqual({
      host: 'x5zy69j.edge.mountaintoys.cn',
      cls: 'pcdn',
      flavor: null,
      // 只看主机也判 pcdn ⇒ 不是改写产物 ⇒ 不许折回官方
      hostCls: 'pcdn',
    });
  });

  it('`mcdn` 标签主机同样两个都是 pcdn（官方域下的 mcdn 子域）', () => {
    // 这条最容易出错：host 是 `bilivideo.cn` 的子域，但第 3 条先命中
    expect(resolveMediaHost('https://xy180x129x222x41xy.mcdn.bilivideo.cn/x.m4s')).toEqual({
      host: 'xy180x129x222x41xy.mcdn.bilivideo.cn',
      cls: 'pcdn',
      flavor: null,
      hostCls: 'pcdn',
    });
  });

  it('没有 query 时两个字段恒相等（`hostCls` 不是另一次判定）', () => {
    for (const url of [
      'https://cn-jsnt-ct-01-06.bilivideo.com/v.m4s',
      'https://upos-sz-mirrorcos.bilivideo.com/v.m4s',
      'https://x.akamaized.net/v.m4s',
      'https://xyz.example-cdn.com/v/abc.m4s',
    ]) {
      const got = resolveMediaHost(url);
      expect(got, url).not.toBeNull();
      expect(got?.hostCls, url).toBe(got?.cls);
    }
  });

  it('★ `hostCls` 是个枚举，不是 query：快照里仍然搜不到任何凭据片段', () => {
    /**
     * ADR 0042 边界 5：`search` 不进快照，而 `hostCls` 是枚举 —— 两者不冲突。
     * 这条把边界两边一起钉住：多问了一次 `classifyCdn(host)`，但没有多留一个字符串。
     */
    const state = createTraceState();
    recordResource(state, {
      name: 'https://upos-sz-mirrorhw.bilivideo.com/x.m4s?upsig=SECRETSIG&uparams=e,os&os=mcdn',
      startTime: 1,
      responseEnd: 2,
    });

    const snapshot = snapshotOf(state, null);
    expect(snapshot.hosts).toEqual([
      {
        host: 'upos-sz-mirrorhw.bilivideo.com',
        cls: 'pcdn',
        flavor: null,
        hostCls: 'official',
        count: 1,
      },
    ]);

    const serialized = JSON.stringify(snapshot);
    for (const marker of CREDENTIAL_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
    expect(serialized).not.toContain('SECRETSIG');
    expect(serialized).not.toContain('os=mcdn');
  });

  it('★ `actual` 也带 `hostCls`（结论大字要靠它，缺了就只能显示 P2P）', () => {
    const state = createTraceState();
    recordResource(state, {
      name: 'https://upos-sz-mirrorhw.bilivideo.com/x.m4s?os=mcdn',
      startTime: 1,
      responseEnd: 2,
    });

    expect(snapshotOf(state, null).actual).toEqual({
      host: 'upos-sz-mirrorhw.bilivideo.com',
      cls: 'pcdn',
      flavor: null,
      hostCls: 'official',
    });
  });
});

describe('resolveMediaHost —— 路径判据：只认媒体分片（2026-11-19 真机假阳性）', () => {
  it('`.m4s` + `/upgcxcode/` → 计入', () => {
    // `cn-x-1.…` 命中自建边缘正则，所以 flavor 是 `self-built`（不是 null）
    expect(resolveMediaHost('https://cn-x-1.bilivideo.com/upgcxcode/99/91/x.m4s?upsig=A')).toEqual({
      host: 'cn-x-1.bilivideo.com',
      cls: 'official',
      flavor: 'self-built',
      hostCls: 'official',
    });
  });

  it('无扩展名但落在 `/upgcxcode/` 下 → 计入（兜住"将来没有扩展名的分片"）', () => {
    expect(resolveMediaHost('https://cn-x-1.bilivideo.com/upgcxcode/99/91/noext')).toEqual({
      host: 'cn-x-1.bilivideo.com',
      cls: 'official',
      flavor: 'self-built',
      hostCls: 'official',
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

  /**
   * ★★ 2026-11-20 真机反馈第 4 条：PGC **换集**走的是 `/ogv/player/playview`，
   * 它的 pathname **不含 `/playurl`** —— 只按 `/playurl` 判会整条漏掉。
   *
   * 漏掉的后果不只是少两行：`recordPlayurl()` 还负责「本页由扩展代理 →
   * 这一次取流就是扩展介入」的上报，而换集时 `resetLoadingTrace()` 会把
   * `extPatchRecorded` 清空。于是新一集里「扩展介入」永远不会重新出现。
   */
  it('★★ PGC 换集的 /ogv/player/playview 也命中（换集不走 playurl）', () => {
    const state = createTraceState();
    const hit = recordPlayurl(state, {
      name: 'https://api.bilibili.com/ogv/player/playview?ep_id=733318&qn=80&fnval=4048',
      startTime: 2636700.2,
      responseEnd: 2636822.9,
    });

    expect(hit, 'playview 必须命中，否则换集时时间轴缺「发出取流请求」两行').toBe(true);
    expect(state.events.map((e) => [e.stage, e.t])).toEqual([
      ['playurl-req', 2636700.2],
      ['playurl-res', 2636822.9],
    ]);
  });

  it('★ 换集时 playview 也会补 ext-patch（reset 后新一集仍需「扩展介入」）', () => {
    /**
     * 时序照抄真机：`resetLoadingTrace()` 清掉 `extPatchRecorded` →
     * 换集请求发出 → 命中 playview → `streamingProxied` 为真则补一条。
     *
     * 反例：如果 playview 不命中，这一集时间轴上就**永远**没有
     * 「接管取流」那一行，尽管扩展正在换流。
     */
    const state = createTraceState();
    state.streamingProxied = true;
    state.extPatchRecorded = false;

    recordPlayurl(state, {
      name: 'https://api.bilibili.com/ogv/player/playview?ep_id=733318&qn=80',
      startTime: 5000,
      responseEnd: 5100,
    });

    const ext = state.events.filter((e) => e.stage === 'ext-patch');
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ t: 5000, note: '接管取流' });
  });

  it('⛔ playview 也走同一个域判据（别单开一条放行的口子）', () => {
    const state = createTraceState();
    for (const name of [
      'https://evil.com/ogv/player/playview',
      'https://evilbilibili.com/ogv/player/playview',
      'https://bilibili.com.evil.com/ogv/player/playview',
    ]) {
      expect(recordPlayurl(state, { name, startTime: 1, responseEnd: 2 })).toBe(false);
    }
    expect(state.events).toEqual([]);
  });

  it('⛔ 只认 /ogv/player/playview，同前缀的其它 ogv 接口不收', () => {
    const state = createTraceState();
    for (const name of [
      'https://api.bilibili.com/ogv/player/playviewx?ep_id=1',
      'https://api.bilibili.com/ogv/player/playinfo?ep_id=1',
      'https://api.bilibili.com/ogv/review/list?ep_id=1',
    ]) {
      expect(recordPlayurl(state, { name, startTime: 1, responseEnd: 2 })).toBe(false);
    }
    expect(state.events).toEqual([]);
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
      // 2026-11-17 接线 / 0039 升级：候选改写的累计结果（默认全 0）
      filter: { applied: false, rewritten: 0, proxied: 0, fallbackKept: 0 },
      // 2026-11-20 归零：0 = 还没换过集 ⇒ 时间轴时基仍是页面 timeOrigin
      originT: 0,
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
      hostCls: 'pcdn',
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

    /**
     * ## ADR 0042 的关键一条：这个 host 就是改写后的形态
     *
     * `hostCls: 'official'` ⇒ 它是官方自建边缘，只因资源标记 `os=mcdn` 才判 pcdn。
     * 面板靠这一格不再画橙色 P2P（见 `loading-pane.ts` 的 `renderedKind()`）。
     * `os=mcdn` 这个**字符串**仍然不进快照（下面几条断言），
     * 进快照的只是一个枚举 —— 那正是 `loading-trace.ts` 边界 5 允许的。
     */
    const snapshot = snapshotOf(state, null);
    // 分类用到了 query（因此是 pcdn），但 query 本身没被留下
    expect(snapshot.hosts).toEqual([
      {
        host: 'cn-bj-ct-01-01.bilivideo.com',
        cls: 'pcdn',
        flavor: null,
        hostCls: 'official',
        count: 1,
      },
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

describe('P0-1 · unknown 不再被丢弃', () => {
  /** 一个**没实测过**的媒体域：`.m4s` 路径命中媒体判据，但 `classifyCdn` 认不出 */
  const UNKNOWN_URL = 'https://xyz.example-cdn.com/video/abc.m4s?upsig=1';

  it('★ 认不出源的媒体请求照常进 hosts、count 正确', () => {
    const state = createTraceState();
    recordResource(state, { name: UNKNOWN_URL, startTime: 100, responseEnd: 200 });
    recordResource(state, { name: UNKNOWN_URL, startTime: 300, responseEnd: 400 });

    const stat = state.hosts.get('xyz.example-cdn.com');
    expect(stat).toEqual({ cls: 'unknown', flavor: null, hostCls: 'unknown', count: 2 });
  });

  it('★ `actual` **不**取它（结论只在已知类别里挑）', () => {
    const state = createTraceState();
    // unknown 出现 3 次，官方只出现 1 次 —— argmax 会被 unknown 抢走
    for (let i = 0; i < 3; i += 1) {
      recordResource(state, { name: UNKNOWN_URL, startTime: 10 + i, responseEnd: 11 + i });
    }
    recordResource(state, {
      name: 'https://cn-bj-ct-01-01.bilivideo.com/v.m4s',
      startTime: 20,
      responseEnd: 21,
    });

    const snapshot = snapshotOf(state, null);
    expect(snapshot.actual?.host).toBe('cn-bj-ct-01-01.bilivideo.com');
    // hosts 里仍然有那条认不出的（用户要能看见它）
    expect(snapshot.hosts.map((h) => h.cls)).toContain('unknown');
  });

  it('★ 只有 unknown 时 actual=null，但 hosts 不空、present 仍为真', () => {
    const state = createTraceState();
    recordResource(state, { name: UNKNOWN_URL, startTime: 1, responseEnd: 2 });

    const snapshot = snapshotOf(state, null);
    expect(snapshot.actual).toBeNull();
    expect(snapshot.hosts).toHaveLength(1);
    // "什么都没看到" 与 "看到了但认不出" 是两件事：present 必须为真
    expect(snapshot.present).toBe(true);
  });

  it('unknown 也走 `cls` 闸门（不会每条都产事件）', () => {
    const state = createTraceState();
    for (let i = 0; i < 5; i += 1) {
      recordResource(state, { name: UNKNOWN_URL, startTime: 10 + i, responseEnd: 11 + i });
    }
    expect(state.events.filter((e) => e.stage === 'seg-req')).toHaveLength(1);
    expect(state.events[0]?.kind).toBe('unknown');
  });

  it('⛔ 同域静态资源仍然进不来（`isMediaPath` 是前置门，没放宽）', () => {
    const state = createTraceState();
    recordResource(state, {
      name: 'https://xyz.example-cdn.com/pbp/data',
      startTime: 1,
      responseEnd: 2,
    });

    expect(state.hosts.size).toBe(0);
    expect(state.events).toEqual([]);
  });
});

describe('P0-3 · 扩展介入的第二个触发点（接管取流）', () => {
  const PLAYURL = 'https://api.bilibili.com/x/player/playurl?avid=1&cid=999&qn=80';

  it('★ 本页由扩展代理 → playurl 命中时补一条 ext-patch（t 用同一个 startTime）', () => {
    const state = createTraceState();
    state.streamingProxied = true;

    recordPlayurl(state, { name: PLAYURL, startTime: 210.5, responseEnd: 384.25 });

    const patch = state.events.find((e) => e.stage === 'ext-patch');
    expect(patch).toEqual({ t: 210.5, stage: 'ext-patch', note: '接管取流' });
  });

  it('⛔ 取流身份是 `page`（activated=false）→ **不出现**（这是正确的不出现）', () => {
    const state = createTraceState();
    state.streamingProxied = false;

    recordPlayurl(state, { name: PLAYURL, startTime: 210.5, responseEnd: 384.25 });

    expect(state.events.map((e) => e.stage)).toEqual(['playurl-req', 'playurl-res']);
  });

  it('同一次页面只留第一条：第二次 playurl 不再补', () => {
    const state = createTraceState();
    state.streamingProxied = true;

    recordPlayurl(state, { name: PLAYURL, startTime: 100, responseEnd: 150 });
    recordPlayurl(state, { name: PLAYURL, startTime: 9000, responseEnd: 9080 });

    expect(state.events.filter((e) => e.stage === 'ext-patch')).toHaveLength(1);
    expect(state.events.find((e) => e.stage === 'ext-patch')?.t).toBe(100);
  });

  it('★ 主世界那条上报仍然有效，但**不会**覆盖已经记下的第一条', () => {
    /**
     * 真实顺序：playurl 请求先发出（接管取流），响应回来后才可能被改写
     * （主世界 `reportExtPatch()` → `noteExtPatch()` → `recordExtPatch()`）。
     * 两者共用 `extPatchRecorded`，所以只留第一条。
     */
    const state = createTraceState();
    state.streamingProxied = true;

    recordPlayurl(state, { name: PLAYURL, startTime: 100, responseEnd: 150 });
    // 等价于主世界那条上报（同一个 `recordExtPatch`，走 noteExtPatch 那条通道）
    expect(recordExtPatch(state, 160, '接管取流')).toBe(false);

    expect(state.events.filter((e) => e.stage === 'ext-patch')).toHaveLength(1);
    expect(state.events.find((e) => e.stage === 'ext-patch')).toEqual({
      t: 100,
      stage: 'ext-patch',
      note: '接管取流',
    });
  });

  it('没有代理时，主世界那条上报照样能记（note 是「接管取流」）', () => {
    /**
     * ## 为什么这里期望的是「接管取流」而不是「改写响应」（2026-11-19 改）
     *
     * 主世界 `reportExtPatch()` 有**两个**语义不同的调用方，消息里不带来源标记：
     * 一是 XHR 改写响应体，二是 PGC 在 `__playinfo__` setter 里换整份
     * `result.video_info`（**一个响应体都没碰**）。后者说成「改写响应」是事实错误。
     *
     * 采集侧于是统一用「接管取流」—— 两条路径对用户是同一件事：扩展接管了这次取流。
     * 代价是明细行无法区分两者（故意的，理由见 `noteExtPatch()` 的注释）。
     */
    resetLoadingTrace();
    expect(noteExtPatch(500)).toBe(true);
    expect(getLoadingSnapshot().events).toEqual([{ t: 500, stage: 'ext-patch', note: '接管取流' }]);
  });

  it('代理标记是**读时判定**：先设置后取流才算（不回填历史）', () => {
    /**
     * `page/activate` 回包比第一批请求晚（~400ms）。如果实现改成"回包时回填"，
     * 就会把回包之前的历史改写成"扩展介入过" —— 那是在补造事件。
     * 这里钉住的是**顺序**：只有标记之后发生的取流才算。
     */
    const state = createTraceState();
    recordPlayurl(state, { name: PLAYURL, startTime: 100, responseEnd: 150 });
    expect(state.events.some((e) => e.stage === 'ext-patch')).toBe(false);

    state.streamingProxied = true;
    // 标记之后，历史那一条仍然是 playurl-req / playurl-res，没有被改写
    expect(state.events.map((e) => e.stage)).toEqual(['playurl-req', 'playurl-res']);

    recordPlayurl(state, { name: PLAYURL, startTime: 900, responseEnd: 950 });
    expect(state.events.filter((e) => e.stage === 'ext-patch')).toHaveLength(1);
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

// ─────────────────────── 时间轴归零（2026-11-20，真机换集）───────────────────────

describe('markTraceOrigin —— 换集后时间轴从本集 0.00s 起算', () => {
  /**
   * ## 这一组修的是什么（真机实测）
   *
   * 番剧 `ep341217 ⇄ ep341218 ⇄ ep341219` 换集后，时间轴首行出现
   * `55.62s` / `91.35s` / `267.49s` 这种大数 —— 用户读成"这一集从 267 秒开始播"。
   * 实测 `t=3229.65s`，而本集 `video.duration=1441s`（前者是它的 2.24 倍），
   * 因为它其实是**相对页面 `timeOrigin` 的绝对毫秒**。
   *
   * 归零的实现在**输出层**（`snapshotOf()` 里平移），`core/loading/timeline.ts`
   * 签名一字未动 —— 它的排序/去重语义建立在原始时基上，平移必须在它之后做。
   */
  it('★ originT=0（未换集）→ **原样**返回，不新产数组（首屏行为逐字节不变）', () => {
    const state = createTraceState();
    recordVideoStage(state, 'canplay', 1772);
    recordVideoStage(state, 'playing', 3270.2);

    const before = state.events;
    const snapshot = snapshotOf(state, null);

    expect(snapshot.originT).toBe(0);
    expect(snapshot.events.map((e) => e.t)).toEqual([1772, 3270.2]);
    // 不产出新数组：`events` 逐元素与状态里**同一批对象**（不是 map 出来的副本）
    expect(snapshot.events).toEqual(before);
  });

  it('★ 定了原点 → 每条事件的 t 都减去它（首行变成小数值）', () => {
    const state = createTraceState();
    recordVideoStage(state, 'canplay', 3_225_000);
    recordVideoStage(state, 'playing', 3_229_650);

    state.originT = 3_225_000;
    const snapshot = snapshotOf(state, null);

    expect(snapshot.originT).toBe(3_225_000);
    expect(snapshot.events.map((e) => e.t)).toEqual([0, 4650]);
  });

  it('⛔ 早于原点的事件（reset 前残留）→ 钳在 0，**不产出负数**', () => {
    /**
     * 负的 `t` 会造成两个错：`clockText()` 有 `ms > 0` 守卫，负数被显示成
     * `0.00`（看起来正常，掩盖了异常）；而 `+x.xxs` 的增量是两条 `t` 相减，
     * 会算出一个荒谬的负增量。所以钳在 0。
     */
    const state = createTraceState();
    recordVideoStage(state, 'canplay', 1000);
    recordVideoStage(state, 'playing', 3000);

    state.originT = 2000;
    expect(snapshotOf(state, null).events.map((e) => e.t)).toEqual([0, 1000]);
  });

  it('非有限数 / 负数 → 忽略（**不修正成 0**，与 pushEvent 同一条纪律）', () => {
    resetLoadingTrace();
    markTraceOrigin(5000);
    expect(getLoadingSnapshot().originT).toBe(5000);

    /**
     * 非法值不许把已经记好的原点改掉，也不许改成某个"看起来正常"的数 ——
     * 与 `pushEvent()` / `recordExtPatch()` 同一条纪律：非法时间戳直接丢。
     */
    markTraceOrigin(Number.NaN);
    markTraceOrigin(Number.POSITIVE_INFINITY);
    markTraceOrigin(Number.NEGATIVE_INFINITY);
    markTraceOrigin(-1);
    expect(getLoadingSnapshot().originT).toBe(5000);

    resetLoadingTrace();
  });

  it('⛔ 非法值从 `0` 起算：`NaN` 不许进 `originT`，更不许污染整条时间轴', () => {
    /**
     * 上一条守的是"非法值不许**改写**一个已记好的原点"。这一条守的是更靠前的一步：
     * 从 `0` 起算时，`NaN` 也不许被写进去。
     *
     * ## 为什么只断言 `originT === 0` 是不够的
     *
     * 真正会被用户看见的不是那个字段，而是时间轴。若护栏漏掉（把 `Number.isNaN`
     * 的那半边判据去掉），`originT` 会变成 `NaN`，于是 `shiftToOrigin()` 第一条
     * 判据 `originT <= 0` 得到 **`false`**（`NaN` 与任何数比较都是 `false`），
     * 走进 `Math.max(0, t - NaN)` → `NaN`。后果是：
     *   - 每一条事件的 `t` 都是 `NaN`
     *   - `clockText()` 对 `NaN` 有兜底，显示成 `0.00` —— **看起来完全正常**
     *   - `+x.xxs` 增量是两条 `t` 相减，全是 `NaN`
     *
     * 也就是说，一个非法的入参能让整条时间轴静默变成一张"看起来正常"的废纸。
     * 所以这条用例**同时**断言字段、事件值与有限性，三件事缺一件都守不住。
     */
    resetLoadingTrace();
    expect(noteExtPatch(55_620)).toBe(true);
    expect(getLoadingSnapshot().events.map((e) => e.t)).toEqual([55_620]);

    markTraceOrigin(Number.NaN);
    const afterNaN = getLoadingSnapshot();
    expect(afterNaN.originT).toBe(0);
    expect(afterNaN.events.map((e) => e.t)).toEqual([55_620]);
    expect(afterNaN.events.every((e) => Number.isFinite(e.t))).toBe(true);

    markTraceOrigin(-1);
    expect(getLoadingSnapshot().originT).toBe(0);

    /**
     * `0` 是"还没换过集"的哨兵值，**不是**"已归零到第 0 毫秒" ——
     * 这两个语义必须能对上：写了 `0` 之后时间轴仍按原始时基走，不平移。
     */
    markTraceOrigin(0);
    expect(getLoadingSnapshot().originT).toBe(0);
    expect(getLoadingSnapshot().events.map((e) => e.t)).toEqual([55_620]);

    resetLoadingTrace();
  });

  it('★ 跨时基：换集前的 `55620` / `91350` 换集后变成 `100` / `420`（问题 1 的全部内容）', () => {
    /**
     * ## 这一条才是用户那个问题
     *
     * 前几条测的是"原点存对了""`snapshotOf()` 真的减了"两个零件。但真机上用户看到的
     * 是一张截图：番剧 `ep341217 ⇄ ep341218` 换集后首行 `55.62s`、次行 `91.35s`
     * （`t=55620` / `t=91350`，相对**页面** `timeOrigin`，与本集 `duration=1441s`
     * 根本对不上）。这一条把那张截图的数字原样摆进来，走**真实的单例链路**
     * （`noteExtPatch` 灌事件 → `resetLoadingTrace` → `markTraceOrigin` →
     * `getLoadingSnapshot`），断言用户最后看到的是 `0.10s` / `0.42s`。
     *
     * ## 反例意义
     *
     * 只测"`markTraceOrigin(55900)` 之后 `originT === 55900"是**不够的** ——
     * 参数存进去但 `snapshotOf()` 没接上也全绿。所以这里断言的是
     * `getLoadingSnapshot().events` 的 `t`，那是面板真正读的那个数。
     *
     * `noteExtPatch()` 用它而不是 `pushEvent(state, ...)` 是因为后者要拿到 `state`：
     * 单例不导出，而 `content.ts` 走的正是 `noteExtPatch()` 这条路 —— 用同一条路，
     * 这条用例才在测"接线"而不只是"算法"。
     */
    resetLoadingTrace();

    // ── 换集前（上一集，页面已加载 55.6 秒）──
    //
    // `noteExtPatch()` 是单例**唯一**能灌一条带自定义 `t` 的公开入口（`pushEvent()`
    // 要拿到 `state`，而单例不导出）。它幂等，所以换集前最多一条 —— 够了：
    // 这条要证明的是"旧时基的事件不会残留到新一集"，一条就能证明。
    expect(noteExtPatch(55_620)).toBe(true);
    expect(getLoadingSnapshot().events.map((e) => e.t)).toEqual([55_620]);

    // ── 换集：三句是 `content.ts` 里那个调用序列的最小复刻 ──
    resetLoadingTrace(); // 1) 清空上一集
    markTraceOrigin(55_900); // 2) 记本集起点（`performance.now()`）
    expect(noteExtPatch(56_000)).toBe(true); // 3) 新一集的事件按原始时基继续记

    const snapshot = getLoadingSnapshot();
    expect(snapshot.originT).toBe(55_900);
    // 用户看到的：0.10s（不是 56.00s，也不是 55.62s）
    expect(snapshot.events.map((e) => e.t)).toEqual([100]);
    expect(snapshot.events).toHaveLength(1);

    resetLoadingTrace();
  });

  it('★ 跨时基（多条）：`55620` / `91350` → 换集后 `100` / `420`', () => {
    /**
     * 上一条用单例链路（问题 1 的接线），但单例**只有一个**灌事件的公开入口
     * （`noteExtPatch()` 幂等，写一次就不再写），所以那条只能放一条新事件。
     * 这一条用 `snapshotOf()` 对齐 Lead 那组数字的**两条**事件，保证平移对
     * 每一条都生效，而不是碰巧第一条对。
     *
     * 上一集的 `55620` / `91350` 正是截图里的 `55.62s` / `91.35s`；换集后本集记的是
     * `56000` / `56320`，原点 `55900` → 必须变成 `100` / `420`。
     *
     * ⚠️ 这里直接写 `state.originT` 而不是调 `markTraceOrigin()`：后者只写**单例**，
     * 而这份 `state` 是本用例自己造的。`markTraceOrigin()` 的写入路径由上一条
     * 用例（真单例）守，这条守的是**平移**。两者分工不同，别以为这是绕过测试。
     */
    const history = createTraceState();
    recordVideoStage(history, 'canplay', 55_620);
    recordVideoStage(history, 'playing', 91_350);
    expect(snapshotOf(history, null).events.map((e) => e.t)).toEqual([55_620, 91_350]);

    // 换集：`resetLoadingTrace()` 的语义等价于换一份全新 state（本用例就地模拟）
    const fresh = createTraceState();
    expect(fresh.originT).toBe(0); // 清空后原点回到哨兵值

    recordVideoStage(fresh, 'canplay', 56_000);
    recordVideoStage(fresh, 'playing', 56_320);
    fresh.originT = 55_900;

    const snapshot = snapshotOf(fresh, null);
    expect(snapshot.originT).toBe(55_900);
    expect(snapshot.events.map((e) => e.t)).toEqual([100, 420]);
  });

  it('幂等：重复调用以**最后一次**为准', () => {
    resetLoadingTrace();
    markTraceOrigin(1000);
    markTraceOrigin(2000);
    expect(getLoadingSnapshot().originT).toBe(2000);
    resetLoadingTrace();
  });

  it('★ 平移发生在 buildTimeline **之后**：排序/去重仍按原始 t', () => {
    /**
     * 若先平移再归一，`originT` 的精度就会参与去重键 —— 那是一个没人会想到的前提。
     * 这里用"乱序输入 + 同 t 去重"两条一起钉住：结果必须是**按原始 t 排好序**的
     * 那 3 条（2000 重复的那条被去重），且平移后仍然单调不减。
     */
    const state = createTraceState();
    recordVideoStage(state, 'playing', 3000);
    recordVideoStage(state, 'canplay', 2000);
    recordVideoStage(state, 'canplay', 2000); // 重复：buildTimeline 会去掉
    recordVideoStage(state, 'stall', 1000);

    state.originT = 1000;
    const events = snapshotOf(state, null).events;

    expect(events.map((e) => [e.stage, e.t])).toEqual([
      ['stall', 0],
      ['canplay', 1000],
      ['playing', 2000],
    ]);
  });

  it('原点**不进 events**：时间轴上不会凭空多出一个节点', () => {
    const state = createTraceState();
    recordVideoStage(state, 'playing', 5000);
    state.originT = 5000;

    expect(snapshotOf(state, null).events).toHaveLength(1);
    expect(state.events).toHaveLength(1);
  });

  it('★ resetLoadingTrace() 把 originT 清回 0（调用方必须自己补 markTraceOrigin）', () => {
    /**
     * 两条调用是**刻意的**：`resetLoadingTrace()` 的语义是"清空"，让它顺手读时钟
     * 猜一个原点等于把两个职责塞进一个函数。漏补 `markTraceOrigin()` 的后果
     * 不是崩溃，而是新一集的时间轴仍然显示 `55.62s` 这种大数。
     */
    resetLoadingTrace();
    markTraceOrigin(6000);
    expect(getLoadingSnapshot().originT).toBe(6000);

    resetLoadingTrace();
    expect(getLoadingSnapshot().originT).toBe(0);
  });
});
