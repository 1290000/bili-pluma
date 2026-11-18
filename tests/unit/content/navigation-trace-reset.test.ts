// @vitest-environment jsdom

/**
 * SPA 换集 / 换推荐视频后的加载观测重置（2026-11-21）。
 *
 * ## 背景（根因已由只读调查坐实，这里只守修复）
 *
 * PGC 的 reset 挂在 `pgc-playview-stream` 上，而那条消息只在换流成功时才发；
 * 大会员完整流在 8 处早退分支一条都不发 → 上一集的 hosts / 时间轴叠加到新集。
 * UGC 的 cid reset 只覆盖 `playurl-tracks`，PGC 路径不在白名单。
 * 现在改为按 **URL 身份**监听 Navigation API 的 `navigate`，不依赖业务消息。
 *
 * ## 为什么既测纯函数又"执行"源码
 *
 * `entrypoints/content.ts` 是 WXT 入口，不能在 Node 里 import。照仓库既有手法
 * （`loading-trace-cid-wiring.test.ts`），把决策函数从**真实源码**里抠出来、
 * 用 `typescript.transpileModule` 剥类型后交给 `new Function` 跑，依赖用桩注入。
 * 身份函数用真的 `playPageIdentity()`，于是"变化集合 == 应 reset 集合"被端到端钉住。
 *
 * ## mutation 检验
 *
 * 把 `handlePlayPageNavigation()` 里的身份比较改成恒相等（或让
 * `playPageIdentity()` 恒返回同一串），下面所有 shouldReset 用例立刻转红。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { transpileModule } from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attachLoadingTraceVideo,
  getLoadingSnapshot,
  installLoadingTrace,
  noteExtPatch,
  notePcdnFilter,
  resetLoadingTrace,
} from '@/src/content/isolated/loading-trace';
import { parsePlayPage, playPageIdentity } from '@shared/utils/video-page';

const CONTENT_SRC = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

interface DecisionEnv {
  reset: () => void;
  attach: () => void;
  refresh: (url: string) => void;
}

/**
 * 从 content.ts 抠出一个具名函数（到行首 `}` 为止），拼上调用语句后执行。
 * 行首 `}` 是模块级函数的闭合括号；函数内部的 `if` 都缩进了，不会误截。
 */
function runFromSource<T>(startMarker: string, call: string, stubs: Record<string, unknown>): T {
  const at = CONTENT_SRC.indexOf(startMarker);
  expect(at, `源码里找不到 ${startMarker}`).toBeGreaterThan(-1);
  const end = CONTENT_SRC.indexOf('\n}\n', at);
  expect(end, `${startMarker} 没有闭合`).toBeGreaterThan(at);
  const block = CONTENT_SRC.slice(at, end + 2);
  const js = transpileModule(`${block}\n${call}`, {
    compilerOptions: { target: 99 /* ESNext */, module: 99 /* 只剥类型 */ },
  }).outputText;
  return new Function('stubs', `with (stubs) { ${js} }`)(stubs) as T;
}

/** 跑真实的决策函数，身份函数也是真的；reset / attach / 重新报到用桩计数。 */
function decide(
  fromUrl: string,
  toUrl: string,
  env?: Partial<DecisionEnv>,
): { changed: boolean; resets: number; attaches: number; refreshes: string[] } {
  let resets = 0;
  let attaches = 0;
  const refreshes: string[] = [];
  const changed = runFromSource<boolean>(
    'function handlePlayPageNavigation(',
    'return handlePlayPageNavigation(destUrl, currentUrl);',
    {
      destUrl: toUrl,
      currentUrl: fromUrl,
      playPageIdentity,
      resetLoadingTrace:
        env?.reset ??
        (() => {
          resets += 1;
        }),
      attachLoadingTraceVideo:
        env?.attach ??
        (() => {
          attaches += 1;
        }),
      refreshProxiedFlagAfterNavigation:
        env?.refresh ??
        ((url: string) => {
          refreshes.push(url);
        }),
    },
  );
  return { changed, resets, attaches, refreshes };
}

/** 身份变化集合 = 应 reset 集合 —— 这里逐条钉死，防止有人拿整串 URL 比较 */
const NAV_CASES: Array<{
  name: string;
  from: string;
  to: string;
  shouldReset: boolean;
}> = [
  {
    name: '换稿件：video/BV1 → video/BV2',
    from: 'https://www.bilibili.com/video/BV1',
    to: 'https://www.bilibili.com/video/BV2',
    shouldReset: true,
  },
  {
    name: '换分 P：video/BV1 → video/BV1?p=2',
    from: 'https://www.bilibili.com/video/BV1',
    to: 'https://www.bilibili.com/video/BV1?p=2',
    shouldReset: true,
  },
  {
    name: 'PGC 换集：ep111 → ep222',
    from: 'https://www.bilibili.com/bangumi/play/ep111',
    to: 'https://www.bilibili.com/bangumi/play/ep222',
    shouldReset: true,
  },
  {
    name: '活动页换稿件：festival/COLMO?bvid=BV1 → bvid=BV2',
    from: 'https://www.bilibili.com/festival/COLMO?bvid=BV1',
    to: 'https://www.bilibili.com/festival/COLMO?bvid=BV2',
    shouldReset: true,
  },
  {
    name: '活动页换 key（同一 bvid）也算换页',
    from: 'https://www.bilibili.com/festival/COLMO?bvid=BV1',
    to: 'https://www.bilibili.com/festival/OTHER?bvid=BV1',
    shouldReset: true,
  },
  {
    name: '跨类型：video/BV1 → bangumi/play/ep111',
    from: 'https://www.bilibili.com/video/BV1',
    to: 'https://www.bilibili.com/bangumi/play/ep111',
    shouldReset: true,
  },
  {
    name: '同集切画质参数（qn / spm）不 reset',
    from: 'https://www.bilibili.com/video/BV1?p=1',
    to: 'https://www.bilibili.com/video/BV1?p=1&qn=116&spm_id_from=333.788',
    shouldReset: false,
  },
  {
    name: '同 URL 只改 ?t= 不 reset',
    from: 'https://www.bilibili.com/video/BV1?t=10',
    to: 'https://www.bilibili.com/video/BV1?t=30',
    shouldReset: false,
  },
  {
    name: '首次加载（当前 URL 与目标相同）不 reset',
    from: 'https://www.bilibili.com/video/BV1',
    to: 'https://www.bilibili.com/video/BV1',
    shouldReset: false,
  },
  {
    name: 'PGC 同集加追踪参数不 reset',
    from: 'https://www.bilibili.com/bangumi/play/ep111',
    to: 'https://www.bilibili.com/bangumi/play/ep111?spm_id_from=333.788',
    shouldReset: false,
  },
];

describe('playPageIdentity —— 身份串只认稿件 / 集，不认无关 query', () => {
  it.each(NAV_CASES)('$name', ({ from, to, shouldReset }) => {
    const fromId = playPageIdentity(from);
    const toId = playPageIdentity(to);

    expect(fromId).not.toBeNull();
    expect(toId).not.toBeNull();
    // 这就是"变化集合 == 应 reset 集合"：恒返回同一串时，所有 shouldReset 用例转红
    expect(toId !== fromId).toBe(shouldReset);
  });

  it('三类身份串互不撞车（跨类型导航必须判不同）', () => {
    const video = playPageIdentity('https://www.bilibili.com/video/BV1');
    const pgc = playPageIdentity('https://www.bilibili.com/bangumi/play/ep1');
    const festival = playPageIdentity('https://www.bilibili.com/festival/X?bvid=BV1');

    expect(new Set([video, pgc, festival]).size).toBe(3);
  });

  it('非播放页身份为 null（导航到首页 / 直播不该清观测）', () => {
    expect(playPageIdentity('https://www.bilibili.com/')).toBeNull();
    expect(playPageIdentity('https://live.bilibili.com/1')).toBeNull();
  });
});

describe('navigate → resetLoadingTrace 的接线', () => {
  it.each(NAV_CASES)(
    '$name：决策与 reset/attach 次数与身份变化一致',
    ({ from, to, shouldReset }) => {
      const result = decide(from, to);

      expect(result.changed).toBe(shouldReset);
      expect(result.resets).toBe(shouldReset ? 1 : 0);
      expect(result.attaches).toBe(shouldReset ? 1 : 0);
      // 换集必须重新问一次代理状态，否则新集拿不到「接管取流」
      expect(result.refreshes).toEqual(shouldReset ? [to] : []);
    },
  );

  it('目标不是播放页 → 一条都不动', () => {
    const result = decide('https://www.bilibili.com/video/BV1', 'https://www.bilibili.com/');

    expect(result).toMatchObject({ changed: false, resets: 0, attaches: 0, refreshes: [] });
  });

  it('监听器注册在 main() 里并随 ctx.signal 卸载；新增路径没有定时器', () => {
    expect(CONTENT_SRC).toMatch(/navigationApi\.addEventListener\(\s*'navigate'/);
    expect(CONTENT_SRC).toContain('{ signal: ctx.signal }');

    const at = CONTENT_SRC.indexOf('const navigationApi = (');
    expect(at, '找不到 Navigation API 监听').toBeGreaterThan(-1);
    const block = CONTENT_SRC.slice(
      at,
      CONTENT_SRC.indexOf('chrome.runtime.onMessage.addListener', at),
    );
    expect(block).not.toMatch(/setInterval|setTimeout/);
    // 不用 WXT 的 locationchange（无 Navigation API 时退化为每秒轮询）
    expect(block).not.toContain('wxt:locationchange');
  });

  it('两处 cid 兜底 reset 仍在（消息先到时仍可用，重复 reset 幂等）', () => {
    const pgcFrom = CONTENT_SRC.indexOf("if (d.type === 'pgc-playview-stream')");
    const pgcTo = CONTENT_SRC.indexOf('// playurl 响应里的音频轨道清单', pgcFrom);
    const ugcFrom = CONTENT_SRC.indexOf("if (d.type === 'playurl-tracks')");
    const ugcTo = CONTENT_SRC.indexOf('// HDR 状态', ugcFrom);

    expect(pgcFrom).toBeGreaterThan(-1);
    expect(pgcTo).toBeGreaterThan(pgcFrom);
    expect(ugcFrom).toBeGreaterThan(-1);
    expect(ugcTo).toBeGreaterThan(ugcFrom);
    expect(CONTENT_SRC.slice(pgcFrom, pgcTo)).toContain('resetLoadingTrace();');
    expect(CONTENT_SRC.slice(ugcFrom, ugcTo)).toContain('resetLoadingTrace();');
  });
});

describe('page/activate:ok 链路在换集后仍会重新写 streamingProxied', () => {
  it('换集时重新发 page/activate，并用回包的 activated 写采集器', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const proxied: boolean[] = [];

    await runFromSource<Promise<void>>(
      'async function refreshProxiedFlagAfterNavigation(',
      'return refreshProxiedFlagAfterNavigation(destUrl);',
      {
        destUrl: 'https://www.bilibili.com/festival/COLMO?bvid=BV1&p=2',
        parsePlayPage,
        readDeviceCookies: () => ({ buvid3: 'x' }),
        readPrimaryMidFromCookie: () => '123',
        document: { cookie: 'buvid3=x; DedeUserID=123' },
        sendToBackground: async (msg: unknown) => {
          sent.push(msg as Record<string, unknown>);
          return { type: 'page/activate:ok', activated: true };
        },
        setLoadingTraceProxied: (v: boolean) => {
          proxied.push(v);
        },
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'page/activate', kind: 'video', pageKey: 'BV1', p: 2 });
    expect(proxied).toEqual([true]);
  });

  it('回包不是 page/activate:ok → 不写（"没收到"不等于"没代理"）', async () => {
    const proxied: boolean[] = [];

    await runFromSource<Promise<void>>(
      'async function refreshProxiedFlagAfterNavigation(',
      'return refreshProxiedFlagAfterNavigation(destUrl);',
      {
        destUrl: 'https://www.bilibili.com/bangumi/play/ep111',
        parsePlayPage,
        readDeviceCookies: () => ({}),
        readPrimaryMidFromCookie: () => null,
        document: { cookie: '' },
        sendToBackground: async () => null,
        setLoadingTraceProxied: (v: boolean) => {
          proxied.push(v);
        },
      },
    );

    expect(proxied).toEqual([]);
  });
});

describe('换集 reset 的副作用边界', () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
    document.body.innerHTML = '';
    resetLoadingTrace();
  });

  it('events / hosts / filter 清空，DOM 与观察器不受影响', () => {
    dispose = installLoadingTrace();
    const video = document.createElement('video');
    // jsdom 的 HTMLMediaElement.error 是 undefined（浏览器里是 null）；补成浏览器形状
    Object.defineProperty(video, 'error', { value: null, configurable: true });
    document.body.appendChild(video);

    noteExtPatch(1.25);
    notePcdnFilter({ applied: true, rewritten: 3, proxied: 2, fallbackKept: 1 });
    expect(getLoadingSnapshot().events.length).toBeGreaterThan(1);
    expect(getLoadingSnapshot().filter?.rewritten).toBe(3);

    const result = decide(
      'https://www.bilibili.com/video/BV1',
      'https://www.bilibili.com/video/BV2',
      { reset: resetLoadingTrace, attach: attachLoadingTraceVideo },
    );
    expect(result.changed).toBe(true);

    const after = getLoadingSnapshot();
    expect(after.events).toEqual([]);
    expect(after.hosts).toEqual([]);
    expect(after.filter?.rewritten ?? 0).toBe(0);
    expect(document.querySelector('video')).toBe(video);

    // reset 只是换空 state，不是 dispose：采集器仍然写得进新集的事件
    expect(noteExtPatch(2.5)).toBe(true);
    expect(getLoadingSnapshot().events.some((e) => e.stage === 'ext-patch')).toBe(true);
  });
});
