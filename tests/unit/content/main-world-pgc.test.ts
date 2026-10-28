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
