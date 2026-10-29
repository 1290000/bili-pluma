// @vitest-environment jsdom

/**
 * PGC 主世界分支 —— **ADR 0020 路线**（缓存注入），取代 ADR 0019 的 hook 回调。
 *
 * ## 为什么整组重写
 *
 * 2026-10-28 真机实测把旧路线否掉了：用页面自己的容器 + 完整集数据建播放器，
 * `reqHttpPlayUrlInfo` **一次都没被调用**（`cbCalled: 0`），`duration` 仍是 360；
 * Proxy 也证明播放器只 `get prefetch` / `get requestConfig`，**从不读 `.playUrl`**。
 *
 * 现在的路线：**同步**把缓存里的完整流塞进 `__playinfo__.result.video_info`，
 * 发生在 `__playinfo__` 的 setter 里（`createPlayer` 就在它之后 0~2ms）。
 *
 * 这组测试守四件事：
 *   1. PGC 页**不藏** `__playinfo__`（藏了就是黑屏）—— 与 `/video` 页正好相反
 *   2. 注入必须是**同步**的、且在 setter 里（晚一步播放器就读到旧数据）
 *   3. 只换流字段，**不改** `is_preview` / `play_check` / `play_video_type`
 *   4. 没有缓存 / `pgcActive=false` / 缓存无流 时**一个字都不动**
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');

const PGC_URL = 'https://www.bilibili.com/bangumi/play/ss34412';
const VIDEO_URL = 'https://www.bilibili.com/video/BV1xx411c7mD';

interface Sandbox {
  win: JSDOM['window'];
  sent: Array<Record<string, unknown>>;
  page: Record<string, unknown>;
}

function bootAt(url: string): Sandbox {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url,
    pretendToBeVisual: true,
  });

  const win = dom.window;
  const sent: Array<Record<string, unknown>> = [];

  win.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as Record<string, unknown> | null;
    if (d && d.__ns === '__PLUMA__') sent.push(d);
  });

  win.eval(SOURCE);
  return { win, sent, page: win as unknown as Record<string, unknown> };
}

/** 下发配置。`pgcVideoInfo` 是 ISOLATED 侧预读出来的完整流 */
function sendCfg(
  sb: Sandbox,
  opts: { enabled?: boolean; pgcActive?: boolean; pgcVideoInfo?: unknown } = {},
): void {
  sb.win.postMessage(
    {
      __ns: '__PLUMA__',
      type: 'cfg',
      token: 'test-token',
      enabled: opts.enabled ?? true,
      ...(opts.pgcActive !== undefined ? { pgcActive: opts.pgcActive } : {}),
      ...(opts.pgcVideoInfo !== undefined ? { pgcVideoInfo: opts.pgcVideoInfo } : {}),
    },
    '*',
  );
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * 等 `hello` / `ssr-playinfo` 派发完再发 `cfg`。
 *
 * ⚠️ jsdom 的 `postMessage` 是**异步排队**的，而且消息头里带了
 * `[TypeError: Cannot read properties of null]` 这类失败样例 —— 实测：
 * 在同一轮宏任务里先 `eval` 再 `postMessage`，`cfg` 会跟 `hello` 抢优先级，
 * 结果 `cfg` 被吞掉、主世界永远收不到缓存。
 *
 * 真实环境里不存在这个问题（ISOLATED 侧本来就是在收到 `ssr-playinfo` 之后才发 `cfg`），
 * 所以这里是**测试夹具的时序**问题，不是产品 bug。但夹具写错会让人误判产品坏了。
 */
async function ready(sb: Sandbox): Promise<void> {
  await flush();
  await flush();
  void sb;
}

/** 主账号只能试看的 SSR 数据（形状取自 2026-10-27 真机实测） */
function ssrPreview() {
  return {
    code: 0,
    result: {
      play_video_type: 'preview',
      play_check: { play_detail: 'PLAY_PREVIEW' },
      arc: { cid: 281989571, title: '主账号看到的标题' },
      watch_progress: { current_progress: 42000 },
      user_status: { is_login: true, has_paid: false },
      video_info: {
        is_preview: true,
        type: 3,
        format: 'mp4',
        quality: 80,
        timelength: 1440083,
        durls: [
          { quality: 80, durl: [{ length: 360082, url: 'https://ssr.example/preview.m4s' }] },
        ],
      },
    },
  };
}

/** 缓存里的完整流（`video_info` 形态） */
function cachedFullVideoInfo() {
  return {
    quality: 120,
    timelength: 1440083,
    format: 'flv720',
    dash: {
      duration: 1441,
      video: [{ id: 80, height: 1080, codecid: 12, base_url: 'https://api.example/v.m4s' }],
      audio: [{ id: 30232, base_url: 'https://api.example/a.m4s' }],
    },
    durls: [{ quality: 120, durl: [{ length: 1440000, url: 'https://api.example/full.m4s' }] }],
    accept_quality: [120, 112, 80],
  };
}

/** 读出当前 `__playinfo__` 的 `video_info` */
function vi(sb: Sandbox): Record<string, unknown> {
  return (sb.page.__playinfo__ as { result: { video_info: Record<string, unknown> } }).result
    .video_info;
}

describe('`__playinfo__` 的处理方向必须相反', () => {
  it('PGC 页启用后仍然可读（藏了就等于把流藏了 → 黑屏）', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sb.page.__playinfo__ = ssrPreview();
    sendCfg(sb);
    await flush();

    expect(sb.page.__playinfo__).toBeDefined();
  });

  it('对照：同一配置下 /video 页必须被藏起来', async () => {
    const sb = bootAt(VIDEO_URL);
    await ready(sb);
    sb.page.__playinfo__ = { code: 0, result: {} };
    sendCfg(sb);
    await flush();

    expect(sb.page.__playinfo__).toBeUndefined();
  });
});

describe('注入缓存：必须是同步的，且发生在 setter 里', () => {
  it('cfg 先到 → SSR 赋值那一刻就被替换（读到的是完整流）', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();

    // 模拟 SSR 内联脚本赋值 —— 关键：赋值后**立刻**读，中间不能 await
    sb.page.__playinfo__ = ssrPreview();
    const got = vi(sb);

    expect(got.dash).toBeDefined();
    expect(got.timelength).toBe(1440083);
    expect(got.quality).toBe(120);
  });

  it('SSR 先到、cfg 后到 → 收到 cfg 时补一次注入', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sendCfg(sb);
    await flush();

    sb.page.__playinfo__ = ssrPreview();
    expect(vi(sb).dash).toBeUndefined(); // 没有缓存时不动

    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();

    expect(vi(sb).dash).toBeDefined();
    expect(vi(sb).quality).toBe(120);
  });

  it('只注入一次（重复 cfg 不会反复替换）', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();
    sb.page.__playinfo__ = ssrPreview();

    const first = vi(sb);

    sendCfg(sb, { pgcVideoInfo: { quality: 999, dash: { video: [{ height: 4320 }] } } });
    await flush();

    expect(vi(sb)).toBe(first); // 同一个对象，没被第二次覆盖
    expect(vi(sb).quality).toBe(120);
  });
});

describe('有 dash 时必须抹掉 durl（否则播放器走 360 秒的试看 durl）', () => {
  it('注入后 video_info 里没有 durl / durls', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();
    sb.page.__playinfo__ = ssrPreview();

    /**
     * 2026-10-28 真机定位（最关键的一条）：
     * 注入后 `dash.duration = 1441` 是对的，但 `<video>.duration` 仍是 360、
     * `currentSrc` 指向 **durl** 的地址、`currentTime=600` 被夹回 360。
     *
     * → 播放器在 `durl` 存在时优先走 durl。"6 分 01 秒被拦"不是字段拦截，
     *   是**流真的只有 360 秒**（SSR 那条试看 durl）。
     */
    expect(vi(sb).dash).toBeDefined();
    expect(vi(sb)).not.toHaveProperty('durl');
    expect(vi(sb)).not.toHaveProperty('durls');
  });
});

describe('试看标记必须改写（ADR 0021）', () => {
  function patched() {
    const sb = bootAt(PGC_URL);
    return sb;
  }

  it('三个试看标记被改成"完整"', async () => {
    const sb = patched();
    await ready(sb);
    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();
    sb.page.__playinfo__ = ssrPreview();

    const r = (sb.page.__playinfo__ as { result: Record<string, unknown> }).result;

    /**
     * 为什么必须改这三处 —— 两个方向相反的实测：
     *   只改字段不换流 → `duration` 仍 360（字段不影响"流多长"）
     *   只换流不改字段 → **播到 361 秒被拦并弹窗**（字段决定"播到哪儿停"）
     * 361 = SSR 的 durls 长度（4 × 360082ms），是播放器按 `PLAY_PREVIEW` 主动暂停。
     */
    expect(r.play_video_type).toBe('whole');
    expect((r.play_check as { play_detail: string }).play_detail).toBe('PLAY_WHOLE');
    expect(vi(sb).is_preview).toBe(false);
  });

  it('user_status / supplement 一律不动（那是服务端对账号权益的陈述）', async () => {
    const sb = patched();
    await ready(sb);
    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();
    sb.page.__playinfo__ = ssrPreview();

    const r = (sb.page.__playinfo__ as { result: Record<string, unknown> }).result;
    const us = r.user_status as { has_paid: boolean; is_login: boolean };

    // 改 `has_paid` 等于声称"这个号买过了" —— 纯粹的谎报，ADR 0021 明确不做
    expect(us.has_paid).toBe(false);
    expect(us.is_login).toBe(true);
  });

  it('arc / watch_progress 不被破坏', async () => {
    const sb = patched();
    await ready(sb);
    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();
    sb.page.__playinfo__ = ssrPreview();

    const r = (sb.page.__playinfo__ as { result: Record<string, unknown> }).result;
    expect((r.arc as { cid: number }).cid).toBe(281989571);
    expect((r.watch_progress as { current_progress: number }).current_progress).toBe(42000);
  });

  it('缓存里的 is_preview:false 不被采纳 —— 只认常量里的改写值', async () => {
    /**
     * 缓存里可能带 `is_preview: false`（存的时候是合并后的）。
     * 但改写值必须**来自 `PGC_PREVIEW_FLAGS` 常量**，不能跟着缓存走 ——
     * 否则改 ADR / 改常量都不管用，而 `check-patch-scope` 也查不出实际改了什么。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sendCfg(sb, { pgcVideoInfo: { ...cachedFullVideoInfo(), is_preview: true, evil: 'x' } });
    await flush();
    sb.page.__playinfo__ = ssrPreview();

    expect(vi(sb).is_preview).toBe(false); // 常量说的算
    expect(vi(sb)).not.toHaveProperty('evil');
  });
});

describe('不该注入的时候一个字都不动', () => {
  it('没有缓存 → 保持 SSR 原样', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sendCfg(sb);
    await flush();
    sb.page.__playinfo__ = ssrPreview();

    expect(vi(sb).dash).toBeUndefined();
    expect(vi(sb).quality).toBe(80);
  });

  it('pgcActive=false（没装规则）→ 不注入', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sendCfg(sb, { pgcActive: false });
    await flush();
    sendCfg(sb, { pgcActive: false, pgcVideoInfo: cachedFullVideoInfo() });
    await flush();
    sb.page.__playinfo__ = ssrPreview();

    expect(vi(sb).dash).toBeUndefined();
  });

  it('缓存里没有可用流字段 → 放弃注入（宁可播试看，不要黑屏）', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sendCfg(sb, { pgcVideoInfo: { quality: 120, timelength: 1440083 } });
    await flush();
    sb.page.__playinfo__ = ssrPreview();

    /**
     * ⚠️ 断言的是**流字段没被注入**，不是 `quality` 没变。
     *
     * 第一版写的是 `expect(quality).toBe(80)` —— 那是错的：
     * `quality` / `timelength` 属于"元信息"，注入与否都可能被搬过去；
     * 真正决定"能不能播"的是 `durls` / `dash`。
     * 而 SSR 本身就带 `durls`（试看的），所以判据只能是
     * **有没有出现 `dash`**（SSR 的 durl 流水线不会凭空长出 dash）。
     */
    expect(vi(sb).dash).toBeUndefined();
    // SSR 自己的试看 durl 必须原样保留（没被"没有流的缓存"清空）
    expect((vi(sb).durls as unknown[]).length).toBe(1);
  });
});

describe('同步读 sessionStorage（ADR 0020 的最终修法）', () => {
  /** 与 `main-world.js` 的 `PGC_SS_PREFIX` 必须一致 */
  const SS_KEY = 'pluma:pgc-vi:';

  it('cfg 完全不到场时，只要有 sessionStorage 就在 setter 里注入', async () => {
    /**
     * 这是真机验证出来的硬约束：
     *   `patchedAt: 2032` vs `createPlayer: 409ms` —— 走 postMessage 晚了 1.6 秒。
     *
     * 所以缓存必须在 `__playinfo__` 的 setter 里**同步读**，
     * 不能等任何异步通道。这条测试故意**不发 cfg**，只放 sessionStorage。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);

    // 只放同步缓存，不走 postMessage
    sb.win.sessionStorage.setItem(
      SS_KEY + '281989571',
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );

    sb.page.__playinfo__ = ssrPreview();

    expect(vi(sb).dash).toBeDefined();
    expect(vi(sb).quality).toBe(120);
  });

  it('缓存的 cid 与页面 cid 不匹配时不注入（避免串集）', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    // 存了一个**别的** cid 的缓存
    sb.win.sessionStorage.setItem(
      SS_KEY + '999999',
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );

    sb.page.__playinfo__ = ssrPreview();

    expect(vi(sb).dash).toBeUndefined();
    expect(vi(sb).quality).toBe(80);
  });

  it('过期缓存不注入', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sb.win.sessionStorage.setItem(
      SS_KEY + '281989571',
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() - 1000 }),
    );

    sb.page.__playinfo__ = ssrPreview();

    expect(vi(sb).dash).toBeUndefined();
  });

  it('sessionStorage 里是坏 JSON 时不崩、也不注入', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sb.win.sessionStorage.setItem(SS_KEY + '281989571', '{broken');

    expect(() => {
      sb.page.__playinfo__ = ssrPreview();
    }).not.toThrow();
    expect(vi(sb).dash).toBeUndefined();
  });
});

describe('隐藏「试看中」提示条（ADR 0022）', () => {
  /** 造一条 toast-item。`withPrompt` = 是不是"试看提示" */
  function makeItem(doc: Document, text: string, withPrompt: boolean) {
    const item = doc.createElement('div');
    item.className = 'bpx-player-toast-item';
    const inner = doc.createElement('span');
    inner.className = 'bpx-player-toast-text';
    if (withPrompt) {
      const bar = doc.createElement('div');
      bar.className = 'PromptBar_container__HASH';
      bar.textContent = text;
      inner.appendChild(bar);
    } else {
      inner.textContent = text;
    }
    item.appendChild(inner);
    return item;
  }

  /** 挂一条试看提示 + 三种**不能被误伤**的提示（用户明确点名） */
  function seedToasts(doc: Document) {
    const items = {
      preview: makeItem(doc, '本片是大会员专享内容 试看中', true),
      skip: makeItem(doc, '跳过片头', false),
      resume: makeItem(doc, '上次看到 12:34，是否继续播放', false),
      fromStart: makeItem(doc, '从头开始播放', false),
    };
    for (const el of Object.values(items)) doc.body.appendChild(el);
    return items;
  }

  it('只藏试看提示，跳过片头/续播/从头播放全部保留', async () => {
    /**
     * 用户明确点名三类消息不能被误伤：
     *   1. 跳过片头/片尾（位置因集而异，有些集根本没有）
     *   2. 续播提示
     *   3. 从头开始播放
     *
     * 它们的 item 里**没有** `PromptBar` 标记，所以筛选条件能天然避开。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);
    const t = seedToasts(sb.win.document);

    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();
    sb.page.__playinfo__ = ssrPreview();
    await flush();

    expect(t.preview.style.display).toBe('none'); // ← 该藏
    expect(t.skip.style.display).not.toBe('none'); // ← 不能碰
    expect(t.resume.style.display).not.toBe('none'); // ← 不能碰
    expect(t.fromStart.style.display).not.toBe('none'); // ← 不能碰
  });

  it('黑底所在层（.bpx-player-toast-item）被藏，不是只藏文字层', async () => {
    /**
     * 前两版都藏错了层：藏 `.bpx-player-toast-text` 时黑底还在
     * —— 因为 `rgba(25,25,25,0.88)` 这个背景在更外一层的 `.toast-item` 上。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);
    const t = seedToasts(sb.win.document);

    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();
    sb.page.__playinfo__ = ssrPreview();
    await flush();

    expect(t.preview.className).toContain('bpx-player-toast-item');
    expect(t.preview.style.display).toBe('none');
  });

  it('没有注入（无缓存）时**不许**隐藏 —— 否则用户看不到"这是试看"', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);
    const t = seedToasts(sb.win.document);

    sendCfg(sb); // 不给缓存
    await flush();
    sb.page.__playinfo__ = ssrPreview();
    await flush();

    expect(t.preview.style.display).not.toBe('none');
  });

  it('普通视频页不受影响（ADR 0022 边界 1）', async () => {
    const sb = bootAt(VIDEO_URL);
    await ready(sb);
    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();
    sb.page.__playinfo__ = { code: 0, result: {} };
    await flush();

    const doc = sb.win.document;
    expect(doc.querySelectorAll('.bpx-player-toast-item[style*="display: none"]')).toHaveLength(0);
  });
});

describe('SPA 切集：cid 变了要重新注入（2026-10-28 真机踩到）', () => {
  const EP6 = 253153139;
  const EP7 = 255418984;

  /**
   * 造一份指定 cid 的 SSR。
   *
   * ⚠️ `video_info.cid` 也要一起改 —— `pgcCidOf` 先读 `arc.cid`，
   * 但两个字段不一致会让测试掩盖真实问题。
   */
  function ssrFor(cid: number) {
    const s = ssrPreview();
    (s.result.arc as { cid: number }).cid = cid;
    (s.result.video_info as { cid?: number }).cid = cid;
    return s;
  }

  it('cid 变化后重新读缓存、重新注入', async () => {
    /**
     * 实测：在播放器里点选集页面**不重载**（SPA 内跳），
     * `pgcPatched = true` 让注入只发生一次 —— 第 8 集的数据进来时再也不注入，
     * 播放器用 360 秒的流播新集，6 分 01 秒撞墙。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);

    // 两集各有一份同步缓存
    sb.win.sessionStorage.setItem(
      'pluma:pgc-vi:' + EP6,
      JSON.stringify({ vi: { ...cachedFullVideoInfo(), quality: 120 }, exp: Date.now() + 60_000 }),
    );
    sb.win.sessionStorage.setItem(
      'pluma:pgc-vi:' + EP7,
      JSON.stringify({ vi: { ...cachedFullVideoInfo(), quality: 116 }, exp: Date.now() + 60_000 }),
    );

    // 第 6 集
    sb.page.__playinfo__ = ssrFor(EP6);
    expect(vi(sb).dash).toBeDefined();
    expect(vi(sb).quality).toBe(120);

    // 切到第 7 集（同一个 window，模拟 SPA 切集）
    sb.page.__playinfo__ = ssrFor(EP7);

    // 必须换成第 7 集那份缓存，而不是停留在"已补过"的状态
    expect(vi(sb).dash).toBeDefined();
    expect(vi(sb).quality).toBe(116);
  });

  it('cid 没变时不重复注入（保持幂等）', async () => {
    /**
     * ⚠️ 判据是"**第二次没有被处理**"，不是"对象相同"。
     *
     * 第一版断言 `second === first` 是错的：两次赋值传的是**新建的 `ssrPreview()`**，
     * `video_info` 引用必然不同。真正要守的是：同一个 cid 下，
     * `pgcPatched` 已置位，所以第二次的 `video_info` **保持 SSR 原样**（不注入）。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);
    sb.win.sessionStorage.setItem(
      'pluma:pgc-vi:' + EP6,
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );

    sb.page.__playinfo__ = ssrFor(EP6);
    expect(vi(sb).dash).toBeDefined(); // 第一次注入了

    // 同 cid 再赋一次（页面自己重写 __playinfo__）—— 不该再处理
    sb.page.__playinfo__ = ssrFor(EP6);
    expect(vi(sb).dash).toBeUndefined(); // 保持 SSR 原样
    expect(vi(sb).quality).toBe(80);
  });
});

/**
 * SPA 切集 + 限免集：**画质升级也必须换流**（2026-10-29 真机）。
 *
 * ## 用户报的现象
 *
 * > 「先进入一个番剧或者国创的播放界面，再通过右侧跳转到其他集数，
 * >  这时候再切换画质就会失败」
 *
 * 现场：切集后画面 1080P，点 4K 弹「切换失败」，菜单停在「1080P 高清」。
 *
 * ## 根因
 *
 * `pgcSwapPlayviewBody()` 的第一道闸是：
 * ```js
 * if (!pgcPlayviewIsTruncated(vi)) return null;   // 流够长 → 不换
 * ```
 * 限免集本来就是完整流 → 判"不截断" → **直接 return，4K 永远拿不到**。
 * 而它手里的 `playview` 原始 dash 只有 `80@1080 64@720 32@480 16@360`。
 *
 * ## 修法
 *
 * 「需要换」= **流被截断 或 画质还能提升**。两条独立判据：
 * - 只看画质 → 会员老番（720P、给 361 秒）会掉回试看
 * - 只看时长 → 限免集拿不到 4K（就是这个 bug）
 */
/**
 * jsdom 没有全局 `Response`，而主世界换完流要用 `new Response(...)` 重建响应。
 * 补一个最小实现（够主世界用：`status` / `statusText` / `text()` / `json()`）。
 */
function installResponse(win: JSDOM['window']): void {
  if (typeof (win as unknown as Record<string, unknown>).Response === 'function') return;
  class MiniResponse {
    status: number;
    statusText: string;
    private _body: string;
    constructor(body: string, init?: { status?: number; statusText?: string }) {
      this._body = body;
      this.status = init?.status ?? 200;
      this.statusText = init?.statusText ?? 'OK';
    }
    text(): Promise<string> {
      return Promise.resolve(this._body);
    }
    json(): Promise<unknown> {
      return Promise.resolve(JSON.parse(this._body));
    }
  }
  (win as unknown as Record<string, unknown>).Response = MiniResponse;
}

/**
 * SPA 切集 + 限免集：**流完整但画质不够时也要换**（2026-10-29 真机）。
 *
 * 用户报：「先进入一个番剧或国创的播放界面，再通过右侧跳转到其他集数，
 * 这时候再切换画质就会失败」。现场：画面 1080P、弹切换失败、菜单停在 1080P 高清。
 *
 * 根因在 `pgcSwapPlayviewBody()` 的第一道闸：
 * ```js
 * if (!pgcPlayviewIsTruncated(vi)) return null;   // 流够长 → 不换
 * ```
 * 限免集本来就是完整流 → 判「不截断」→ **直接 return，4K 永远拿不到**。
 *
 * 修法：「需要换」= **流被截断 或 画质还能提升**。两条独立判据：
 * 只看画质会让会员老番掉回试看；只看时长就是现在这个 bug。
 */
describe('SPA 切集：流完整但画质不够时也要换（2026-10-29）', () => {
  /** playview 的原始响应：完整流，但 dash 只有 1080 */
  function playviewBody(cid: number) {
    return {
      code: 0,
      data: {
        arc: { cid },
        video_info: {
          quality: 80,
          timelength: 1_000_000,
          accept_quality: [125, 120, 112, 80, 64, 32, 16],
          dash: {
            duration: 1000,
            video: [
              { id: 80, height: 1080, base_url: 'a', backup_url: [], bandwidth: 1 },
              { id: 64, height: 720, base_url: 'b', backup_url: [], bandwidth: 1 },
            ],
            audio: [],
          },
        },
      },
    };
  }

  /** 取流接口的响应：完整流 + 4K */
  function fullResult() {
    return {
      quality: 120,
      timelength: 1_000_000,
      format: 'hdflv2',
      type: 'DASH',
      accept_quality: [125, 120, 112, 80, 64, 32, 16],
      dash: {
        duration: 1000,
        video: [
          { id: 125, height: 2160, base_url: 'x', backup_url: [], bandwidth: 1 },
          { id: 120, height: 2160, base_url: 'y', backup_url: [], bandwidth: 1 },
          { id: 80, height: 1080, base_url: 'a', backup_url: [], bandwidth: 1 },
        ],
        audio: [],
      },
    };
  }

  /** 只给 1080，与 playview 原样一样 */
  function sameResult() {
    return {
      ...fullResult(),
      quality: 80,
      dash: {
        duration: 1000,
        video: [{ id: 80, height: 1080, base_url: 'a', backup_url: [], bandwidth: 1 }],
        audio: [],
      },
    };
  }

  /** 建页面并装好按 URL 分流的 fetch（必须在 eval 之前） */
  function boot(playurlResult: () => unknown) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'outside-only',
      url: PGC_URL,
      pretendToBeVisual: true,
    });
    const win = dom.window;
    installResponse(win);

    const hits: string[] = [];
    (win as unknown as Record<string, unknown>).fetch = (url: string) => {
      hits.push(url);
      const payload = url.includes('/ogv/player/playview')
        ? playviewBody(733318)
        : { code: 0, result: playurlResult() };
      const text = JSON.stringify(payload);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(JSON.parse(text) as unknown),
      });
    };

    win.eval(SOURCE);
    win.postMessage({ __ns: '__PLUMA__', type: 'cfg', token: 'tok', enabled: true }, '*');
    return { win, hits };
  }

  async function callPlayview(win: JSDOM['window']) {
    const impl = (win as unknown as Record<string, unknown>).fetch as (
      u: string,
      i?: unknown,
    ) => Promise<{ json: () => Promise<unknown> }>;
    const resp = await impl('https://api.bilibili.com/ogv/player/playview?ep_id=733318', {
      credentials: 'include',
    });
    return (await resp.json()) as {
      data?: { video_info?: { dash?: { video?: Array<{ height?: number }> } } };
    };
  }

  it('不截断但能取到更高画质 → dash 被换成 4K（限免集的真实场景）', async () => {
    const { win, hits } = boot(fullResult);
    await new Promise((r) => setTimeout(r, 20));

    const body = await callPlayview(win);
    const maxH = Math.max(...(body.data?.video_info?.dash?.video ?? []).map((v) => v.height ?? 0));

    expect(maxH).toBe(2160);
    expect(hits.some((u) => u.includes('/pgc/player/web/playurl'))).toBe(true);
  });

  it('取回来画质不更高 → 不动（避免无意义的响应改写 + 播放器重建）', async () => {
    const { win } = boot(sameResult);
    await new Promise((r) => setTimeout(r, 20));

    const body = await callPlayview(win);
    const maxH = Math.max(...(body.data?.video_info?.dash?.video ?? []).map((v) => v.height ?? 0));

    expect(maxH).toBe(1080);
  });
});

/**
 * 总开关关闭 → 不注入缓存流（问题 4，2026-10-29）。
 *
 * ## 为什么这条必须存在
 *
 * 用户报「关掉总开关 → 刷新番剧页 → 画质不回落」。根因是门控依赖
 * `pgcActive`，而它只由 `page/activate` 的异步回复驱动 —— 与 SSR 赋值
 * 没有先后保证。第一版修法把「未知」翻转成「拒绝」，真机一测发现
 * **开关正常开着时 `skipUnknownCount` 也会 +1**（注入从 ~600ms 拖到 1879ms），
 * 于是改用 `cfgEnabled`（`hello` 时同步下发）判断总开关。
 *
 * ⚠️ **没有这条测试时，把 `if (cfgEnabled === false)` 改成 `if (false)`
 * 整个文件仍然 25/25 全绿** —— 反例验证抓不到，等于这个修复没有守卫。
 * 所以这里直接断言两件事：不注入、且 `skipDisabledCount` 真的 +1。
 */
describe('总开关关闭时不注入（问题 4）', () => {
  /** 自包含：不与其它 describe 的内部常量耦合 */
  const CID = 253153139;

  function ssrOf(cid: number) {
    const s = ssrPreview();
    (s.result.arc as { cid: number }).cid = cid;
    (s.result.video_info as { cid?: number }).cid = cid;
    return s;
  }

  it('cfg.enabled=false + 有缓存 → 不注入，且 skipDisabledCount +1', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      'pluma:pgc-vi:' + String(CID),
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );

    // 总开关关着：enabled=false，且不带 pgcActive（真实场景里 hello 那条就是这样）
    sendCfg(sb, { enabled: false });
    await flush();

    sb.page.__playinfo__ = ssrOf(CID);

    // 没有注入：dash 保持 SSR 原样（试看那份）
    expect(vi(sb).dash).toBeUndefined();
    expect(vi(sb).quality).toBe(80);

    const trace = (sb.win as unknown as Record<string, unknown>).__PLUMA_PGC__ as
      | { skipDisabledCount?: number; lastStage?: string; lastSkipEnabled?: boolean | null }
      | undefined;
    expect(trace?.skipDisabledCount).toBe(1);
    expect(trace?.lastStage).toBe('skip-disabled');
    expect(trace?.lastSkipEnabled).toBe(false);
  });

  it('cfg.enabled=true → 正常注入（这道门控不许误伤正常路径）', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      'pluma:pgc-vi:' + String(CID),
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );

    sendCfg(sb, { enabled: true });
    await flush();
    sb.page.__playinfo__ = ssrOf(CID);

    expect(vi(sb).dash).toBeDefined();
    const trace = (sb.win as unknown as Record<string, unknown>).__PLUMA_PGC__ as
      { skipDisabledCount?: number } | undefined;
    expect(trace?.skipDisabledCount).toBe(0);
  });
});

/**
 * ADR 0028 第一层：`localStorage` 的「开关关着」标记门控。
 *
 * ## 这一组守什么
 *
 * 「关掉总开关 → 刷新番剧页 → 画质不回落」的真因是**信号必然晚于注入**：
 *
 * ```
 * ssAt      : 357ms   ← SSR 赋值
 * patchedAt : 358ms   ← 注入完成（此刻 cfg 还没到）
 * cfgCount  : 4       ← cfg 全部在 358ms 之后才到
 * ```
 *
 * 所以任何依赖扩展消息的判据都赢不了这场赛跑（v1/v2/v3 三版都被否）。
 * ADR 0028 换成 `localStorage`：同步 API + 跨标签页 + 不依赖消息 —— **不在赛道上**。
 *
 * ⚠️ **反例验证**：把 `pgcReadProxyOff()` 的调用整段删掉，本组第 1 条必红。
 * 若它仍然绿，说明这条测试没在测门控。
 */
describe('总开关本地标记（ADR 0028 第一层）', () => {
  /** 与 `main-world.js` 的 `PGC_SS_PREFIX` 必须一致 */
  const SS_KEY = 'pluma:pgc-vi:';
  /** 与 `main-world.js` + `content.ts` 的 `PROXY_OFF_KEY` 必须一致 */
  const OFF_KEY = 'pluma:proxy-off';
  const CID = 281989571;

  /** 往 localStorage 写一条新鲜的「关着」标记 */
  function markOff(sb: Sandbox, ageMs = 0): void {
    sb.win.localStorage.setItem(OFF_KEY, JSON.stringify({ at: Date.now() - ageMs }));
  }

  /** 放一份同步缓存（ADR 0020 的注入输入） */
  function seedCache(sb: Sandbox): void {
    sb.win.sessionStorage.setItem(
      SS_KEY + String(CID),
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );
  }

  function traceOf(sb: Sandbox) {
    return (sb.win as unknown as Record<string, unknown>).__PLUMA_PGC__ as
      { skipProxyOffCount?: number; skipDisabledCount?: number; lastStage?: string } | undefined;
  }

  it('① 标记新鲜 + 有 sessionStorage 缓存 → 不注入，skipProxyOffCount === 1', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    seedCache(sb);
    markOff(sb);

    // ⚠️ 故意**不发 cfg**：模拟真机里"cfg 还没到，注入就已经发生了"的那一刻。
    // 这正是旧实现漏掉注入的场景，也是本 ADR 要覆盖的时刻。
    sb.page.__playinfo__ = ssrPreview();

    // 没有注入：dash 保持 SSR 原样，quality 还是试看的 80
    expect(vi(sb).dash).toBeUndefined();
    expect(vi(sb).quality).toBe(80);

    const trace = traceOf(sb);
    expect(trace?.skipProxyOffCount).toBe(1);
    expect(trace?.lastStage).toBe('skip-proxy-off');
  });

  it('② 标记不存在 → 正常注入（不误伤正常路径）', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    seedCache(sb);
    // 不写标记

    sb.page.__playinfo__ = ssrPreview();

    expect(vi(sb).dash).toBeDefined();
    expect(vi(sb).quality).toBe(120);
    expect(traceOf(sb)?.skipProxyOffCount).toBe(0);
  });

  it('③ 标记过期（at 早于 30 分钟）→ 正常注入（防永久静默失效）', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    seedCache(sb);
    // 31 分钟前写的：超过 PROXY_OFF_TTL_MS
    markOff(sb, 31 * 60 * 1000);

    sb.page.__playinfo__ = ssrPreview();

    /**
     * 这是 ADR 0028「代价」一节的兜底：
     * 某次写标记失败会留下旧标记，若永久有效就等于**永久拦住注入** ——
     * PGC 功能静默消失。TTL 保证最坏只错 30 分钟。
     */
    expect(vi(sb).dash).toBeDefined();
    expect(vi(sb).quality).toBe(120);
  });

  it('④ 读标记抛错（隐私模式）→ 正常注入', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    seedCache(sb);

    /**
     * 模拟隐私模式 / 配额满：`localStorage.getItem` 直接抛。
     * ⚠️ 在 `__playinfo__` 赋值**之前**替换 —— setter 里才调 `pgcReadProxyOff()`。
     *
     * ## ⚠️ 必须打在**原型**上，不能打在实例上（2026-10-29 实测）
     *
     * jsdom 的 `localStorage` 是个 **Proxy**，`Object.getOwnPropertyNames(ls)`
     * 返回 `[]` —— 对实例 `defineProperty('getItem', …)` **静默不生效**，
     * 真实调用仍然走原型上的 `Storage.prototype.getItem`。
     *
     * 第一版就踩了这个坑：改完之后这条测试**仍然绿**，看起来"门控是对的"，
     * 实际是**抛错根本没发生**，测的是一个不成立的场景。反例验证才暴露出来
     * （把 `catch` 改成 `return true` 也照样绿 → 说明 `catch` 从没进过）。
     *
     * 所以这里定义在 `Object.getPrototypeOf(ls)` 上，并在 finally 里还原，
     * 避免污染同文件里其它用例（`describe` 之间共享同一份 jsdom 模块状态）。
     *
     * ## ⚠️ 而且必须**只对 localStorage 生效**（第二版踩的坑）
     *
     * `localStorage` 与 `sessionStorage` **共享同一个 `Storage.prototype`**。
     * 无差别替换会让 `pgcReadCacheSync()` 里的 `sessionStorage.getItem()`
     * 也抛 → 缓存读不到 → 主世界没有东西可注入 → 这条测试**因为错误的原因**变红。
     *
     * 所以按 `this` 区分：只有 `localStorage` 抛，`sessionStorage` 走原函数。
     */
    const ls = sb.win.localStorage;
    const proto = Object.getPrototypeOf(ls) as {
      getItem: (k: string) => string | null;
    };
    const original = proto.getItem;
    proto.getItem = function (this: unknown, k: string) {
      if (this === ls) throw new Error('SecurityError: localStorage is disabled');
      return original.call(this, k);
    };

    try {
      sb.page.__playinfo__ = ssrPreview();
    } finally {
      proto.getItem = original;
    }

    // 判不了 → 放行。**不放行比多注入危险得多**（ADR 0028）。
    expect(vi(sb).dash).toBeDefined();
    expect(vi(sb).quality).toBe(120);
  });

  it('⑤ 标记 + cfgEnabled=false 并存 → ① 先拦，skipDisabledCount 保持 0', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    seedCache(sb);
    markOff(sb);

    // 两道**同时**为「关」。ADR 0028 要求先判 ①，所以 ② 的那条分支走不到。
    sendCfg(sb, { enabled: false });
    await flush();

    sb.page.__playinfo__ = ssrPreview();

    expect(vi(sb).dash).toBeUndefined();

    /**
     * 两个计数必须分得清 —— 合成一个就让这套门控不可观测，
     * 而"看不出是哪条路在拦"正是上一轮走了三版弯路的一半原因。
     *
     * ⚠️ 这里断言 `skipDisabledCount === 0` 是**顺序**的守卫：
     * 谁把 `cfgEnabled` 那段挪到 `pgcReadProxyOff()` 前面，这条就红。
     */
    const trace = traceOf(sb);
    expect(trace?.skipProxyOffCount).toBe(1);
    expect(trace?.skipDisabledCount).toBe(0);
    expect(trace?.lastStage).toBe('skip-proxy-off');
  });

  it('⑥ 标记键名与 content.ts 的 PROXY_OFF_KEY 完全一致（防两边漂移）', () => {
    /**
     * 主世界是裸 JS、`content.ts` 是 TS，两边各写一份字符串常量
     * （与 `PGC_SS_PREFIX` 是同一类问题）。不一致 = **门控静默失效**：
     * content 写 `pluma:proxy-off`，主世界读 `pluma:proxy-off-`（差一个字符）
     * 就会永远读不到 → 永远放行 → 退回原 bug，且**没有任何报错**。
     *
     * 所以这里直接读两边的源码比对字面量，而不是 import 常量
     * （裸 JS 根本没法 import）。
     *
     * ⚠️ 常量的**真实定义**在 `src/content/isolated/pgc-proxy-off.ts`；
     * `entrypoints/content.ts` 只是 import 它。两个都查，防止有人为了
     * "少一个文件"把常量挪回入口 —— 那会让这条断言失去意义。
     */
    const contentSource = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');
    const moduleSource = readFileSync(
      resolve(process.cwd(), 'src/content/isolated/pgc-proxy-off.ts'),
      'utf8',
    );

    const mainWorldKey = /var PROXY_OFF_KEY = '([^']+)'/.exec(SOURCE)?.[1];
    const moduleKey = /export const PROXY_OFF_KEY = '([^']+)'/.exec(moduleSource)?.[1];

    expect(mainWorldKey).toBeDefined();
    expect(moduleKey).toBeDefined();
    expect(mainWorldKey).toBe(moduleKey);
    // 同时锁死具体值：两个文件一起被改成别的字符串也能被抓到
    expect(mainWorldKey).toBe('pluma:proxy-off');

    /**
     * `entrypoints/content.ts` **必须从模块 import**，不许自己再抄一份字面量。
     * 抄一份就又是第二个真相源 —— 而且这一份不会被上面两个正则覆盖到。
     */
    expect(contentSource).toContain('writeProxyOffMark');
    expect(/const PROXY_OFF_KEY = '/.test(contentSource)).toBe(false);
  });

  it('⑦ 标记键名与测试里的 OFF_KEY 一致（夹具不能自己漂移）', () => {
    // 夹具写错的后果是"测的是不存在的键"，那时 ①/③/⑤ 会假绿
    const mainWorldKey = /var PROXY_OFF_KEY = '([^']+)'/.exec(SOURCE)?.[1];
    expect(mainWorldKey).toBe(OFF_KEY);
  });

  it('⑧ TTL 常量两处一致（主世界 vs pgc-proxy-off.ts）', () => {
    /**
     * TTL 不一致的后果与键名不一致**不同但同样隐蔽**：
     * 只要一边更长，标记就会在另一边"已经过期"的时段里继续生效 ——
     * 表现为"关着开关刷新，有时回落有时不回落"，是最难复现的那类。
     */
    const moduleSource = readFileSync(
      resolve(process.cwd(), 'src/content/isolated/pgc-proxy-off.ts'),
      'utf8',
    );

    const mainWorldTtl = /var PROXY_OFF_TTL_MS = (.+?);/.exec(SOURCE)?.[1];
    const moduleTtl = /export const PROXY_OFF_TTL_MS = (.+?);/.exec(moduleSource)?.[1];

    expect(mainWorldTtl).toBeDefined();
    expect(moduleTtl).toBeDefined();
    // 两边都写成 `30 * 60 * 1000` 这种可读形式，直接比字符串
    expect(mainWorldTtl?.replace(/\s/g, '')).toBe(moduleTtl?.replace(/\s/g, ''));
  });
});

/**
 * `ssr-playinfo` 必须带上 `pgcPatched`（2026-10-29 加）。
 *
 * ## 为什么这个布尔量是整个「重开开关后卡试看」修复的支点
 *
 * `ssrPlayinfo` 是 `__playinfo__` 的**同一个对象引用**（setter 里 `ssrPlayinfo = v`），
 * 而紧接着 `pgcPatchPlayinfo(v)` 会 `r.video_info = next` **原地替换**。
 *
 * 所以注入成功后上报出去的 `data` 里已经是完整流 —— ISOLATED 侧拿它判
 * `isStreamTruncated()` 会得到 `false`，于是走「无需注入」早退，
 * **永远进不到 cache 分支、永远不会 reload**。
 *
 * `pgcPatched` 就是让上层能区分「SSR 本来完整」和「被我们改成了完整」的唯一信号。
 * 没有它，`canSkipPgcInjection()` 拿不到正确的入参，那个修复等于不存在。
 */
describe('ssr-playinfo 带 pgcPatched 标记', () => {
  /** 等主世界把 `ssr-playinfo` 派发出来 */
  async function waitForSsr(sb: Sandbox): Promise<Record<string, unknown> | undefined> {
    for (let i = 0; i < 5; i += 1) {
      await flush();
      const hit = sb.sent.filter((m) => m.type === 'ssr-playinfo').pop();
      if (hit) return hit;
    }
    return undefined;
  }

  it('没有注入时 pgcPatched === false', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.page.__playinfo__ = ssrPreview();
    await flush();

    const msg = await waitForSsr(sb);
    expect(msg).toBeDefined();
    expect(msg?.pgcPatched).toBe(false);
  });

  it('注入成功后 pgcPatched === true，且上报的 data 里已经是完整流', async () => {
    /**
     * 这条**同时**证明两件事，缺一不可：
     *   1. 标记为 true（上层据此知道"这份完整流是我们自己弄的"）
     *   2. `data.result.video_info.dash` 存在（确实被原地改过）
     *
     * 第 2 点是第 1 点存在的**理由** —— 如果 data 没被改，就不需要这个标记。
     *
     * ## ⚠️ 必须等**延迟补报**，不是等第一次 immediate 上报
     *
     * `postSsrPlayinfo()` 在 `document_start` 立刻发一次，那时还没注入
     * （`__playinfo__` 都还没赋值），`pgcPatched` 必然是 `false`。
     *
     * 真正的时机在 `setTimeout(postSsrPlayinfo, 1500)` / `5000` —— 那时
     * setter 已经跑完、注入已完成。所以这里用 `sent` 里**最后一条**
     * 并等到它出现，而不是 `flush()` 一次就断言。
     *
     * 这条测试同时也守卫了"延迟补报确实会带上最新状态"这件事：
     * 若哪天有人把 `pgcPatched` 改成在启动时求值一次的快照，这里会红。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      'pluma:pgc-vi:281989571',
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );

    // 故意不发 cfg：复现真机"cfg 还没到，注入已由 sessionStorage 完成"
    sb.page.__playinfo__ = ssrPreview();

    // 注入确实发生了
    expect(vi(sb).dash).toBeDefined();

    /**
     * 等到出现一条 `pgcPatched === true` 的上报（1500ms 那条）。
     *
     * ⚠️ 不能用 vitest 的 `vi.waitFor`：本文件有个同名局部 helper `vi(sb)`
     * 用来读 `__playinfo__.result.video_info`（见文件上方），
     * 会把 `vi.waitFor` 遮住。所以这里手写轮询，够用且不引入命名冲突。
     */
    let patchedMsg: Record<string, unknown> | undefined;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      patchedMsg = sb.sent.filter((m) => m.type === 'ssr-playinfo' && m.pgcPatched === true).pop();
      if (patchedMsg) break;
    }
    expect(patchedMsg, '等了 8 秒没等到 pgcPatched=true 的 ssr-playinfo').toBeDefined();

    // 上报的 data 里也是完整流 —— 正因如此才需要 pgcPatched 来区分
    const data = patchedMsg?.data as { result?: { video_info?: { dash?: unknown } } } | undefined;
    expect(data?.result?.video_info?.dash).toBeDefined();
  }, 15000);
});

/**
 * 观测点：`createPlayerAt` / `patchedInSetter` / `injectedFrom` / `injectedTo`。
 *
 * ## 为什么这些字段也要测
 *
 * 它们存在的唯一目的是**替代推理**——真机「注入了但 duration 仍是 180」这件事，
 * 我先后猜过两个原因（durls 求和误判、cfg 补注入），**两个都被数据推翻了**。
 * 所以这些字段是下一轮定位的**唯一依据**。
 *
 * 埋点本身写错了，比没有埋点更糟：会让人朝错的方向查。
 * 所以这里断言它们真的记录了东西，而不是永远 `-1` / `null`。
 */
describe('排查观测点（只观测，不改行为）', () => {
  const traceOf = (sb: Sandbox) =>
    (sb.win as unknown as Record<string, unknown>).__PLUMA_PGC__ as
      | {
          patchedInSetter?: boolean | null;
          injectedFrom?: number;
          injectedTo?: number;
          createPlayerAt?: number;
          createPlayerCalls?: number;
          playinfoAt?: number;
          patchedAt?: number;
          lastStage?: string;
        }
      | undefined;

  it('setter 注入 → patchedInSetter === true', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      'pluma:pgc-vi:281989571',
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );
    sb.page.__playinfo__ = ssrPreview();

    expect(traceOf(sb)?.patchedInSetter).toBe(true);
  });

  it('cfg 补注入 → patchedInSetter === false', async () => {
    /**
     * ⚠️ 这条守的是「不能用 lastStage 判断注入来源」：
     * cfg 分支会在注入之后把 lastStage 覆写成 'cfg-with-cache'，
     * 两种情况看 lastStage 都是同一个值，只有这个布尔字段能分开。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);

    // 先赋值（此时没有缓存 → 不注入），再发 cfg 带缓存 → 走补注入路径
    sb.page.__playinfo__ = ssrPreview();
    expect(vi(sb).dash).toBeUndefined();

    sendCfg(sb, { pgcVideoInfo: cachedFullVideoInfo() });
    await flush();

    expect(vi(sb).dash).toBeDefined();
    expect(traceOf(sb)?.patchedInSetter).toBe(false);

    /**
     * ⚠️ 这正是「`lastStage` 不能当注入来源判据」的**铁证**。
     *
     * `cfg` 分支的顺序是：
     *   1. `pgcTrace.lastStage = 'cfg-with-cache'`   （标记"收到缓存"）
     *   2. `pgcPatchPlayinfo(...)` → 内部把 `lastStage` 覆写成 `'patched'`
     *
     * 所以补注入之后 `lastStage` 是 **`'patched'`** —— 和 setter 注入**一模一样**。
     * 真机上 team-lead 看到 `cfg-with-cache` 是因为那次注入走的是 setter
     * （`patchedAt - ssAt = 1ms`），cfg 到达时 `pgcPatched` 已 true 不再补注入，
     * 于是只留下 `cfg-with-cache` —— 反而更像"补注入"，把人误导了一次。
     *
     * **两种来源的最后一条 `lastStage` 可能相同也可能不同，完全不可区分。**
     * 这就是为什么必须有一个独立的 `patchedInSetter`。
     */
    expect(traceOf(sb)?.lastStage).toBe('patched');
  });

  it('injectedFrom / injectedTo 记录注入前后的 dash.duration', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      'pluma:pgc-vi:281989571',
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );
    sb.page.__playinfo__ = ssrPreview();

    const t = traceOf(sb);
    /**
     * `ssrPreview()` 是纯试看：没有 dash，只有 `durls`。
     * 缓存里的 `cachedFullVideoInfo()` 有 `dash.duration: 1441`。
     * 所以 from 应为 -1（注入前没有 dash），to 应为 1441。
     */
    expect(t?.injectedFrom).toBe(-1);
    expect(t?.injectedTo).toBe(1441);
  });

  it('playinfoAt 记录 __playinfo__ 赋值时刻，且不晚于 patchedAt', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      'pluma:pgc-vi:281989571',
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );
    sb.page.__playinfo__ = ssrPreview();

    const t = traceOf(sb);
    expect(typeof t?.playinfoAt).toBe('number');
    expect(t?.playinfoAt).toBeGreaterThanOrEqual(0);
    // 赋值在前、注入在后（同一个 setter 内），所以 patchedAt >= playinfoAt
    expect(t?.patchedAt).toBeGreaterThanOrEqual(t?.playinfoAt ?? 0);
  });

  it('createPlayer 被包住时记录调用时刻；未调用时保持 -1', async () => {
    /**
     * 分两步断言，因为这两件事的意义不同：
     *   - 没调用 → `createPlayerAt === -1`（真机上必须能看出"我们根本没观测到"）
     *   - 调用了 → 记了时刻，且计数增加
     *
     * 观测装不上的话 `createPlayerAt` 会一直是 -1，
     * 那时真机上就分不清"播放器没调"和"我们没装上 hook" —— 所以这里
     * 用一个真实的 `nano` 赋值来验证包装确实生效。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);

    expect(traceOf(sb)?.createPlayerAt).toBe(-1);
    expect(traceOf(sb)?.createPlayerCalls).toBe(0);

    // 模拟页面赋值 window.nano（真机上 SSR 内联脚本就是这么做的）
    const called: unknown[] = [];
    const nano = {
      createPlayer(cfg: unknown) {
        called.push(cfg);
        return 'fake-player';
      },
    };
    (sb.win as unknown as Record<string, unknown>).nano = nano;

    // 包装后，调用它应当被记录且原样透传
    const ret = (nano.createPlayer as (c: unknown) => unknown)({ marker: 42 });

    expect(ret).toBe('fake-player'); // 返回值透传
    expect(called).toEqual([{ marker: 42 }]); // 参数透传
    expect(traceOf(sb)?.createPlayerCalls).toBe(1);
    expect(traceOf(sb)?.createPlayerAt).toBeGreaterThanOrEqual(0);
  });
});

/**
 * 读取侧第三道防线：主世界拒绝注入「短于 timelength」的缓存（2026-10-29，问题 5）。
 *
 * ## 为什么主世界也要判
 *
 * ISOLATED 侧已经在写入（`prepareFullStream`）与读取（`orchestratePgc`）两处校验。
 * 但旧版本写下的坏数据**还在用户机器上**（TTL 100 分钟），而主世界正是
 * 直接把它注入进 `__playinfo__` 的那一方 —— 它不判，坏数据就照样生效。
 *
 * 另外 `cfg.pgcVideoInfo` 那条路**绕过 sessionStorage**，`pgcReadCacheSync` 管不到。
 *
 * ⚠️ 反例验证：把 `pgcVideoInfoTruncated()` 删掉（或恒返回 false），
 * 「坏缓存不注入」那条必红。
 */
describe('读取侧：拒绝截断缓存（问题 5 的第三道防线）', () => {
  const CID = 42696771537;
  const SS_KEY = 'pluma:pgc-vi:';

  /** 真机 sessionStorage 里那份坏数据的**逐字段复制** */
  function badVideoInfo() {
    return {
      timelength: 1166528, // 19 分钟
      quality: 80,
      // 1 段 180 秒的 durl —— 与 timelength 自相矛盾
      durl: [{ length: 180160, url: 'https://cn-cq-gd-bcache.example/preview.m4s' }],
    };
  }

  /** 完整流（单段 durl，长度 = timelength）—— 不许被误杀 */
  function goodDurlVideoInfo() {
    return {
      timelength: 1440000,
      quality: 80,
      durl: [{ length: 1440000, url: 'https://example/full.m4s' }],
    };
  }

  function traceOf(sb: Sandbox) {
    return (sb.win as unknown as Record<string, unknown>).__PLUMA_PGC__ as
      { cacheRejectedTruncated?: boolean; patchedAt?: number } | undefined;
  }

  it('sessionStorage 里是坏缓存 → 不注入，且 cacheRejectedTruncated 置位', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      SS_KEY + String(CID),
      JSON.stringify({ vi: badVideoInfo(), exp: Date.now() + 60_000 }),
    );

    const ssr = ssrPreview();
    (ssr.result.arc as { cid: number }).cid = CID;
    (ssr.result.video_info as { cid?: number }).cid = CID;
    sb.page.__playinfo__ = ssr;

    // 没有注入：SSR 原样（quality 仍是试看的 80，durls 还在）
    const got = vi(sb);
    expect(got.quality).toBe(80);
    expect(got.durl).toBeUndefined();
    // 关键：注入的坏 durl 没被塞进去
    expect(got.timelength).toBe(1440083);

    expect(traceOf(sb)?.cacheRejectedTruncated).toBe(true);
  });

  it('⚠️ 完整单段 durl 不被误杀（length = timelength）', async () => {
    /**
     * 这条是防过度修复的。
     * `fnval=0` 老路的完整集就是"单段 durl + 长度等于 timelength"。
     * 用"有没有 dash"当判据会把这种合法缓存误杀 → 每次进页面都白取一次流。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      SS_KEY + String(CID),
      JSON.stringify({ vi: goodDurlVideoInfo(), exp: Date.now() + 60_000 }),
    );

    const ssr = ssrPreview();
    (ssr.result.arc as { cid: number }).cid = CID;
    (ssr.result.video_info as { cid?: number }).cid = CID;
    sb.page.__playinfo__ = ssr;

    // 注入了：timelength 换成了缓存的 1440000
    expect(vi(sb).timelength).toBe(1440000);
    expect(traceOf(sb)?.cacheRejectedTruncated).toBeFalsy();
  });

  it('⚠️ 完整多段 durl 不被误杀（段长相加 = timelength）', async () => {
    /**
     * 2026-10-29 verifier 反例：以前只看 `durl[0]`，多段完整流会被判截断。
     * 主世界与 ISOLATED 两侧必须同时改成"按段相加"。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      SS_KEY + String(CID),
      JSON.stringify({
        vi: {
          timelength: 1440000,
          durl: [
            { length: 720000, url: 'https://example/a.m4s' },
            { length: 720000, url: 'https://example/b.m4s' },
          ],
        },
        exp: Date.now() + 60_000,
      }),
    );

    const ssr = ssrPreview();
    (ssr.result.arc as { cid: number }).cid = CID;
    (ssr.result.video_info as { cid?: number }).cid = CID;
    sb.page.__playinfo__ = ssr;

    expect(vi(sb).timelength).toBe(1440000);
    expect(traceOf(sb)?.cacheRejectedTruncated).toBeFalsy();
  });

  it('⚠️ 完整 dash 不被误杀', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      SS_KEY + String(CID),
      JSON.stringify({
        vi: { timelength: 1440083, dash: { duration: 1441, video: [{ height: 2160 }] } },
        exp: Date.now() + 60_000,
      }),
    );

    const ssr = ssrPreview();
    (ssr.result.arc as { cid: number }).cid = CID;
    (ssr.result.video_info as { cid?: number }).cid = CID;
    sb.page.__playinfo__ = ssr;

    expect(vi(sb).dash).toBeDefined();
    expect(traceOf(sb)?.cacheRejectedTruncated).toBeFalsy();
  });

  it('cfg 送来的坏缓存也拒绝（那条路绕过 sessionStorage）', async () => {
    /**
     * `cfg.pgcVideoInfo` 直接把 `video_info` 塞进来，不经过 `pgcReadCacheSync`。
     * 这是主世界读取侧的**第二个人口**，必须单独覆盖。
     */
    const sb = bootAt(PGC_URL);
    await ready(sb);

    const ssr = ssrPreview();
    (ssr.result.arc as { cid: number }).cid = CID;
    (ssr.result.video_info as { cid?: number }).cid = CID;
    sb.page.__playinfo__ = ssr;

    // 此时没有注入
    expect(vi(sb).durl).toBeUndefined();

    sendCfg(sb, { pgcVideoInfo: badVideoInfo() });
    await flush();

    // cfg 到了，但因为它是截断流 → 拒绝赋值 → 仍不注入
    expect(vi(sb).durl).toBeUndefined();
    expect(vi(sb).quality).toBe(80);
    expect(traceOf(sb)?.cacheRejectedTruncated).toBe(true);
  });
});

/**
 * 主世界与 ISOLATED 两侧的截断判据必须**完全一致**（2026-10-29）。
 *
 * 裸 JS 无法 import `TRUNCATION_SLACK_MS`，所以手写一份等价值。
 * 不一致的后果不是报错，是「上层觉得是试看、下层觉得能用」——
 * 注入照旧发生，而且**没有任何日志会说出这件事**。
 */
describe('截断容差两处一致', () => {
  it('PGC_TRUNCATION_SLACK_MS 与 TRUNCATION_SLACK_MS 相同', () => {
    const injectSource = readFileSync(
      resolve(process.cwd(), 'src/content/isolated/pgc-cache-inject.ts'),
      'utf8',
    );

    const mainWorldSlack = /var PGC_TRUNCATION_SLACK_MS = ([^;]+);/.exec(SOURCE)?.[1];
    const isolatedSlack = /export const TRUNCATION_SLACK_MS = ([^;]+);/.exec(injectSource)?.[1];

    expect(mainWorldSlack?.replace(/\s/g, '')).toBe(isolatedSlack?.replace(/\s/g, ''));
    // 锁死具体值：两边一起被改也能抓到
    expect(mainWorldSlack?.replace(/\s/g, '')).toBe('5000');
  });
});

/**
 * 注入成功后必须通知 ISOLATED 侧（2026-10-29 修：首次进入番剧页 popup 显示「等待取流…」）。
 *
 * ## 为什么这条必须存在
 *
 * `pageState.playback`（popup 徽章的数据源）只有两个写入点：
 * `prepareFullStream` 取流成功、以及切集时的 `pgc-playview-stream`。
 *
 * **首次进入走的是第三条路**：sessionStorage 里已有缓存 → 主世界同步注入
 * → ISOLATED 侧不知道，`playback` 恒 null → popup 显示「等待取流…」，
 * 而画面其实已经是 3840×2160。切一集就正常（那条发通知），
 * 所以用户看到的是"切一下就好了"。
 *
 * 真机现场：ep3854816 首次进入 `{title:'等待取流…', badges:[]}`，
 * 而 `video.videoWidth = 3840`。
 */
describe('注入成功后通知 ISOLATED（修首次进入 popup 空白）', () => {
  const CID = 253153139;

  function ssrOf(cid: number) {
    const s = ssrPreview();
    (s.result.arc as { cid: number }).cid = cid;
    (s.result.video_info as { cid?: number }).cid = cid;
    return s;
  }

  it('★ 同步注入成功 → 发出 pgc-playview-stream，且带 cid 与注入后的流', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sb.win.sessionStorage.setItem(
      'pluma:pgc-vi:' + String(CID),
      JSON.stringify({ vi: cachedFullVideoInfo(), exp: Date.now() + 60_000 }),
    );

    sendCfg(sb, { enabled: true });
    await flush();
    sb.page.__playinfo__ = ssrOf(CID);
    await flush();

    // 必须有这条通知 —— 否则 ISOLATED 不知道注入发生过
    const notice = sb.sent.find((m) => m.type === 'pgc-playview-stream');
    expect(notice, '注入成功后必须发 pgc-playview-stream').toBeDefined();
    expect(notice?.cid).toBe(String(CID));

    // 带的是**注入后**的流（完整集），不是 SSR 原样
    const vi = notice?.result as { dash?: { duration?: number } } | undefined;
    expect(vi?.dash?.duration).toBeGreaterThan(1000);
  });

  it('没有缓存 → 不发这条通知（没注入就没有"拿到了什么"可报）', async () => {
    const sb = bootAt(PGC_URL);
    await ready(sb);

    sendCfg(sb, { enabled: true });
    await flush();
    sb.page.__playinfo__ = ssrOf(CID);

    expect(sb.sent.find((m) => m.type === 'pgc-playview-stream')).toBeUndefined();
  });
});
