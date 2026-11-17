// @vitest-environment jsdom

/**
 * 活动页 nano 接流的**结构性**测试（方案 B 第 3 步）。
 *
 * ## ⚠️ 这组测试证明不了什么
 *
 * `src/content/main-world.js` 是 MAIN world 裸 JS，由 `win.eval(SOURCE)` 直接跑真源码；
 * `check-page-gate.mjs` 只扫 .ts、`check-patch-scope.mjs` 只看写集——**main-world 是静态守卫
 * 盲区**。jsdom 里也没有真的 B站播放器、没有 DNR 换 Cookie、没有登录态 4K。
 *
 * 所以这里只钉住**结构性事实**：判据命中、setter 装上、createPlayer 被包、
 * config.requestConfig 被新建并挂上回调、返回体带 data 层、失败有降级出口。
 * "真的吃下 dash 流 / 4K 登录态 / SPA 换片不串场 / 无黑屏"只能真机验收，
 * 埋点字段见 `window.__PLUMA_FESTIVAL__`（报告里逐项列出）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');

const FESTIVAL_URL = 'https://www.bilibili.com/festival/COLMO2026?bvid=BV1ydeX65Edn';
const VIDEO_URL = 'https://www.bilibili.com/video/BV1xx411c7mD';
const PGC_URL = 'https://www.bilibili.com/bangumi/play/ss34412';

interface FetchCall {
  url: string;
  init: { credentials?: string } | undefined;
}

interface Sandbox {
  win: JSDOM['window'];
  page: Record<string, any>;
  sent: Array<Record<string, unknown>>;
  fetchCalls: FetchCall[];
}

const openDoms: JSDOM[] = [];

afterEach(() => {
  for (const dom of openDoms) dom.window.close();
  openDoms.length = 0;
});

function okResponse(json: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(json),
  });
}

/**
 * 必须在 `win.eval(SOURCE)` **之前**替换 fetch：主世界在脚本开头就把
 * `window.fetch` 存进 `nativeFetch`，晚一步我们的回调就会拿着被 hook 的版本。
 */
function bootAt(
  url: string,
  fetchImpl: (url: string, init?: { credentials?: string }) => Promise<any> = () =>
    okResponse({ code: 0, data: { dash: { video: [], audio: [] } } }),
  stubXhr = false,
): Sandbox {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url,
    pretendToBeVisual: true,
  });
  openDoms.push(dom);
  const win = dom.window;
  const fetchCalls: FetchCall[] = [];

  (win as any).fetch = (u: string, init?: { credentials?: string }) => {
    fetchCalls.push({ url: u, init });
    return fetchImpl(u, init);
  };

  if (stubXhr) {
    // 只给"无原始回调时的兜底"那条用例用：先把原生 XHR 的 open/send 换成
    // 可控假实现，主世界随后仍会正常 hook 原型，但降级路径走的是它**之前**备份的
    // 那两份方法（见 main-world.js 的 nativeXhrOpen/nativeXhrSend）。
    const proto = (win as any).XMLHttpRequest.prototype;
    proto.open = function (method: string, url: string) {
      this.__url = url;
      this.__method = method;
    };
    proto.send = function () {
      // jsdom 的 responseText / status 是只读 getter，直接赋值在严格模式下会丢
      Object.defineProperty(this, 'responseText', {
        value: JSON.stringify({ code: 0, data: { dash: { video: [] } } }),
        configurable: true,
      });
      Object.defineProperty(this, 'status', { value: 200, configurable: true });
      if (typeof this.onload === 'function') this.onload();
    };
  }

  const sent: Array<Record<string, unknown>> = [];
  win.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as Record<string, unknown> | null;
    if (d && d.__ns === '__PLUMA__') sent.push(d);
  });

  win.eval(SOURCE);
  return { win, sent, fetchCalls, page: win as unknown as Record<string, any> };
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function ready(_sb: Sandbox): Promise<void> {
  await flush();
  await flush();
}

function sendCfg(
  sb: Sandbox,
  opts: {
    enabled?: boolean;
    rewriteGate?: boolean;
    filterCandidates?: boolean;
    pcdnRules?: { labels: string[]; domains: string[] };
    pcdnRewriteRules?: { mirrorHost: string; proxyHost: string; proxyPathPrefix: string };
  } = {},
): void {
  const enabled = opts.enabled ?? true;
  sb.win.postMessage(
    {
      __ns: '__PLUMA__',
      type: 'cfg',
      token: 'test-token',
      enabled,
      rewriteGate: opts.rewriteGate ?? enabled,
      filterCandidates: opts.filterCandidates ?? false,
      ...(opts.pcdnRules ? { pcdnRules: opts.pcdnRules } : {}),
      ...(opts.pcdnRewriteRules ? { pcdnRewriteRules: opts.pcdnRewriteRules } : {}),
    },
    '*',
  );
}

function traceOf(sb: Sandbox): Record<string, any> {
  return sb.page.__PLUMA_FESTIVAL__ as Record<string, any>;
}

/** 取唯一一次 fetch 的记录；顺带钉住"回调只发一次请求"这个结构事实。 */
function onlyFetch(sb: Sandbox): FetchCall {
  expect(sb.fetchCalls).toHaveLength(1);
  return sb.fetchCalls[0]!;
}

interface FakeNano {
  createPlayer: ((config: any) => any) & { __plumaProbed?: boolean };
}

/** 模拟页面在 document_start 之后给 `window.nano` 赋值；返回装好的 nano。 */
function installNano(sb: Sandbox, player: any): FakeNano {
  const nano: FakeNano = {
    createPlayer() {
      return player;
    },
  };
  sb.page.nano = nano;
  return nano;
}

describe('IS_FESTIVAL 判据：只在活动页装钩子', () => {
  it('活动页有独立埋点；/video 与 /bangumi/play 都没有', () => {
    const festival = bootAt(FESTIVAL_URL);
    const video = bootAt(VIDEO_URL);
    const pgc = bootAt(PGC_URL);

    expect(traceOf(festival).isFestival).toBe(true);
    expect(video.page.__PLUMA_FESTIVAL__).toBeUndefined();
    expect(pgc.page.__PLUMA_FESTIVAL__).toBeUndefined();
    // 标准页的既有链路不能被这次改动打断
    expect(video.page.__PLUMA_MAIN__).toBe(true);
    expect(pgc.page.__PLUMA_PGC__).toBeDefined();
  });

  it('活动页不依赖 SSR __playinfo__：没有它 hook 也照装', async () => {
    const sb = bootAt(FESTIVAL_URL);
    await ready(sb);
    sendCfg(sb);
    await flush();

    expect(sb.page.__playinfo__).toBeUndefined();
    const nano = installNano(sb, { updateRequestConfig() {} });
    expect(nano.createPlayer.__plumaProbed).toBe(true);
  });
});

describe('nano setter：包住 createPlayer 并新建 requestConfig', () => {
  it('门控齐了 → createPlayer 被包、config.requestConfig 被新建并挂回调', async () => {
    const sb = bootAt(FESTIVAL_URL);
    await ready(sb);
    sendCfg(sb);
    await flush();

    const config: any = {
      // 探针 Q2 的 15 键里挑几个代表：没有 prefetch / requestConfig
      aid: 1,
      cid: 42141027046,
      bvid: 'BV1ydeX65Edn',
      element: {},
      auxiliary: {},
    };
    const player = { updateRequestConfig() {} };
    const nano = installNano(sb, player);

    const ret = nano.createPlayer(config);

    expect(ret).toBe(player); // 返回值透传，不影响播放器拿实例
    expect(config.requestConfig).toBeDefined();
    expect(typeof config.requestConfig.reqHttpPlayUrlInfo).toBe('function');
    const t = traceOf(sb);
    expect(t.nanoSets).toBe(1);
    expect(t.createCalls).toBe(1);
    expect(t.hookInstalled).toBe(true);
    expect(t.lastStage).toBe('hooked');
  });

  it('改写闸关着 → 只建空 requestConfig，不挂回调、不删预取字段', async () => {
    const sb = bootAt(FESTIVAL_URL);
    await ready(sb);
    sendCfg(sb, { enabled: true, rewriteGate: false });
    await flush();

    const config: any = {
      cid: 42141027046,
      prefetch: { playUrl: 'native' },
      playUrl: 'native',
    };
    const nano = installNano(sb, { updateRequestConfig() {} });
    nano.createPlayer(config);

    expect(config.requestConfig).toEqual({});
    expect(config.requestConfig.reqHttpPlayUrlInfo).toBeUndefined();
    // 门控关时不碰页面自己的数据：这是 fail-closed 的一半
    expect(config.prefetch).toEqual({ playUrl: 'native' });
    expect(config.playUrl).toBe('native');
    expect(traceOf(sb).hookInstalled).toBe(false);
  });

  it('门控齐了才清预取字段（防站点改版引入 prefetch 短路）', async () => {
    const sb = bootAt(FESTIVAL_URL);
    await ready(sb);
    sendCfg(sb);
    await flush();

    const config: any = {
      cid: 42141027046,
      prefetch: { playUrl: 'native' },
      playUrl: 'native',
    };
    installNano(sb, { updateRequestConfig() {} }).createPlayer(config);

    expect(config.prefetch).toBeUndefined();
    expect(config.playUrl).toBeUndefined();
    expect(typeof config.requestConfig.reqHttpPlayUrlInfo).toBe('function');
  });

  it('PGC 页的 createPlayer 观测仍是纯透传（没被活动页分支污染）', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    const config = { marker: 42 };
    const nano = installNano(sb, 'fake-player');

    const ret = nano.createPlayer(config);

    expect(ret).toBe('fake-player');
    expect(config).toEqual({ marker: 42 }); // 参数一个字节都没动
    expect(sb.page.__PLUMA_PGC__.createPlayerCalls).toBe(1);
    expect((config as any).requestConfig).toBeUndefined();
  });
});

/** 装好 nano、过一遍 createPlayer，把挂上的回调交出来。 */
async function hookedCallback(
  sb: Sandbox,
  config: any,
  player: any = { updateRequestConfig() {} },
): Promise<{ cb: (params: any, config?: any) => Promise<any>; nano: FakeNano }> {
  const nano = installNano(sb, player);
  nano.createPlayer(config);
  const cb = config.requestConfig.reqHttpPlayUrlInfo as (params: any, config?: any) => Promise<any>;
  return { cb, nano };
}

describe('回调返回体：必须带 data 层（探针 Q4 的形状约束）', () => {
  it('用播放器给的含签 params 取流，返回 {data, headers, status}', async () => {
    const payload = {
      code: 0,
      data: {
        quality: 120,
        dash: { video: [{ id: 120, height: 2160, base_url: 'https://upos.example/v.m4s' }] },
      },
    };
    const sb = bootAt(FESTIVAL_URL, () => okResponse(payload));
    await ready(sb);
    sendCfg(sb);
    await flush();

    const config: any = { cid: 42141027046, bvid: 'BV1ydeX65Edn' };
    const { cb } = await hookedCallback(sb, config);
    const params = {
      avid: 1,
      bvid: 'BV1ydeX65Edn',
      cid: 42141027046,
      qn: 120,
      w_rid: 'signed',
      wts: '123456',
    };
    const out = await cb(params, config);

    expect(out).toEqual({ data: payload, headers: {}, status: 200 });
    const call = onlyFetch(sb);
    expect(call.url).toContain('/x/player/wbi/playurl?');
    expect(call.url).toContain('w_rid=signed');
    expect(call.init).toEqual({ credentials: 'include' });
    expect(traceOf(sb).cbHits).toBe(1);
    expect(traceOf(sb).lastCid).toBe('42141027046');
    expect(traceOf(sb).lastStatus).toBe(200);
  });

  it('SSR cid 滞后时只记 mismatch，不拿它覆盖播放器 params（防串场）', async () => {
    const sb = bootAt(FESTIVAL_URL, () => okResponse({ code: 0, data: { dash: { video: [] } } }));
    await ready(sb);
    sb.page.__INITIAL_STATE__ = { videoInfo: { bvid: 'BV1ydeX65Edn', cid: 111 } };
    sendCfg(sb);
    await flush();

    const config: any = { cid: 111 };
    const { cb } = await hookedCallback(sb, config);
    await cb({ cid: 999, bvid: 'BV1eoZ7BnEGy', qn: 120 }, config);

    expect(onlyFetch(sb).url).toContain('cid=999');
    expect(traceOf(sb).cidMismatch).toBe(1);
    expect(traceOf(sb).lastCid).toBe('999');
  });

  it('回调里接了 ADR 0039 的候选改写（只换 authority）', async () => {
    const payload = {
      code: 0,
      data: {
        dash: {
          video: [
            {
              id: 120,
              height: 2160,
              base_url: 'https://xy116.mcdn.example.com/edge/v.m4s',
              backup_url: [],
            },
          ],
        },
      },
    };
    const sb = bootAt(FESTIVAL_URL, () => okResponse(payload));
    await ready(sb);
    sendCfg(sb, {
      filterCandidates: true,
      pcdnRules: { labels: ['mcdn'], domains: [] },
      pcdnRewriteRules: {
        mirrorHost: 'mirror.example',
        proxyHost: 'proxy.example',
        proxyPathPrefix: '/proxy/',
      },
    });
    await flush();

    const config: any = { cid: 42141027046 };
    const { cb } = await hookedCallback(sb, config);
    const out = await cb({ cid: 42141027046, qn: 120 }, config);
    await flush(); // safePost 也是 postMessage，jsdom 里异步派发

    expect(out.data.data.dash.video).toHaveLength(1); // 不增删候选
    expect(out.data.data.dash.video[0].base_url).toContain('mirror.example');
    expect(out.data.data.dash.video[0].base_url).toContain('/edge/v.m4s');
    expect(traceOf(sb).rewritten).toBe(1);
    expect(sb.sent.some((m) => m.type === 'pcdn-filter-stats' && m.where === 'festival')).toBe(
      true,
    );
  });

  it('响应格式不对 → 交给原始回调，不让流断在没有出口的地方', async () => {
    const sb = bootAt(FESTIVAL_URL, () => okResponse({ code: -1, message: 'bad' }));
    await ready(sb);
    sendCfg(sb);
    await flush();

    const original = () => Promise.resolve('from-page-callback');
    const config: any = {
      cid: 42141027046,
      requestConfig: { reqHttpPlayUrlInfo: original },
    };
    const { cb } = await hookedCallback(sb, config);

    await expect(cb({ cid: 42141027046 }, config)).resolves.toBe('from-page-callback');
    expect(traceOf(sb).fallbacks).toBe(1);
    expect(traceOf(sb).errors).toBeGreaterThanOrEqual(1);
  });

  it('没有原始回调时 fetch 失败 → 原生 XHR 兜底，仍返回带 data 层', async () => {
    const sb = bootAt(FESTIVAL_URL, () => Promise.reject(new Error('offline')), true);
    await ready(sb);
    sendCfg(sb);
    await flush();

    const config: any = { cid: 42141027046 };
    const { cb } = await hookedCallback(sb, config);
    const out = await cb({ cid: 42141027046, qn: 120 }, config);

    expect(out).toEqual({
      data: { code: 0, data: { dash: { video: [] } } },
      headers: {},
      status: 200,
    });
    expect(traceOf(sb).fallbacks).toBe(1);
  });

  it('门控在回调时刻已关闭 → 不再发新请求，走降级', async () => {
    const sb = bootAt(FESTIVAL_URL, () => okResponse({ code: 0, data: {} }));
    await ready(sb);
    sendCfg(sb);
    await flush();

    const config: any = {
      cid: 42141027046,
      requestConfig: { reqHttpPlayUrlInfo: () => Promise.resolve('orig') },
    };
    const { cb } = await hookedCallback(sb, config);
    sendCfg(sb, { enabled: false, rewriteGate: false });
    await flush();

    await expect(cb({ cid: 42141027046 }, config)).resolves.toBe('orig');
    expect(traceOf(sb).lastStage).toBe('skip-gate-at-cb');
    // 前面那次注入时的 fetch 不算；热关闭后 cb 没有再发请求
    expect(sb.fetchCalls).toHaveLength(0);
  });
});

describe('SPA 换片：createPlayer 不再调，靠 updateRequestConfig 重挂', () => {
  it('bvid 变化 → 重挂一枚新回调，params.cid 原样透传', async () => {
    const sb = bootAt(FESTIVAL_URL, () => okResponse({ code: 0, data: { dash: { video: [] } } }));
    await ready(sb);
    sendCfg(sb);
    await flush();

    const config: any = { cid: 42141027046, bvid: 'BV1ydeX65Edn' };
    const remounts: any[] = [];
    const player = {
      updateRequestConfig(patch: any) {
        remounts.push(patch);
      },
    };
    const { cb: firstCb } = await hookedCallback(sb, config, player);

    // 活动页 SPA 只换 query，不发 popstate 也可能；这里用 popstate 走快路径
    sb.win.history.replaceState({}, '', '/festival/COLMO2026?bvid=BV1eoZ7BnEGy');
    sb.win.dispatchEvent(new sb.win.PopStateEvent('popstate'));
    await flush();

    expect(remounts).toHaveLength(1);
    const newCb = remounts[0].reqHttpPlayUrlInfo as (p: any, c?: any) => Promise<any>;
    expect(typeof newCb).toBe('function');
    expect(newCb).not.toBe(firstCb); // 新函数身份：真机靠它区分新旧回调
    // 同步写回 config 是刻意的：configStore 与 updateRequestConfig 两路都指向同一枚新回调
    expect(config.requestConfig.reqHttpPlayUrlInfo).toBe(newCb);
    await newCb({ cid: 36059286363, bvid: 'BV1eoZ7BnEGy', qn: 120 }, config);

    expect(onlyFetch(sb).url).toContain('cid=36059286363');
    expect(traceOf(sb).spaSwaps).toBe(1);
    expect(traceOf(sb).remounts).toBe(1);
    expect(traceOf(sb).lastCid).toBe('36059286363');
  });

  it('重挂抛错（原生未注入页面）被吞掉，不打断播放', async () => {
    const sb = bootAt(FESTIVAL_URL);
    await ready(sb);
    sendCfg(sb);
    await flush();

    const config: any = { cid: 42141027046 };
    const player = {
      updateRequestConfig() {
        throw new TypeError('Cannot convert undefined or null to object');
      },
    };
    await hookedCallback(sb, config, player);

    sb.win.history.replaceState({}, '', '/festival/COLMO2026?bvid=BV1eoZ7BnEGy');
    expect(() => sb.win.dispatchEvent(new sb.win.PopStateEvent('popstate'))).not.toThrow();
    expect(traceOf(sb).spaSwaps).toBe(1);
    expect(traceOf(sb).remounts).toBe(0);
    expect(traceOf(sb).lastSkip).toContain('updateRequestConfig');
  });
});
