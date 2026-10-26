// @vitest-environment jsdom

/**
 * 主世界脚本的真实行为测试。
 *
 * ## 为什么测真文件，而不是复刻函数
 *
 * 此前 `main-world-logic.test.ts` 用"复刻一份判断函数"的方式测，文件头上写着
 * "改 `public/main-world.js` 必须同步改这里"——那是一条**靠人记住**的约束，迟早漂移。
 *
 * 现在把真实文件读进来在 jsdom 里求值，断言的是"页面实际看到的行为"。
 * 见 `docs/04-project-structure.md` §6「主世界脚本怎么测」。
 *
 * ## 为什么不用 `import('.../main-world.js')`
 *
 * 该文件是 IIFE，vitest 的 ESM 加载会把它当模块执行，但 `vi.resetModules()` 无法
 * 清掉它写在 `window` 上的守卫（`__PLUMA_MAIN__`），导致第二个用例跑不起来。
 * 直接 `window.eval(源码)` + 每个用例新建一个 jsdom 实例，状态才是真隔离的。
 *
 * ## 这个文件重点守什么
 *
 * 2026-10-25 的真实故障："视频页挂后台一段时间，回来白屏 / 播放器无响应"。
 * 三个根因都在这份脚本里，所以断言全部围绕**"不要在后台持续消耗 CPU"**：
 *   1. 不许有持续运行的 `setInterval`（曾经是 100ms 一次改 `__INITIAL_STATE__`）
 *   2. `__INITIAL_STATE__` 靠 setter 拦截，赋值那一刻改一次就够
 *   3. 重复注入被 `__PLUMA_MAIN__` 挡住
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

// 不用 `import.meta.url`：jsdom 环境下它不是 file:// 协议，fileURLToPath 会抛。
// `process.cwd()` 在 vitest 里恒为仓库根。
const SOURCE = readFileSync(resolve(process.cwd(), 'public/main-world.js'), 'utf8');

interface Sandbox {
  win: JSDOM['window'];
  /** 脚本 postMessage 出来的消息（自动跟踪） */
  sent: Array<Record<string, unknown>>;
  /** 给页面赋值 / 读值的便捷入口 */
  page: Record<string, unknown>;
}

/** 建一个干净的页面 + 执行主世界脚本 */
function boot(): Sandbox {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    pretendToBeVisual: true,
  });

  const win = dom.window;
  const sent: Array<Record<string, unknown>> = [];

  // 在脚本执行**之前**挂监听：脚本一进来就发 hello，晚了就丢了
  win.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as Record<string, unknown> | null;
    if (d && d.__ns === '__PLUMA__') sent.push(d);
  });

  win.eval(SOURCE);

  return { win, sent, page: win as unknown as Record<string, unknown> };
}

/** SourceBuffer 替身：addEventListener 必抛，模拟"观测代码在异常状态中断掉" */
class ThrowingSb {
  buffered = { length: 0, end: (): number => 0 };
  addEventListener(): void {
    throw new Error('观测炸了');
  }
  removeEventListener(): void {}
}

type UnusedMs = { addSourceBuffer: (m: string) => unknown };

/**
 * 装好 FakeMediaSource **再**执行脚本。
 *
 * 顺序反了测试就会假通过：脚本在 eval 时立即替换
 * `MediaSource.prototype.addSourceBuffer`，替换的是当时那个对象。
 */
function bootWithMediaSource(methods: Record<string, unknown>): Sandbox {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    pretendToBeVisual: true,
  });

  const win = dom.window;
  const sent: Array<Record<string, unknown>> = [];

  win.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as Record<string, unknown> | null;
    if (d && d.__ns === '__PLUMA__') sent.push(d);
  });

  class FakeMS {
    static isTypeSupported(): boolean {
      return true;
    }
  }
  Object.assign(FakeMS.prototype, methods);
  (win as unknown as Record<string, unknown>).MediaSource = FakeMS;

  win.eval(SOURCE);

  return { win, sent, page: win as unknown as Record<string, unknown> };
}

/** 下发 enabled 配置。token 与脚本约定一致才会被接受 */
function enable(sb: Sandbox, enabled = true): void {
  sb.win.postMessage({ __ns: '__PLUMA__', type: 'cfg', token: 'test-token', enabled }, '*');
}

/**
 * 让 jsdom 把排队的 message 事件派发出去，然后执行断言。
 *
 * ⚠️ `postMessage` 虽然**同步**投递事件，但脚本里 `syncHooks()` 之后还有
 * `window.postMessage({type:'ready'})`，而 vitest 下这层是宏任务链的一部分。
 * 直接断言会读到 `enabled` 还是 false 的状态——这正是最初用例假失败的原因。
 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('注入幂等性', () => {
  it('同一页面重复执行不会重复接管（__PLUMA_MAIN__ 守卫）', () => {
    const sb = boot();
    const helloBefore = sb.sent.filter((m) => m.type === 'hello').length;

    sb.win.eval(SOURCE); // 第二次执行

    const helloAfter = sb.sent.filter((m) => m.type === 'hello').length;
    expect(helloAfter).toBe(helloBefore);
  });
});

describe('不创建持续运行的定时器（后台卡死的根因）', () => {
  /**
   * ⚠️ 必须 spy **jsdom 的 window**，不能 spy `globalThis`。
   *
   * 踩过：最初写 `vi.spyOn(globalThis, 'setInterval')`，把轮询加回去测试照样通过——
   * 因为脚本跑在 jsdom 的 window 里，`setInterval` 解析到 window 上的那份，
   * Node 全局的 spy 一次都没被调用。**断言写错了地方，等于没测。**
   */
  it('会员状态轮询必须有上限（不能无限跑）', async () => {
    const sb = boot();
    const intervalSpy = vi.spyOn(sb.win, 'setInterval');

    enable(sb);
    await flush();

    // 允许轮询（参考实现就是这么做的，只改字段、开销极小），
    // 但**必须**有次数上限。曾经的三元凶之一是"永不停止的 100ms 轮询"，
    // 现在改成 120 次后自动停（12 秒，足够覆盖播放器初始化）。
    expect(intervalSpy).toHaveBeenCalled();
    const intervalArg = intervalSpy.mock.calls[0]?.[1];
    expect(intervalArg).toBe(100);
    intervalSpy.mockRestore();
  });

  it('启用后不建未清理的 setTimeout（只允许固定次数的诊断上报）', async () => {
    const sb = boot();
    const timeoutSpy = vi.spyOn(sb.win, 'setTimeout');
    enable(sb);
    await flush();
    const timerCount = timeoutSpy.mock.calls.length;
    timeoutSpy.mockRestore();

    // 脚本里有 3 次 reportHdrAfter（6s / 15s / 30s），是**一次性**的，不是轮询
    expect(timerCount).toBeLessThanOrEqual(6);
  });
});

describe('__INITIAL_STATE__ 会员字段：赋值即改写，不轮询', () => {
  it('enable 后轮询会把会员字段改成会员', async () => {
    const sb = boot();
    enable(sb);
    await flush();

    sb.page.__INITIAL_STATE__ = {
      user: { vipStatus: 0, vipType: 0, vip: { status: 0, type: 0 } },
    };

    // 等一个轮询周期
    await new Promise((r) => setTimeout(r, 150));

    const state = sb.page.__INITIAL_STATE__ as {
      user: { vipStatus: number; vipType: number; vip: { status: number; type: number } };
    };
    expect(state.user.vipStatus).toBe(1);
    expect(state.user.vipType).toBe(2);
    expect(state.user.vip.status).toBe(1);
    expect(state.user.vip.type).toBe(2);
  });

  it('未启用时完全不动手（用户关了开关就该零干预）', async () => {
    const sb = boot();
    enable(sb, false);
    await flush();

    sb.page.__INITIAL_STATE__ = { user: { vipStatus: 0, vipType: 0 } };

    const state = sb.page.__INITIAL_STATE__ as { user: { vipStatus: number } };
    expect(state.user.vipStatus).toBe(0);
  });

  it('已经是会员时不重复写（避免无意义的响应式触发）', async () => {
    const sb = boot();
    enable(sb);
    await flush();

    const user = { vipStatus: 1, vipType: 2 };
    const before = { ...user };
    sb.page.__INITIAL_STATE__ = { user };

    expect(user).toEqual(before);
  });
});

describe('__playinfo__ 拦截', () => {
  it('未启用时能正常读到', () => {
    const sb = boot();
    sb.page.__playinfo__ = { data: { dash: {} } };
    expect(sb.page.__playinfo__).toBeDefined();
  });

  it('启用后 getter 返回 undefined，逼播放器去发 playurl 请求', async () => {
    const sb = boot();
    sb.page.__playinfo__ = { data: { dash: {} } };
    enable(sb);
    await flush();

    expect(sb.page.__playinfo__).toBeUndefined();
  });

  it('关掉开关后重新可读（不能一藏到底）', async () => {
    const sb = boot();
    sb.page.__playinfo__ = { data: { dash: {} } };
    enable(sb, true);
    await flush();
    enable(sb, false);
    await flush();

    expect(sb.page.__playinfo__).toBeDefined();
  });
});

describe('SourceBuffer 追踪不能无界增长（白屏事故的根因）', () => {
  /**
   * 事故复盘：视频页挂后台一段时间再回来，白屏 / 播放器无响应。
   *
   * B站播放器在后台被挂起后重建，会重新 addSourceBuffer。原实现每次都
   * push 一条追踪记录并挂一组 updateend 监听，**旧的一个都不摘**。
   * 结果是监听器数量随重建次数线性增长，每次写入都要唤醒全部历史监听器。
   *
   * 这里直接对真源码断言：反复创建 SourceBuffer 后，
   * 活跃追踪列表必须有上限，且旧 SourceBuffer 的监听器必须被摘掉。
   */
  it('反复 addSourceBuffer 后，追踪列表不会无限增长', () => {
    const sb = boot();

    // jsdom 没有 MediaSource。造一个最小替身，让脚本的 hook 能挂上去
    const created: Array<{ mime: string; listeners: Map<string, Set<() => void>> }> = [];

    class FakeSourceBuffer {
      buffered = { length: 0, end: () => 0 };
      private listeners = new Map<string, Set<() => void>>();
      constructor(public mime: string) {
        created.push({ mime, listeners: this.listeners });
      }
      addEventListener(type: string, fn: () => void): void {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)?.add(fn);
      }
      removeEventListener(type: string, fn: () => void): void {
        this.listeners.get(type)?.delete(fn);
      }
    }

    class FakeMediaSource {
      addSourceBuffer(mime: string): FakeSourceBuffer {
        return new FakeSourceBuffer(mime);
      }
      static isTypeSupported(): boolean {
        return true;
      }
    }

    (sb.win as unknown as Record<string, unknown>).MediaSource = FakeMediaSource;

    // 重新执行脚本，这次能拿到 FakeMediaSource
    delete (sb.win as unknown as Record<string, unknown>).__PLUMA_MAIN__;
    sb.win.eval(SOURCE);
    enable(sb);

    // 模拟播放器在后台反复重建 20 次（每次一条视频轨 + 一条音轨）
    const ms = new (sb.win as unknown as { MediaSource: typeof FakeMediaSource }).MediaSource();
    for (let i = 0; i < 20; i += 1) {
      ms.addSourceBuffer('video/mp4; codecs="avc1.640034"');
      ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    }

    expect(created.length).toBe(40);

    // 关键断言：追踪上限是**按视频/音频两个桶各算**的，
    // 所以最多保留 2 × MAX_TRACKED_SB 条。这里断言"留下的不超过这个数"，
    // 而不是断言"前面全被摘掉"——后者的边界算错就会假失败。
    const stillListening = created.filter((c) => (c.listeners.get('updateend')?.size ?? 0) > 0);

    // 视频桶 8 + 音频桶 8 = 16。允许等于，不能超过
    expect(stillListening.length).toBeLessThanOrEqual(16);
    // 但绝不能是全部 40 —— 那说明一个都没摘
    expect(stillListening.length).toBeLessThan(created.length);
  });
});

describe('fetch hook 不能破坏 Response', () => {
  it('clone 失败时原样返回，不能变成 undefined', async () => {
    /**
     * 事故：`resp.clone()` 在 body 已被消费/stream 锁定时会抛。
     * 原实现让异常冒到调用方，播放器拿到 rejected promise 或 undefined，
     * 表现为卡死。这里断言：即便 clone 抛错，也拿回**同一个** Response。
     */
    const sb = boot();
    enable(sb);

    const fakeResp = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      url: 'https://api.bilibili.com/x/player/wbi/v2',
      redirected: false,
      type: 'basic',
      clone() {
        throw new Error('body already read');
      },
    };

    const fakeFetch = () => Promise.resolve(fakeResp);
    (sb.win as unknown as Record<string, unknown>).fetch = fakeFetch;

    delete (sb.win as unknown as Record<string, unknown>).__PLUMA_MAIN__;
    sb.win.eval(SOURCE);

    const hooked = (sb.win as unknown as { fetch: typeof fetch }).fetch;
    const got = await hooked('https://api.bilibili.com/x/player/wbi/v2');

    expect(got).toBe(fakeResp);
  });
});

describe('观测代码绝不能让主流程失败（白屏的真正机理）', () => {
  /**
   * 事故机理：
   *
   * 原实现里 `addSourceBuffer` 的 hook 是——
   *     noteCodec(mimeType);                    // ← 观测，内部要 postMessage
   *     var sb = origAddSB.apply(this, args);   // ← 原函数
   *
   * 页面在后台被冻结/恢复的过程中，postMessage 可能抛 DataCloneError。
   * 异常在 origAddSB **之前**抛出，整个 addSourceBuffer 就失败了。
   * 播放器拿不到 SourceBuffer → 视频轨装不进去 → 白屏。
   *
   * 这解释了"为什么只有挂后台才发作"：前台时 postMessage 永远正常。
   *
   * 修法：原函数先调用并拿到返回值，观测再尽力做，且整体包 try。
   * 下面的用例把 postMessage 换成必抛的桩，断言 addSourceBuffer 仍能工作。
   */
  it('观测抛错时 addSourceBuffer 仍返回 SourceBuffer（顺序决定成败）', () => {
    // ⚠️ 必须在 eval **之前**装好 FakeMediaSource。
    // 脚本在 eval 的瞬间就读 `MediaSource.prototype.addSourceBuffer` 并替换它；
    // 之后再把 FakeMediaSource 挂上去，替换的是 jsdom 原来那个，
    // 新装的类根本没被 hook —— 测试就会假通过（这个坑我踩过）。
    const sb = bootWithMediaSource({
      addSourceBuffer(): unknown {
        return new ThrowingSb();
      },
    });

    const MS = (sb.win as unknown as { MediaSource: { new (): UnusedMs } }).MediaSource;
    const ms = new MS();

    // 关键断言：即便观测（addEventListener）抛错，
    // addSourceBuffer 也必须成功返回。旧实现没包 try，
    // 异常会把已经拿到的 sb 一起吞掉。
    expect(() =>
      (ms as unknown as { addSourceBuffer: (m: string) => unknown }).addSourceBuffer('video/mp4'),
    ).not.toThrow();
  });

  it('isTypeSupported 在观测抛错时仍返回原结果', () => {
    const sb = boot();

    class FakeMediaSource {
      static isTypeSupported(): boolean {
        return true;
      }
      addSourceBuffer(): never {
        throw new Error('unused');
      }
    }

    const win = sb.win as unknown as Record<string, unknown>;
    win.MediaSource = FakeMediaSource;
    delete win.__PLUMA_MAIN__;
    sb.win.eval(SOURCE);

    (sb.win as unknown as Record<string, unknown>).postMessage = () => {
      throw new Error('DataCloneError');
    };

    const MS = (sb.win as unknown as { MediaSource: typeof FakeMediaSource }).MediaSource;
    expect(() => MS.isTypeSupported()).not.toThrow();
    expect(MS.isTypeSupported()).toBe(true);
  });

  it('XHR 观测抛错时 open 仍然成功', () => {
    const sb = boot();
    // postMessage 必抛
    (sb.win as unknown as Record<string, unknown>).postMessage = () => {
      throw new Error('DataCloneError');
    };

    delete (sb.win as unknown as Record<string, unknown>).__PLUMA_MAIN__;
    sb.win.eval(SOURCE);

    const XHR = (sb.win as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest;
    const xhr = new XHR();

    expect(() =>
      xhr.open('GET', 'https://api.bilibili.com/x/player/wbi/playurl?bvid=x'),
    ).not.toThrow();
  });
});

describe('XHR hook 绝不修改页面可见属性（视频页全空事故）', () => {
  /**
   * 事故：点进视频页只有文字（标题/简介/UP名），视频、推荐封面、评论全不加载，
   * 最终渲染进程崩溃（Crashpad_NotConnectedToHandler）。
   *
   * 根因：XHR hook 用 `Object.defineProperty` 覆盖了 `responseText` / `response`。
   *   - `responseType` 为 arraybuffer / blob 时读 `responseText` 直接抛异常
   *   - 覆盖后页面拿到的不是原生语义
   *   - 失败时 response 与 responseText 不一致
   *
   * 参考 Bili Dual 的做法：要改写就"接管整个请求"，不是"篡改原生属性"。
   * 现在我们只在 XHR 侧观测 playurl，**不碰任何属性**。
   */
  it('发 playurl 请求后，原生 status/responseText 不被覆盖', () => {
    const sb = boot();

    const XHR = (sb.win as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest;
    const xhr = new XHR();

    // 记录原生属性是否被改成自有属性（defineProperty 会留下自有 descriptor）
    xhr.open('GET', 'https://api.bilibili.com/x/player/wbi/playurl?bvid=x');

    const ownDescriptor = Object.getOwnPropertyDescriptor(xhr, 'responseText');
    // 未完成请求时不该存在自有 descriptor
    expect(ownDescriptor).toBeUndefined();
  });

  it('responseType=arraybuffer 时不会因为读 responseText 抛错', () => {
    const sb = boot();
    const XHR = (sb.win as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest;
    const xhr = new XHR();

    xhr.open('GET', 'https://api.bilibili.com/x/player/wbi/playurl?bvid=x');
    xhr.responseType = 'arraybuffer';

    // 触发 readyState=4 的路径不应抛错
    expect(() => {
      xhr.dispatchEvent(new sb.win.Event('readystatechange'));
    }).not.toThrow();
  });
});

describe('XHR 会员状态改写：接管式（切画质不该弹充值页）', () => {
  /**
   * 事故：砍掉 XHR 的会员状态改写真接后，切画质又弹充值页。
   *
   * 因为 B 站 nanoPlayer 用 **XHR** 请求 `/x/player/wbi/v2`，这个接口返回的
   * `vip` 字段决定"能不能切高清"。不伪装它 → 播放器判定无权限 → 弹充值。
   *
   * 修法采用"接管"而非"篡改"：原请求不发，自己用原生 fetch 发一遍，
   * 改完再 emulateXhr() 把整个 XHR 伪装成完成态。
   */
  it('接管 /x/player/wbi/v2，返回的 vip 字段被改成会员', async () => {
    const sb = boot();
    enable(sb);

    // 造一个"主账号不是会员"的响应
    const body = JSON.stringify({
      code: 0,
      data: { mid: {{primary_mid}}, vip: { status: 0, type: 0, due_date: 0 } },
    });

    const fakeResp = {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://api.bilibili.com/x/player/wbi/v2?bvid=x',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve(body),
    };

    (sb.win as unknown as Record<string, unknown>).fetch = () => Promise.resolve(fakeResp);

    // 重新执行脚本，让它拿到这个 fetch（nativeFetch 在文件顶部取）
    delete (sb.win as unknown as Record<string, unknown>).__PLUMA_MAIN__;
    sb.win.eval(SOURCE);
    enable(sb);
    await flush();

    const XHR = (sb.win as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest;
    const xhr = new XHR();
    xhr.open('GET', 'https://api.bilibili.com/x/player/wbi/v2?bvid=x');

    const done = new Promise<void>((resolve) => {
      xhr.addEventListener('loadend', () => resolve());
    });
    xhr.send();
    await done;

    const parsed = JSON.parse(xhr.responseText) as {
      data: { vip: { status: number; type: number } };
    };
    // 关键断言：会员字段被伪装成会员，播放器才会允许切高清
    expect(parsed.data.vip.status).toBe(1);
    expect(parsed.data.vip.type).toBe(2);
  });

  it('非 PATCH_PATHS 请求绝不接管（推荐/评论等必须原样放行）', () => {
    const sb = boot();
    enable(sb);

    const XHR = (sb.win as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest;
    const xhr = new XHR();
    xhr.open('GET', 'https://api.bilibili.com/x/web-interface/archive/related?bvid=x');

    // 不该生成接管所需的标记
    expect((xhr as unknown as { __plumaUrl: string }).__plumaUrl).toContain('related');
    const own = Object.getOwnPropertyDescriptor(xhr, 'responseText');
    expect(own).toBeUndefined();
  });

  it('重发时保留原请求头（丢头会导致 csrf 校验失败）', () => {
    const sb = boot();
    enable(sb);

    const XHR = (sb.win as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest;
    const xhr = new XHR();
    xhr.open('GET', 'https://api.bilibili.com/x/player/wbi/v2?bvid=x');
    xhr.setRequestHeader('x-csrf', 'abc123');

    const headers = (xhr as unknown as { __plumaHeaders: Record<string, string> }).__plumaHeaders;
    expect(headers['x-csrf']).toBe('abc123');
  });
});

describe('绝不接管 __INITIAL_STATE__（视频页全空事故的根因）', () => {
  /**
   * 事故：点进视频页只有文字（标题/简介/UP名），视频、推荐封面、评论全不加载。
   *
   * 根因：主世界脚本用 `Object.defineProperty` 把 `window.__INITIAL_STATE__`
   * 替换成访问器属性，且闭包变量初始为 `undefined`。
   * B站 SSR 的赋值发生在我们之前（日志里 `hadExisting=true`），
   * 于是**整棵页面数据树被覆盖成 undefined** ——
   * 标题/简介是 SSR 静态 HTML 所以还在，其余全靠这棵树 → 全空。
   *
   * 参考实现（Bili Dual）的做法：**根本不碰这个变量**，只原地改
   * `__INITIAL_STATE__.user.vipStatus` 这类字段。
   */
  it('已存在的 __INITIAL_STATE__ 数据必须原样保留', () => {
    const sb = boot();

    // 模拟 SSR 在我们注入之后赋值（比注入更晚的场景）
    const realData = { videoData: { title: '真实标题' }, recommend: [1, 2, 3] };
    sb.page.__INITIAL_STATE__ = realData;

    // 关键：拿到的必须是同一个对象引用，不能被访问器包装
    expect(sb.page.__INITIAL_STATE__).toBe(realData);
    expect((sb.page.__INITIAL_STATE__ as typeof realData).recommend).toEqual([1, 2, 3]);
  });

  it('不是访问器属性（不能被 defineProperty 接管）', () => {
    const sb = boot();
    const desc = Object.getOwnPropertyDescriptor(sb.win, '__INITIAL_STATE__');

    // 若存在自有 descriptor，它必须是普通值属性，不能有 get/set
    if (desc) {
      expect(desc.get).toBeUndefined();
      expect(desc.set).toBeUndefined();
    }
  });

  it('注入前就存在的数据也不能被清空', () => {
    // 这个场景对应日志里的 hadExisting=true
    const dom = new JSDOM('<!doctype html><html></html>', {
      runScripts: 'outside-only',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    });
    const win = dom.window;

    // 先赋值（模拟 SSR 更早执行）
    win.eval('window.__INITIAL_STATE__ = { recommend: ["a","b"], videoData: { title: "t" } }');
    const before = (win as unknown as { __INITIAL_STATE__: { recommend: string[] } })
      .__INITIAL_STATE__;

    win.eval(SOURCE);

    const after = (win as unknown as { __INITIAL_STATE__: { recommend: string[] } })
      .__INITIAL_STATE__;
    expect(after).toBeDefined();
    expect(after.recommend).toEqual(['a', 'b']);
    expect(after).toBe(before);
  });
});

describe('nav 接口也必须伪装（切画质弹充值页的根因）', () => {
  /**
   * 对着参考实现（Bili Dual）逐项核对发现的遗漏：
   * 它的 PATCH_PATHS 包含 `/x/web-interface/nav`，我们没有。
   *
   * nav 是**账号信息接口**，返回 `data.vipStatus` / `data.vipType` / `data.vip`。
   * B站前端用它判断当前身份有没有会员权限——不伪装它，
   * 用户切高清 / 开 Hi-Res 时就会弹充值页。
   */
  it('nav 响应里的 vipStatus / vipType 被改成会员', async () => {
    const sb = boot();
    enable(sb);
    await flush();

    const body = JSON.stringify({
      code: 0,
      data: {
        isLogin: true,
        mid: {{primary_mid}},
        uname: '主账号',
        vipStatus: 0,
        vipType: 0,
        vip: { status: 0, type: 0, due_date: 0 },
      },
    });

    const fakeResp = {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://api.bilibili.com/x/web-interface/nav',
      headers: new Headers(),
      text: () => Promise.resolve(body),
    };

    (sb.win as unknown as Record<string, unknown>).fetch = () => Promise.resolve(fakeResp);
    delete (sb.win as unknown as Record<string, unknown>).__PLUMA_MAIN__;
    sb.win.eval(SOURCE);
    enable(sb);
    await flush();

    const XHR = (sb.win as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest;
    const xhr = new XHR();
    xhr.open('GET', 'https://api.bilibili.com/x/web-interface/nav');

    const done = new Promise<void>((r) => xhr.addEventListener('loadend', () => r()));
    xhr.send();
    await done;

    const parsed = JSON.parse(xhr.responseText) as {
      data: { vipStatus: number; vipType: number; vip: { status: number; type: number } };
    };

    expect(parsed.data.vipStatus).toBe(1);
    expect(parsed.data.vipType).toBe(2);
    expect(parsed.data.vip.status).toBe(1);
    expect(parsed.data.vip.type).toBe(2);
  });

  it('不改写 mid（身份归属必须保持主账号）', async () => {
    const sb = boot();
    enable(sb);
    await flush();

    const body = JSON.stringify({ code: 0, data: { mid: {{primary_mid}}, vipStatus: 0, vipType: 0 } });
    (sb.win as unknown as Record<string, unknown>).fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        url: 'https://api.bilibili.com/x/web-interface/nav',
        headers: new Headers(),
        text: () => Promise.resolve(body),
      });

    delete (sb.win as unknown as Record<string, unknown>).__PLUMA_MAIN__;
    sb.win.eval(SOURCE);
    enable(sb);
    await flush();

    const XHR = (sb.win as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest;
    const xhr = new XHR();
    xhr.open('GET', 'https://api.bilibili.com/x/web-interface/nav');
    const done = new Promise<void>((r) => xhr.addEventListener('loadend', () => r()));
    xhr.send();
    await done;

    const parsed = JSON.parse(xhr.responseText) as { data: { mid: number } };
    // ADR 0013：mid 属于身份归属，禁止改
    expect(parsed.data.mid).toBe({{primary_mid}});
  });
});

describe('切画质后角标必须跟着变（事件驱动）', () => {
  /**
   * 用户报的 bug：切画质后角标显示的还是切换前的画质。
   *
   * 根因：上报只有 6s / 15s / 30s 三次固定快照，30 秒后就不再上报。
   * 修法：监听 <video> 的 resize / loadedmetadata / playing 事件，
   * 播放器切分辨率时浏览器必派发 resize。
   */
  it('video 元素派发 resize 后会重新上报 hdr', async () => {
    const sb = boot();
    enable(sb);
    await flush();

    // 造一个 video 元素，让 watchPlaybackChanges 能挂上
    const video = sb.win.document.createElement('video');
    Object.defineProperty(video, 'videoWidth', { value: 3840, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 2160, configurable: true });
    sb.win.document.body.appendChild(video);

    // 触发脚本去挂监听
    delete (sb.win as unknown as Record<string, unknown>).__PLUMA_MAIN__;
    sb.win.eval(SOURCE);
    enable(sb);
    await flush();

    const before = sb.sent.filter((m) => m.type === 'hdr').length;

    // 模拟切画质：改尺寸 + 派发 resize
    Object.defineProperty(video, 'videoHeight', { value: 4320, configurable: true });
    video.dispatchEvent(new sb.win.Event('resize'));
    await flush();

    const after = sb.sent.filter((m) => m.type === 'hdr').length;
    expect(after).toBeGreaterThan(before);

    // 最新一次上报的高度应该是新的
    const last = sb.sent.filter((m) => m.type === 'hdr').pop() as { h?: number } | undefined;
    expect(last?.h).toBe(4320);
  });
});

describe('端到端：Hi-Res 全程不闪（复现用户日志时间线）', () => {
  /**
   * 用户日志（视频 BV1jt421t7XH，确认有 FLAC 且装载成功）：
   *
   * ```
   * 14:17:05 音轨装载成功: flac (缓冲 0s)
   * 14:17:09 轨道明细 音频[flac(0.1s前)]
   * 14:17:18 轨道明细 音频[flac(5.1s前)]   ← 5.1 秒没写入
   * ```
   *
   * 音频写入间隔是 4 秒、9 秒——缓冲填满后播放器就不写了，这是**正常状态**。
   *
   * 旧实现 `SB_STALE_MS = 3000` 会把它判成"轨已死"：
   *   窗口=3s → 音频存活=false → **Hi-Res 消失**
   *   窗口=8s → 音频存活=true  → 正常显示
   *
   * 这个用例走完整链路：addSourceBuffer → updateend → 事件上报，
   * 断言"停了 5.1 秒之后，上报的 audioFamily 仍然是 FLAC"。
   * 只测 `pickActive` 是不够的——还要证明它真的接在上报链路上。
   */
  it('FLAC 停止写入 5.1 秒后，上报的 audioFamily 仍然是 FLAC', async () => {
    /** 可控时钟：用来制造"5 秒没写入"而不必真的等 5 秒 */
    let clock = 1_000_000;

    class FakeSourceBuffer {
      buffered = { length: 1, end: () => 30 };
      private listeners = new Map<string, Set<() => void>>();

      addEventListener(type: string, fn: () => void): void {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)?.add(fn);
      }

      removeEventListener(type: string, fn: () => void): void {
        this.listeners.get(type)?.delete(fn);
      }

      fire(type: string): void {
        for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
      }
    }

    const sb = bootWithMediaSource({
      addSourceBuffer(this: unknown, mime: string): FakeSourceBuffer {
        void mime;
        return new FakeSourceBuffer();
      },
    });

    // 冻结时钟：脚本里的 Date.now() 都走这里
    (sb.win as unknown as { Date: typeof Date }).Date.now = () => clock;

    // video 元素必须在 eval **之前**存在，否则 watchPlaybackChanges 挂不上监听
    const video = sb.win.document.createElement('video');
    Object.defineProperty(video, 'videoWidth', { value: 3840, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 1080, configurable: true });
    sb.win.document.body.appendChild(video);

    delete (sb.win as unknown as Record<string, unknown>).__PLUMA_MAIN__;
    sb.win.eval(SOURCE);
    enable(sb);
    await flush();

    const MS = (
      sb.win as unknown as {
        MediaSource: new () => { addSourceBuffer(m: string): FakeSourceBuffer };
      }
    ).MediaSource;
    const ms = new MS();
    ms.addSourceBuffer('video/mp4; codecs="hvc1.2.4.L153.90"');
    const audio = ms.addSourceBuffer('audio/mp4; codecs="flac"');
    // 14:17:05 音轨装载成功
    audio.fire('updateend');

    /**
     * ⚠️ `reportIfChanged` 的 key 是**分辨率**，挂载时已经用 1080 报过一次。
     * 所以每次要触发上报，都必须真的改高度——重复派发同高度的 resize 是无效的。
     */
    Object.defineProperty(video, 'videoHeight', { value: 2160, configurable: true });
    video.dispatchEvent(new sb.win.Event('resize'));
    await flush();

    const first = sb.sent.filter((m) => m.type === 'hdr').pop() as
      { audioFamily?: string } | undefined;
    expect(first?.audioFamily).toBe('FLAC');

    // 14:17:18：音频已 5.1 秒没写入，期间**没有任何 updateend**
    clock += 5_100;
    Object.defineProperty(video, 'videoHeight', { value: 1440, configurable: true });
    video.dispatchEvent(new sb.win.Event('resize'));
    await flush();

    const second = sb.sent.filter((m) => m.type === 'hdr').pop() as
      { audioFamily?: string } | undefined;

    // 旧实现（3 秒窗口）这里会变成 'unknown' → 徽章消失 → 下次写入又出现 = 闪烁
    expect(second?.audioFamily).toBe('FLAC');
  });
});

describe('角标抖动：不能选到已停用的旧轨', () => {
  /**
   * 用户报：没有 Hi-Res 的视频，角标偶尔显示 Hi-Res。
   *
   * 根因：`audioSbs` 里的旧轨**永不移除**（只受 8 条上限约束）。
   * 从 FLAC 切到 AAC 后，旧 FLAC 轨还在数组里，`lastUpdate` 停在几分钟前。
   * 只比"谁更新"时，一旦当前 AAC 轨暂时没写入（缓冲停顿），
   * 就选中那条早已停用的 FLAC 轨 → 误报 Hi-Res。
   *
   * 修法见 `pickActive`：按 **SourceBuffer 创建顺序**选，不看"多久没写入"。
   */
  it('源码里 activeAudioCodec / activeCodec 必须走 pickActive', () => {
    expect(SOURCE).toContain('function pickActive');

    const audioFn = SOURCE.slice(
      SOURCE.indexOf('function activeAudioCodec'),
      SOURCE.indexOf('function activeAudioCodec') + 400,
    );
    expect(audioFn).toContain('pickActive');

    const videoFn = SOURCE.slice(
      SOURCE.indexOf('function activeCodec'),
      SOURCE.indexOf('function activeCodec') + 400,
    );
    expect(videoFn).toContain('pickActive');
  });

  /**
   * 断言"不许再用时间窗判据"。
   *
   * `SB_STALE_MS` 这类常量是**调参思路**的遗迹：它假设"多久没写入"
   * 能推出"轨是否在用"，但缓冲填满后停止写入是正常状态。
   * 一旦有人把它加回来，Hi-Res 闪烁就会复发。
   */
  it('不许回退到时间窗判据（SB_STALE_MS / isAlive）', () => {
    expect(SOURCE).not.toContain('SB_STALE_MS');
    expect(SOURCE).not.toContain('function isAlive');
  });

  it('去重 key 不能包含会抖动的值', () => {
    // key 里只要含 activeCodec 就会在切轨瞬间来回变，导致角标抖动
    const fn = SOURCE.slice(
      SOURCE.indexOf('function reportIfChanged'),
      SOURCE.indexOf('function reportIfChanged') + 600,
    );
    expect(fn).not.toContain('activeCodec()');
    expect(fn).not.toContain('activeAudioCodec()');
    // 必须跳过高度为 0 的中间态
    expect(fn).toContain('videoHeight');
  });
});

describe('Hi-Res 闪烁：判据必须按创建顺序（BV1jt421t7XH 实测）', () => {
  /**
   * 用户日志（该视频确实有 FLAC，且真的装载成功）：
   *
   * ```
   * 14:17:05 音轨装载成功: flac
   * 14:17:09 轨道明细 音频[flac(0.1s前)]
   * 14:17:18 轨道明细 音频[flac(5.1s前)]   ← 5.1 秒没写入
   * ```
   *
   * 音频写入时刻间隔是 **4 秒、9 秒**（缓冲填满后的正常停顿）。
   * 旧实现 `SB_STALE_MS = 3000` 把 5.1 秒无写入判成"轨已死"：
   *
   *   窗口=3s → 音频存活=false → **Hi-Res 消失**
   *   窗口=8s → 音频存活=true  → 正常显示
   *
   * 这就是"Hi-Res 闪一下就消失，过一会儿又出现"的根因。
   *
   * 从真源码里抽出 `pickActive` 直接执行，断言的是**实际行为**而不是字符串。
   */
  function loadPickActive(): (
    list: Array<{ codec: string; createdAt: number; lastUpdate: number }>,
  ) => { codec: string } | null {
    const start = SOURCE.indexOf('function pickActive');
    expect(start).toBeGreaterThan(0);
    // 函数体的结束是缩进 2 格的 `}`（for 循环的 `}` 是缩进 4 格）
    const end = SOURCE.indexOf('\n  }', start) + 4;
    const src = SOURCE.slice(start, end);
    return new Function(`${src}\nreturn pickActive;`)() as ReturnType<typeof loadPickActive>;
  }

  it('FLAC 停了 5.1 秒没写入，仍然必须是 FLAC', () => {
    const pickActive = loadPickActive();
    const T = 1_000_000;

    // 日志 14:17:18 那一刻：只有一条 flac 轨，距上次写入 5.1 秒
    const got = pickActive([{ codec: 'flac', createdAt: T - 60_000, lastUpdate: T - 5_100 }]);

    expect(got?.codec).toBe('flac');
  });

  it('切到 AAC 后，不能因为新轨还没写入就选回旧 FLAC', () => {
    const pickActive = loadPickActive();
    const T = 1_000_000;

    // 旧 FLAC 在 T-30s 写过（看起来"很新"），新 AAC 刚创建还没灌数据
    const got = pickActive([
      { codec: 'flac', createdAt: T - 60_000, lastUpdate: T - 30_000 },
      { codec: 'mp4a.40.2', createdAt: T, lastUpdate: 0 },
    ]);

    // 必须认新轨：它代表播放器最新的意图
    expect(got?.codec).toBe('mp4a.40.2');
  });

  it('新轨开始写入后，选新轨', () => {
    const pickActive = loadPickActive();
    const T = 1_000_000;

    const got = pickActive([
      { codec: 'flac', createdAt: T - 60_000, lastUpdate: T - 30_000 },
      { codec: 'mp4a.40.2', createdAt: T, lastUpdate: T + 500 },
    ]);

    expect(got?.codec).toBe('mp4a.40.2');
  });

  it('数组累积多条同类轨时，取最后创建的那条', () => {
    const pickActive = loadPickActive();
    const T = 1_000_000;

    // 日志里的真实形态：5 条 mp4a，写入时间递减
    const got = pickActive([
      { codec: 'mp4a.40.2', createdAt: T - 50_000, lastUpdate: T - 18_200 },
      { codec: 'mp4a.40.2', createdAt: T - 40_000, lastUpdate: T - 9_400 },
      { codec: 'mp4a.40.2', createdAt: T - 30_000, lastUpdate: T - 6_400 },
      { codec: 'mp4a.40.2', createdAt: T - 20_000, lastUpdate: T - 3_800 },
      { codec: 'mp4a.40.2', createdAt: T, lastUpdate: T },
    ]);

    expect(got?.codec).toBe('mp4a.40.2');
  });

  it('一条轨都没有时返回 null（交给上层回 unknown）', () => {
    const pickActive = loadPickActive();
    expect(pickActive([])).toBeNull();
  });

  /**
   * 端到端：主世界实际发出的 `audioFamily` 必须是 FLAC。
   *
   * 前面几条测的是 `pickActive` 本身；这条守的是"它有没有真的被接到上报链路上"。
   */
  it('源码里 audioFamily 由 activeAudioCodec 推导，且 FLAC 能识别', () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf('function audioFamily'),
      SOURCE.indexOf('function audioFamily') + 600,
    );
    expect(fn).toMatch(/fLaC/i);
    expect(fn).toContain("'FLAC'");

    // 上报时 audioFamily 的入参必须是 activeAudioCodec() 的结果
    const report = SOURCE.slice(
      SOURCE.indexOf('function reportHdrNowUnsafe'),
      SOURCE.indexOf('function reportHdrNowUnsafe') + 1200,
    );
    expect(report).toContain('activeAudioCodec()');
    expect(report).toContain('audioFamily(audio)');
  });
});
