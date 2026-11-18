// @vitest-environment jsdom
/**
 * PGC P2 · playview 换流的降级行为与"坏响应"兜底（S1.2）
 *
 * ## 为什么这个文件优先级最高
 *
 * PGC 有三条换流路径（SSR 注入 P1 / playview 换流 P2 / isolated 取流 P3），
 * **只有 P2 会产出坏响应**。对照：
 *   - P1 失败 → 最多画质回落，播放器仍能播
 *   - P3 失败 → 有 `shouldWritePgcCache` 拦脏数据
 *   - **P2 失败 → `main-world.js:2620-2622` 的 catch 返回
 *     `new Response('', { status: resp.status })`，即 `200 + 空 body`**
 *
 * 播放器拿到"成功的"空响应 → 解析失败 → **黑屏**。这是用户可见硬故障。
 * 而它恰恰是三条路径里单测覆盖最弱的（换流主体仅有 2 条正向用例）。
 *
 * ## 2026-10-30 实测定位（见 `.workbuddy-ai/plans/2026-10-30-phase1-record.md`）
 *
 * 外层 `.catch` 的**真正触发条件**是 `resp.text()` 本身 reject，
 * 不是换流取流失败 —— 后者已在 `pgcSwapPlayviewBody` 内部被自己 catch 掉（`:3127-3130`）返回 null。
 *
 * | 场景 | 页面拿到 |
 * | --- | --- |
 * | 正常 | `200` + 原文 |
 * | 换流取流失败 | `200` + **原文**（内部已兜住，安全） |
 * | 响应 JSON 非法 | `200` + 原文（`:2613` 兜住） |
 * | **`resp.text()` 失败** | **`200` + 空 body** ← 本条是缺陷 |
 *
 * ## 这个文件守什么
 *
 * 1. 正常路径不被误伤
 * 2. 已有的降级分支（时长太短 / 无 dash 无 durl / JSON 非法）都返回原文，**不返回空**
 * 3. **把"200+空body"这一已知缺陷钉成断言**，防止它继续蔓延到别的分支
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');

const PLAYVIEW = 'https://api.bilibili.com/ogv/player/playview?ep_id=341217';

/** 一份"截断"的 playview 响应：dash duration 120 < 600 → 会被判为需要换流 */
function truncatedBody(): string {
  return JSON.stringify({
    data: {
      arc: { cid: 123456789 },
      video_info: {
        accept_quality: [80, 116],
        dash: { duration: 120, video: [{ id: 80, height: 1080 }] },
      },
    },
  });
}

interface RespStub {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  url: string;
  redirected: boolean;
  type: string;
  text?: () => Promise<string>;
  clone?: () => unknown;
}

/**
 * 建页面 + 装 fetch 替身 + eval 真源码 + 开 enabled。
 *
 * @returns `pageFetch` 页面的 fetch；`sent` 主世界**发出去**的消息（`__ns === '__PLUMA__'`），
 *   用来断言「扩展介入」上报。
 */
async function boot(
  onPlayview: () => RespStub,
  onSwapFetch: () => Promise<unknown>,
): Promise<{
  pageFetch: (u: string, o?: unknown) => Promise<Response>;
  sent: Array<Record<string, unknown>>;
}> {
  const dom = new JSDOM('<!doctype html><html><body><video></video></body></html>', {
    runScripts: 'outside-only',
    url: 'https://www.bilibili.com/bangumi/play/ep341217',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown> & {
    eval: (s: string) => void;
    postMessage: (message: unknown, targetOrigin: string) => void;
  };

  // jsdom 不提供 Response / Headers / fetch，用 Node 全局的补上（必须在 eval 之前）
  win.Response = Response;
  win.Headers = Headers;
  win.Request = Request;

  /**
   * 捕获主世界发出去的消息。
   *
   * 必须装在 `eval` **之前**：`safePost()` 每次调用都重新取 `window.postMessage`
   * （刻意不缓存的，见那里的注释），所以这里换掉的包装器能被它用上。
   * 只收 `__ns === '__PLUMA__'` 的，把本文件自己发进去的 `cfg` 一起收进来也无妨 ——
   * 断言时按字段名筛。
   */
  const sent: Array<Record<string, unknown>> = [];
  const postToWindow = win.postMessage.bind(win);

  win.fetch = (url: string) => {
    if (String(url).includes('/ogv/player/playview')) {
      return Promise.resolve(onPlayview());
    }
    return onSwapFetch();
  };

  win.postMessage = (message: unknown, targetOrigin: string): void => {
    if (message !== null && typeof message === 'object') {
      const payload = message as Record<string, unknown>;
      if (payload.__ns === '__PLUMA__') sent.push(payload);
    }
    postToWindow(message, targetOrigin);
  };

  win.eval(SOURCE);
  win.postMessage(
    // ⚠️ `rewriteGate` 必带：playview 换流是**改写响应**，初值 false（fail-closed）会拦住它
    { __ns: '__PLUMA__', type: 'cfg', token: 'test-token', enabled: true, rewriteGate: true },
    '*',
  );
  await new Promise((r) => setTimeout(r, 10));

  return {
    pageFetch: (win as unknown as { fetch: (u: string, o?: unknown) => Promise<Response> }).fetch,
    sent,
  };
}

function realResp(body: string): RespStub {
  const r = new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });
  return r as unknown as RespStub;
}

describe('PGC P2 · playview 换流降级行为', () => {
  describe('正常路径不被误伤', () => {
    it('换流取流失败 → 页面拿到原文（内部已兜住，不是空响应）', async () => {
      const body = truncatedBody();
      const { pageFetch } = await boot(
        () => realResp(body),
        () => Promise.reject(new Error('取流失败')),
      );
      const resp = await pageFetch(PLAYVIEW, { credentials: 'include' });
      const text = await resp.text();

      expect(resp.status).toBe(200);
      expect(text).toBe(body);
      expect(() => JSON.parse(text)).not.toThrow();
    });

    it('响应不是合法 JSON → 原样返回，不破坏', async () => {
      const raw = 'not-a-json';
      const { pageFetch } = await boot(
        () => realResp(raw),
        () => Promise.reject(new Error('不该走到这里')),
      );
      const resp = await pageFetch(PLAYVIEW, { credentials: 'include' });
      expect(await resp.text()).toBe(raw);
    });
  });

  describe('降级分支：都必须返回原文，不能返回空', () => {
    it('dash 时长太短（<600s）→ 跳过换流，返回原文', async () => {
      const body = truncatedBody();
      const { pageFetch } = await boot(
        () => realResp(body),
        () =>
          Promise.resolve(
            new Response(JSON.stringify({ result: { dash: { duration: 300, video: [] } } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ),
      );
      const resp = await pageFetch(PLAYVIEW, { credentials: 'include' });
      const text = await resp.text();
      expect(text).toBe(body);
      expect(text.length).toBeGreaterThan(0);
    });

    it('取流结果为空（无 result）→ 跳过换流，返回原文', async () => {
      const body = truncatedBody();
      const { pageFetch } = await boot(
        () => realResp(body),
        () => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
      );
      const resp = await pageFetch(PLAYVIEW, { credentials: 'include' });
      const text = await resp.text();
      expect(text).toBe(body);
      expect(text.length).toBeGreaterThan(0);
    });

    it('既无 dash 也无 durl → 跳过换流，返回原文', async () => {
      const body = truncatedBody();
      const { pageFetch } = await boot(
        () => realResp(body),
        () =>
          Promise.resolve(
            new Response(JSON.stringify({ result: { dash: { video: [] } } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ),
      );
      const resp = await pageFetch(PLAYVIEW, { credentials: 'include' });
      const text = await resp.text();
      expect(text).toBe(body);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('换流成功必须上报「扩展介入」', () => {
    /**
     * ## 为什么这两条必须存在（2026-11-19 补）
     *
     * `pgcSwapPlayviewBody()` 有**两个成功 return**，各自前面有一次
     * `reportExtPatch()`：
     *
     * | 出口 | 形态 | 位置 |
     * | --- | --- | --- |
     * | dash | `vi.dash = full.dash` | `已换流 dash …` 之前 |
     * | durl 降级 | `vi.durl = full.durl` | `已换流 durl(降级) …` 之前 |
     *
     * ## 为什么原先一条都没红
     *
     * 本文件此前**根本没有 dash 换流成功的用例**（只有降级分支），而
     * 降级分支也没有断言过消息。于是删掉这两行 `reportExtPatch()`，
     * 81 个文件 1560 条测试**全绿** —— 这不是"测试已经够了"，
     * 是这一处代码根本没人守。
     *
     * 两条用例按出口一一对应，删掉任一处就会有一条红。
     */
    /** 一份"截断"的 playview：dash 120s < 600 → 会去取完整流 */
    const truncated = (): string =>
      JSON.stringify({
        data: {
          arc: { cid: 123456789 },
          video_info: {
            accept_quality: [80, 116],
            dash: { duration: 120, video: [{ id: 80, height: 1080 }] },
          },
        },
      });

    const jsonResp = (payload: unknown): Promise<unknown> =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const extPatches = (sent: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
      sent.filter((m) => m.__PLUMA_EXT_PATCH__ === true);

    it('dash 出口换流成功 → 必须发一条 __PLUMA_EXT_PATCH__', async () => {
      const { pageFetch, sent } = await boot(
        () => realResp(truncated()),
        () =>
          jsonResp({
            result: {
              dash: {
                duration: 1440,
                video: [{ id: 120, height: 2160, baseUrl: 'https://x/1.m4s', backupUrl: [] }],
              },
              accept_quality: [120, 80],
              quality: 120,
              type: 'DASH',
              format: 'hdflv2',
              timelength: 1440000,
            },
          }),
      );

      const resp = await pageFetch(PLAYVIEW, { credentials: 'include' });
      const vi = JSON.parse(await resp.text()).data.video_info as Record<string, unknown>;

      // 先确认这一趟**真的换了流**（dash 从 120s 变 1440s，durl 被删），否则下面的断言没意义
      expect((vi.dash as { duration?: number } | undefined)?.duration).toBe(1440);
      expect(vi.durl).toBeUndefined();

      const patches = extPatches(sent);
      expect(patches, 'dash 出口换流成功却没有报「扩展介入」').toHaveLength(1);
      // 时间戳与采集侧同一时基（`performance.now()`），必须是有限数
      expect(typeof patches[0]?.at).toBe('number');
      expect(Number.isFinite(patches[0]?.at as number)).toBe(true);
      expect(patches[0]?.__ns).toBe('__PLUMA__');
    });

    it('durl 降级出口换流成功 → 也必须发一条 __PLUMA_EXT_PATCH__', async () => {
      const { pageFetch, sent } = await boot(
        () => realResp(truncated()),
        () =>
          // 没有 dash，只有一段够长的 durl → 走降级出口
          jsonResp({
            result: {
              durl: [{ length: 1440000, url: 'https://x/a.mp4' }],
              quality: 64,
              type: 3,
              format: 'mp4720',
              timelength: 1440000,
            },
          }),
      );

      const resp = await pageFetch(PLAYVIEW, { credentials: 'include' });
      const vi = JSON.parse(await resp.text()).data.video_info as Record<string, unknown>;

      // 确认走的是降级形态：durl 装上、dash 被删、试看标记清掉
      expect(Array.isArray(vi.durl)).toBe(true);
      expect(vi.dash).toBeUndefined();
      expect(vi.is_preview).toBe(0);

      const patches = extPatches(sent);
      expect(patches, 'durl 降级出口换流成功却没有报「扩展介入」').toHaveLength(1);
      expect(typeof patches[0]?.at).toBe('number');
      expect(Number.isFinite(patches[0]?.at as number)).toBe(true);
    });
  });

  describe('已知缺陷：resp.text() 失败时产出 200 + 空 body', () => {
    /**
     * ⚠️ 这条**断言的是当前的实际行为**，不是期望行为。
     *
     * `main-world.js:2620-2622`：
     *   .catch(function () { return new Response('', { status: resp.status, statusText: resp.statusText }); });
     *
     * 保留 status 但 body 为空 → 播放器解析失败 → 黑屏。
     * 钉住它有两个作用：
     *   1. 任何人改动这段兜底，会立刻看到这条测试的意图
     *   2. 将来修好（改成保留原文或返回错误状态）时，这条测试会红 —— 那时再把断言改成期望值
     */
    it('resp.text() reject → status 仍 200，body 为空（缺陷固化）', async () => {
      const { pageFetch } = await boot(
        () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          url: PLAYVIEW,
          redirected: false,
          type: 'basic',
          text: () => Promise.reject(new Error('body 读不了')),
        }),
        () => Promise.reject(new Error('不该走到这里')),
      );

      const resp = await pageFetch(PLAYVIEW, { credentials: 'include' });
      const text = await resp.text();

      // 缺陷现象：成功状态 + 空 body
      expect(resp.status).toBe(200);
      expect(text).toBe('');
      // 而播放器看到的是"成功的空响应"，JSON.parse 必然失败
      expect(() => JSON.parse(text)).toThrow();
    });
  });
});
