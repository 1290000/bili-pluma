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

/** 建页面 + 装 fetch 替身 + eval 真源码 + 开 enabled */
async function boot(
  onPlayview: () => RespStub,
  onSwapFetch: () => Promise<unknown>,
): Promise<{ pageFetch: (u: string, o?: unknown) => Promise<Response> }> {
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

  win.fetch = (url: string) => {
    if (String(url).includes('/ogv/player/playview')) {
      return Promise.resolve(onPlayview());
    }
    return onSwapFetch();
  };

  win.eval(SOURCE);
  win.postMessage({ __ns: '__PLUMA__', type: 'cfg', token: 'test-token', enabled: true }, '*');
  await new Promise((r) => setTimeout(r, 10));

  return {
    pageFetch: (win as unknown as { fetch: (u: string, o?: unknown) => Promise<Response> }).fetch,
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
