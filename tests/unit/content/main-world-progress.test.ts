// @vitest-environment jsdom
/**
 * ADR 0017 · 观看进度还原的真实行为测试（S1.1）
 *
 * ## 为什么需要这个文件
 *
 * 2026-10-30 反例 **CE5** 实证：把 `applyProgressToJson` 的两行赋值
 * （`main-world.js:3257-3258`）注释掉，**整条 ADR 0017 观看进度还原失效**，
 * 而当时的 800 个测试**全绿**、`check-patch-scope` 仍 exit 0。
 *
 * 原因：`check-patch-scope` 只比对**常量集合**（`PROGRESS_PATCH_PATHS` 有没有被登记），
 * 不比对**行为**。于是在这个文件出现之前，"进度还原还在工作"这件事
 * **既无法证明、也无法证伪**。
 *
 * ## 这个文件守什么
 *
 * 主账号自己的观看进度，不能因为取流请求被换成播放账号的凭据
 * 而被服务端返回的 `0` 覆盖。我们的做法是把主账号进度写回 playurl 响应。
 *
 * 用真源码 `win.eval()` 驱动，测的是**页面实际看到的行为**，
 * 不是复刻一份实现（见 `main-world-logic.test.ts` 的反面教材）。
 *
 * ## 依赖的三个机制（2026-10-30 实测，见 `.workbuddy-ai/plans/2026-10-30-s13-probe-result.md`）
 *
 * 1. `enabled` 默认 false，须下发 `{__ns, type:'cfg', token:<非空字符串>, enabled:true}`
 * 2. `fetch` 替身必须装在上游 —— 脚本顶部 `var nativeFetch = window.fetch` 是那一刻取的值
 * 3. `prefetchProgress` 是异步的：必须等 promise 落定再派发 `readystatechange`
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');

const PLAYURL_URL = 'https://api.bilibili.com/x/player/playurl?avid=1&cid=999&qn=80';

/** 主账号在服务端记下的进度（`prefetchProgress` 从 wbi/v2 取这个） */
const PRIMARY_TIME = 137;
const PRIMARY_CID = 999;

interface Options {
  /** 服务端返回的 playurl 响应体 */
  served?: Record<string, unknown>;
  /** 主账号进度（wbi/v2 的 data）；传 null 表示取不到 */
  primary?: { last_play_time: number; last_play_cid: number } | null;
  /** 页面上 <video> 的 currentTime；null = 不设（默认 0） */
  currentTime?: number | null;
  /** 是否下发开 enabled 的 cfg，默认 true */
  enable?: boolean;
  /** responseType，默认 ''（文本路径） */
  responseType?: string;
  /** playurl 地址，默认 PLAYURL_URL */
  url?: string;
}

interface Result {
  /** 页面读到的 responseText（改写后） */
  text: string;
  /** 解析后的 data 段；解析失败为 null */
  data: Record<string, unknown> | null;
}

/** 建一个干净页面、执行真源码、跑一次 playurl XHR，返回页面最终读到的响应 */
async function runPlayurl(opts: Options = {}): Promise<Result> {
  const served = opts.served ?? {
    data: {
      last_play_time: 0,
      last_play_cid: 0,
      dash: { video: [] },
      accept_quality: [80],
    },
  };

  const dom = new JSDOM('<!doctype html><html><body><video></video></body></html>', {
    runScripts: 'outside-only',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown> & {
    eval: (s: string) => void;
    Event: new (t: string) => unknown;
    postMessage: (message: unknown, targetOrigin: string) => void;
    addEventListener: (type: string, listener: (ev: unknown) => void) => void;
  };

  // 机制 2：fetch 替身要在 eval 之前装好
  win.fetch = () => {
    const primary =
      opts.primary === undefined
        ? { last_play_time: PRIMARY_TIME, last_play_cid: PRIMARY_CID }
        : opts.primary;
    if (!primary) return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: primary }) });
  };

  win.eval(SOURCE);

  // 机制 1：token 必须是非空字符串，否则 tokenLocked 不锁、行为类开关被忽略
  if (opts.enable !== false) {
    win.postMessage({ __ns: '__PLUMA__', type: 'cfg', token: 'test-token', enabled: true }, '*');
    await new Promise((r) => setTimeout(r, 10));
  }

  if (opts.currentTime !== null && opts.currentTime !== undefined) {
    const video = (win as unknown as { document: Document }).document.querySelector(
      'video',
    ) as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => opts.currentTime,
    });
  }

  const XHR = (win as unknown as { XMLHttpRequest: { prototype: Record<string, unknown> } })
    .XMLHttpRequest;
  const xhr = new (XHR as unknown as new () => Record<string, unknown>)() as Record<
    string,
    unknown
  >;

  const servedText = JSON.stringify(served);
  Object.defineProperty(xhr, 'responseText', { configurable: true, get: () => servedText });
  Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => 4 });
  Object.defineProperty(xhr, 'responseType', {
    configurable: true,
    get: () => opts.responseType ?? '',
  });

  (xhr as unknown as { open: (m: string, u: string) => void }).open('GET', opts.url ?? PLAYURL_URL);

  // 机制 3：等 prefetchProgress 的 promise 落定
  await new Promise((r) => setTimeout(r, 30));
  (xhr as unknown as { dispatchEvent: (e: unknown) => boolean }).dispatchEvent(
    new win.Event('readystatechange'),
  );

  const text = String(xhr.responseText);
  let data: Record<string, unknown> | null = null;
  try {
    data = (JSON.parse(text) as { data: Record<string, unknown> }).data;
  } catch {
    data = null;
  }
  return { text, data };
}

describe('ADR 0017 观看进度还原', () => {
  describe('A1/A2 · 核心：把主账号进度写回响应', () => {
    it('A1 last_play_time 被还原成主账号的值（不是服务端的 0）', async () => {
      const { data } = await runPlayurl();
      expect(data).not.toBeNull();
      expect(data!.last_play_time).toBe(PRIMARY_TIME);
    });

    it('A2 last_play_cid 被还原成主账号的值', async () => {
      const { data } = await runPlayurl();
      expect(data).not.toBeNull();
      expect(data!.last_play_cid).toBe(PRIMARY_CID);
    });

    it('A1/A2 是两行独立的赋值：两者必须同时成立', async () => {
      // 若只改其中一行，上面两条会有一红 —— 这条是对"两行都要在"的联合断言
      const { data } = await runPlayurl();
      expect({ time: data!.last_play_time, cid: data!.last_play_cid }).toEqual({
        time: PRIMARY_TIME,
        cid: PRIMARY_CID,
      });
    });
  });

  describe('A3 · 其它字段逐字保留', () => {
    it('dash / accept_quality 不被改写函数丢弃', async () => {
      const { data } = await runPlayurl();
      expect(data!.dash).toEqual({ video: [] });
      expect(data!.accept_quality).toEqual([80]);
    });
  });

  describe('A4/A5 · 幂等与基线有效性', () => {
    it('A4 服务端值 ≠ 主账号值时必须发生改写', async () => {
      // 与 A1 的前提相同，但换一组明显不同的值，防止"两值恰好相等"掩盖问题
      const { data } = await runPlayurl({
        served: { data: { last_play_time: 1, last_play_cid: 2 } },
        primary: { last_play_time: 5000, last_play_cid: 1234 },
      });
      expect(data!.last_play_time).toBe(5000);
      expect(data!.last_play_cid).toBe(1234);
    });

    it('A5 两值已经相同时不改写（保持原样也不出错）', async () => {
      const { data } = await runPlayurl({
        served: { data: { last_play_time: PRIMARY_TIME, last_play_cid: PRIMARY_CID } },
      });
      expect(data!.last_play_time).toBe(PRIMARY_TIME);
      expect(data!.last_play_cid).toBe(PRIMARY_CID);
    });
  });

  describe('A6 · 闸门 0：没有可还原的进度时不动响应', () => {
    it('取不到主账号进度（primary=null）→ 响应保持服务端原值', async () => {
      const { data } = await runPlayurl({
        served: { data: { last_play_time: 7, last_play_cid: 7 } },
        primary: null,
      });
      expect(data!.last_play_time).toBe(7);
      expect(data!.last_play_cid).toBe(7);
    });

    it('响应里没有 data 段 → 不抛异常、原样返回', async () => {
      const { data, text } = await runPlayurl({ served: {} });
      // 没有 data 段时解析结果就是 undefined（不是 null）—— 断言"没有被塞入进度"
      expect(data).toBeUndefined();
      expect(text).toBe('{}');
    });
  });

  describe('A8 · currentTime > 3 时不改写（方向极易写反）', () => {
    it('currentTime=2 → 改写', async () => {
      const { data } = await runPlayurl({ currentTime: 2 });
      expect(data!.last_play_time).toBe(PRIMARY_TIME);
    });

    it('currentTime=3 → 改写（> 3 为假，边界在改写侧）', async () => {
      const { data } = await runPlayurl({ currentTime: 3 });
      expect(data!.last_play_time).toBe(PRIMARY_TIME);
    });

    it('currentTime=4 → 不改写（播放已开始，不能把位置拽回去）', async () => {
      const { data } = await runPlayurl({
        currentTime: 4,
        served: { data: { last_play_time: 0, last_play_cid: 0 } },
      });
      expect(data!.last_play_time).toBe(0);
      expect(data!.last_play_cid).toBe(0);
    });
  });

  describe('总开关关闭时不动响应', () => {
    it('不下发 enabled:true 的 cfg → 不改写', async () => {
      const { data } = await runPlayurl({
        enable: false,
        served: { data: { last_play_time: 0, last_play_cid: 0 } },
      });
      expect(data!.last_play_time).toBe(0);
    });
  });

  describe('非 playurl 请求不受影响', () => {
    it('其它接口的响应不被改写', async () => {
      const { text } = await runPlayurl({
        url: 'https://api.bilibili.com/x/web-interface/nav',
        served: { data: { last_play_time: 0, last_play_cid: 0 } },
      });
      expect(text).toContain('"last_play_time":0');
    });
  });
});
