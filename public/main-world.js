/**
 * 主世界脚本 —— 由 MAIN world 内容脚本注入（`entrypoints/main-hook.content.ts`）。
 *
 * 这是**唯一源文件**（不再从 TS 模板生成），避免两份代码漂移。
 *
 * ## 为什么不能内联，也不能用 `<script src>`
 *
 * 两次都踩过（2026-10-27/28）：
 *   - 内联 `<script>`：MV3 的 `extension_pages` CSP **拒绝** `'unsafe-inline'`，
 *     扩展直接装不上（Edge 156 报 `Insecure CSP value`）
 *   - `<script src=chrome-extension://…>`：**异步加载**，晚于 PGC 页的内联脚本，
 *     hook 永远装不上
 *
 * 现在由浏览器在 `document_start` 直接注入主世界（`world: 'MAIN'`），时机正确，不碰 CSP。
 *
 * ## 为什么要注入主世界
 * 只靠 DNR 换 Cookie 不够，页面侧还有三个障碍：
 *
 * 1. B站把播放数据 SSR 进 window.__playinfo__
 *    **普通视频页**：播放器直接读这个全局变量，根本不发 playurl 请求 → DNR 没有请求可改。
 *    必须在页面读它之前藏起来，逼播放器走 playurl API。
 *
 * 2. **PGC 页反过来**：`__playinfo__` 必须保留（藏了就没流），
 *    改成"把缓存里的完整流塞进 `video_info`"（ADR 0020，见 §1b）。
 *
 * 3. 播放器用 window.__INITIAL_STATE__.user.vipStatus 判断能否选高清
 *    主账号不是会员 → 直接弹「开通大会员」，连请求都不发。
 *    必须把这份本地状态伪装成会员，让它愿意去请求。
 *
 * 第 2 条只改**本地显示状态**，不伪造服务端权益：
 * 能否真正拿到 4K 取决于 DNR 换 Cookie 后服务端的真实响应。
 *
 * ## 通信
 * ISOLATED 侧的 content script 通过 postMessage 下发启用状态，
 * 带随机 channel token 防页面脚本伪造。
 *
 * 注意：本文件是纯 JS，不参与 TS 编译。改完要重新 build。
 */

(function () {
  'use strict';

  if (window.__PLUMA_MAIN__) return;
  window.__PLUMA_MAIN__ = true;

  var NS = '__PLUMA__';
  var enabled = false;
  var token = '';
  var tokenLocked = false;

  /**
   * 统一的对外通信出口 —— **所有 postMessage 都必须走这里**。
   *
   * ## 为什么
   *
   * 本脚本里十处 `window.postMessage` 全部是"给诊断用的上报"。
   * 一旦某次 postMessage 抛错（页面被冻结/丢弃的过程中可能抛 DataCloneError），
   * 如果没包住，异常会顺着调用栈往上冒：
   *   - 在小事件回调里冒 → 该回调之后的代码全不执行
   *   - 在 hook 里冒 → **被 hook 的原函数直接失败**，播放器拿不到资源 → 白屏
   *
   * 观测代码的价值远低于播放本身，所以这里统一吞掉。
   */
  function safePost(payload) {
    try {
      // ⚠️ 这里必须是**原始的** window.postMessage。
      // 不要把它也改成 safePost —— 那就成了自己调用自己，无限递归爆栈。
      window.postMessage(payload, '*');
    } catch (e) {}
  }

  /**
   * **原生 fetch 的备份，必须在任何 hook 之前取**。
   *
   * XHR 的「接管式改写」要用它重发请求。如果等到 fetch hook 那一段再取，
   * 拿到的可能是已经被我们替换过的版本 —— 于是 XHR → 自定义 fetch →
   * 自定义 fetch 又看到同一个 URL → 死循环，或者直接栈溢出。
   *
   * 这个变量是整个脚本里唯一被信任的"原始网络能力"。
   */
  var nativeFetch = window.fetch;

  // ── 1. 藏起 SSR 的 __playinfo__ ──
  // 关键：defineProperty 必须早于 SSR 内联脚本执行。
  // content script 在 document_start 执行 → 早于页面任何脚本，满足条件。
  var playinfoHidden = false;
  // ⚠️ 同 __INITIAL_STATE__：SSR 可能已经赋过值，必须先接过来，
  // 否则 defineProperty 会把它覆盖成 undefined
  var playinfoValue = window.__playinfo__;
  var defineResult = 'skipped';
  var hadExisting = typeof window.__playinfo__ !== 'undefined';

  /**
   * ── 主账号基线（ADR 0014）──
   *
   * ## 为什么不能只判断"有没有 __playinfo__"
   *
   * 有两份说法互相矛盾：ADR 0010 说它是**服务端 SSR** 的；
   * `poc/verify/RESULT.md` §一.2 说是**页面发完 playurl 之后自己写**的。
   *
   * 如果是后者，那份数据来自**已被 DNR 代理**的请求 = 播放账号身份。
   * 拿它当"主账号基线"，对比会永远显示"主账号也有 4K"，
   * 也就是"扩展没起作用"——不报错、不崩溃，只是静默谎报。
   *
   * ## 所以判据是"时机"，不是"存在"
   *
   * 记下第一次看到它的时机（`ssrFirstSeen`）以及那一刻之前有没有发过 playurl
   * （`ssrPlayurlBefore`）。两个值一起交给 ISOLATED 侧判定，
   * 判定逻辑在 `src/content/isolated/page-state.ts`（纯函数，可单测）。
   */
  var ssrPlayinfo = hadExisting ? playinfoValue : null;
  var ssrFirstSeen = hadExisting ? 'initial' : 'none';
  var ssrPlayurlBefore = false;
  /** 页面是否发出过 playurl —— 由 noteRequest 置位 */
  var anyPlayurlSeen = false;
  /** 原文只上报一次，避免每次切 P 都传几十 KB */
  var rawPlayurlPosted = false;
  /**
   * 配置回执是否已发过。
   *
   * ⚠️ **必须只发一次。** ISOLATED 侧收到 `ready` 会回 `cfg`，这里若每次回 `ready`
   * 就是无限回环 —— 2026-10-26 因此出过 Out of Memory（页面崩溃）。
   * 详见「通信」一节的长注释。
   */
  var cfgApplied = false;

  var IS_PGC = location.pathname.indexOf('/bangumi/play/') === 0;

  /** `false` = `page/activate` 明确回报"没装规则"（未配置 / 总开关关 / 同账号） */
  var pgcActive = null;

  /**
   * 待注入的完整集 `video_info`（由 ISOLATED 侧经 `cfg` 下发）。
   *
   * `null` = 没有缓存，照常播试看。
   */
  var pgcCachedVideoInfo = null;

  /**
   * `pgcCachedVideoInfo` 属于哪个 cid。
   *
   * 用途：SPA 切集时判断"手里这份缓存是不是上一集的"，只丢过期的，
   * 不能把 ISOLATED 侧刚送来的那份一起丢（那个 bug 让注入连续失效三轮）。
   */
  var pgcCachedForCid = '';

  /**
   * PGC 完整流缓存 —— **从 `sessionStorage` 同步读**（ADR 0020）。
   *
   * ## 为什么必须同步、必须在这里读（2026-10-28 最终定位）
   *
   * 真机 trace：
   * ```
   * bootAt:    439     ← 本脚本开始执行
   * createPlayer 调用: 409ms（实测）
   * patchedAt: 2032    ← 之前走 storage.local + postMessage 的注入完成时刻
   * ```
   * **播放器在 409ms 就把数据读走了，我们的注入 2032ms 才到 —— 晚了 1.6 秒。**
   *
   * 走 `chrome.storage` 是异步的，跨 world `postMessage` 还要排队，
   * 再加 106 KB 的 JSON 结构化克隆 —— 叠起来必然错过那个窗口。
   *
   * `sessionStorage` 是**同步** API 且主世界可直接访问，所以：
   *   - 第一趟：ISOLATED 侧取到流后写进来（key 含 cid）
   *   - 第二趟：这里在 `document_start` 同步读出来，setter 一触发就地替换
   *
   * 语义也正好：`sessionStorage` 刷新后保留、关标签页清空
   * ——「同一集同一会话有效」。
   */
  var PGC_SS_PREFIX = 'pluma:pgc-vi:';

  /**
   * 同步读缓存。
   *
   * @param {string} cid 章节 id
   * @returns {object|null}
   *
   * ⚠️ **永不抛错**：`sessionStorage` 在隐私模式 / 配额满 / 跨源 iframe 里可能抛。
   * 抛在 `document_start` 会让整份脚本挂掉，那比"没有缓存"严重得多。
   */
  function pgcReadCacheSync(cid) {
    if (!cid) return null;
    try {
      var raw = window.sessionStorage.getItem(PGC_SS_PREFIX + cid);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      // 过期判断：流地址实测约 110 分钟，缓存写的时候带 ttl
      if (typeof o.exp === 'number' && Date.now() > o.exp) return null;
      return o.vi && typeof o.vi === 'object' ? o.vi : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 从 SSR 数据里取 cid。
   *
   * 注意时机：setter 里 `v` 就是 `playurlSSRData.data`，`arc.cid` 一定在。
   */
  function pgcCidOf(v) {
    var r = v && v.result ? v.result : v && v.data && v.data.result ? v.data : null;
    if (!r) return null;
    var cid = (r.arc && r.arc.cid) || (r.video_info && r.video_info.cid);
    return cid ? String(cid) : null;
  }

  /**
   * 一次性：注入成功后置 true，避免同一个 `__playinfo__` 被替换两次。
   *
   * ⚠️ **SPA 切集时要重置**（2026-10-28 真机踩到）：在播放器里点选集
   * 页面不重载，`cid` 变了但 `createPlayer` 不会再调一次。
   * 靠 `pgcPatchedCid` 记住"上次补的是哪一集"，cid 一变就重置。
   */
  var pgcPatched = false;

  /** 上一次注入的是哪个 cid。用于识别 SPA 切集 */
  var pgcPatchedCid = '';

  /**
   * ## ⚠️ 只定义一次（2026-10-27 加，因为注入方式变了）
   *
   * 主世界脚本现在由 **MAIN world 内容脚本**注入（`entrypoints/pgc-main.content.ts`），
   * 由浏览器在 `document_start` 调度 —— 时机正确，不需要内联。
   *
   * 但**不能直接把 `Object.defineProperty` 放在顶层**：若它先跑过一次，
   * 之后再执行一次本脚本时，`defineProperty` 会被调两次。第二次会把
   * `playinfoValue` 重新读成"已经过 getter 的值"，而 `hadExisting` 变 true，
   * `ssrFirstSeen` 就从 `'initial'` 退化成 `'set'` —— 主账号基线判定会跟着漂。
   *
   * 用同名守卫 `__PLUMA_PLAYINFO_HOOK__` 把"已定义"这件事钉在 window 上。
   */
  if (!window.__PLUMA_PLAYINFO_HOOK__) {
    try {
      Object.defineProperty(window, '__playinfo__', {
        configurable: true,
        enumerable: true,
        get: function () {
          return playinfoHidden ? undefined : playinfoValue;
        },
        set: function (v) {
          playinfoValue = v;
          // 只记第一次赋值：之后播放器自己写的值都是客户端数据，不能当主账号基线
          if (ssrFirstSeen === 'none') {
            ssrFirstSeen = 'set';
            ssrPlayurlBefore = anyPlayurlSeen;
            ssrPlayinfo = v;
          }
          /**
           * PGC 页：SSR 赋值这一刻**同步**把完整流塞进去（ADR 0020）。
           *
           * 必须同步：`createPlayer` 就在这次赋值之后 0~2ms 被调用
           * （实测 409ms 赋值、409ms 调用），异步补丁一定来不及。
           *
           * ## 为什么每集都要重新判定（2026-10-28 真机踩到）
           *
           * **在播放器里点选集是 SPA 内跳，页面不重载。** 实测：
           * 点「第 8 集」之后 URL 变了，但 `__playinfo__.result.arc.cid`
           * **还是第 7 集的**（B站数据异步更新）。而 `pgcPatched = true`
           * 让注入只发生一次 —— 于是第 8 集的数据进来时**再也不注入**，
           * 播放器用 360 秒的流播新集，6 分 01 秒撞墙。
           *
           * 所以这里按 **cid** 判"是不是新的一集"：cid 变了就重置 `pgcPatched`，
           * 重新读缓存、重新注入。
           *
           * ## ⚠️ 重置时**不能**无条件清掉 `pgcCachedVideoInfo`
           *
           * 踩过（2026-10-28）：重置块里写了 `pgcCachedVideoInfo = null`，
           * 结果把 ISOLATED 侧刚通过 `cfg` 送来的那份缓存**也清掉了**。
           * 之后 `pgcReadCacheSync` 去 `sessionStorage` 里读 —— 第一次进新标签页时
           * 那里是空的，于是"有缓存可用"变成"没缓存"，注入再次失效。
           *
           * 正确做法：**只丢弃与旧 cid 绑定的那份**（用 `pgcCachedForCid` 记着它属于谁），
           * `cfg` 刚送来、且 cid 对得上的那份必须留着。
           */
          if (IS_PGC) {
            var cidNow = pgcCidOf(v);
            if (cidNow && cidNow !== pgcPatchedCid) {
              if (pgcPatched) {
                pgcPost('newep', 'cid 变化 ' + pgcPatchedCid + ' → ' + cidNow + '，重置注入状态');
              }
              /**
               * ## 这里**不再**通知 ISOLATED 侧（2026-10-28 实测后回退）
               *
               * 曾在这里发过 `epchange`（带新 cid），想让 ISOLATED 侧切集后重新取流。
               * 但真机验证证明**这个分支在 SPA 切集时根本不会执行**：
               * 切集后 `__playinfo__` 完全不重新赋值，setter 不被调用 ——
               * 实测切到 `ep341210` 后 `arc.cid` 仍是上一集的 `248742156`。
               *
               * 所以整条 `epchange` 链路是死代码，已删除。
               * SPA 切集改由**响应层拦截 `/ogv/player/playview`** 处理（ADR 0023）。
               *
               * 保留这个 cid 变化判定本身：页面偶尔会用新的 `__playinfo__`
               * 覆盖（例如站内跳转），那时确实要重置注入状态。
               */
              // 只有"手里这份缓存属于别的集"时才丢
              if (pgcCachedForCid && cidNow && pgcCachedForCid !== cidNow) {
                pgcCachedVideoInfo = null;
                pgcCachedForCid = '';
              }
              pgcPatchedCid = cidNow;
              pgcPatched = false;
            }
            if (!pgcCachedVideoInfo) {
              var ssCid = pgcCidOf(v) || '';
              pgcTrace.ssAt = performance.now ? Math.round(performance.now()) : -1;
              pgcTrace.ssCid = ssCid;
              pgcTrace.ssHit = false;
              pgcTrace.ssErr = '';
              try {
                pgcCachedVideoInfo = pgcReadCacheSync(ssCid);
              } catch (e) {
                pgcTrace.ssErr = e && e.message ? String(e.message).slice(0, 60) : 'throw';
              }
              pgcTrace.ssHit = !!pgcCachedVideoInfo;
              if (pgcCachedVideoInfo) pgcCachedForCid = ssCid;
              pgcPost(
                'ss',
                'cid=' +
                  ssCid +
                  ' hit=' +
                  String(pgcTrace.ssHit) +
                  ' t=' +
                  pgcTrace.ssAt +
                  (pgcTrace.ssErr ? ' err=' + pgcTrace.ssErr : ''),
              );
            }
            /**
             * ⚠️ **这里不能判 `enabled`**（2026-10-28 真机踩到）。
             *
             * `enabled` 由 `cfg` 下发，而 `cfg` 要等 ISOLATED 侧拿到消息再发出 ——
             * 在 `__playinfo__` 赋值那一刻（409ms）通常**还没到**。
             * 之前写成 `if (enabled) pgcPatchPlayinfo(v)`，于是注入永远不执行，
             * 而且 `enabled` 是 false 时**不会报错**，表现为"什么都没发生"。
             *
             * 现在改用**缓存在不在**做判据：
             *   - 缓存存在 = 之前那一趟已经确认"这集需要且能拿到完整流"
             *     （写缓存的动作本身已经在 `prepareFullStream` 里做过了总开关/权益判定）
             *   - `sessionStorage` 只在同标签页存活，关掉就没了，不存在"陈旧残留"
             *
             * 而 `pgcActive === false`（明确没装规则）仍然拦住 —— 那个是"用户关了开关"，
             * 只在 `cfg` 到达后才会被置位，属于**收紧**而不是放宽。
             */
            pgcPatchPlayinfo(v);
          }
        },
      });
      window.__PLUMA_PLAYINFO_HOOK__ = true;
      defineResult = 'ok';
    } catch (e) {
      defineResult = 'fail:' + (e && e.message ? String(e.message).slice(0, 40) : 'unknown');
    }
  }

  function playinfoState() {
    var v;
    try {
      v = window.__playinfo__;
    } catch (e) {
      return 'throw';
    }
    if (v === undefined) return 'hidden-or-empty';
    if (v === null) return 'null';
    return 'present:' + typeof v;
  }

  // ── 1b. PGC（番剧 / 国创 / 电影）：把缓存里的完整流塞进 `__playinfo__`（ADR 0020） ──
  //
  // ## 为什么需要这一套（和 /video 页完全相反）
  //
  // PGC 页的取流结果由服务端写进 HTML（`playurlSSRData`），页面**零请求**，
  // DNR 改的是请求头 → 没有可改的对象（ADR 0007）。
  // 所以 `/video` 那套"藏起 `__playinfo__` 逼播放器发请求"在这里**必须反过来**：数据要保留。
  //
  // ## 为什么不是"hook createPlayer 换回调"（ADR 0019 已被推翻）
  //
  // 2026-10-28 真机实测三条，把那条路彻底否掉了：
  //
  //   1. 用页面自己的容器 + 完整集数据建播放器，`reqHttpPlayUrlInfo` **一次都没被调用**
  //      （`cbCalled: 0`），`duration` 仍是 360。
  //   2. Proxy 记录属性访问：播放器只 `get prefetch` / `get requestConfig`，
  //      **一次都没读 `.playUrl`**，而且有 `Symbol.toStringTag` 访问 ——
  //      说明它在做 `Object.prototype.toString` 这类类型判断。
  //   3. PGC 的 `video_info` 里**根本没有 `dash`**（只有 `durl` / `durls`、`type: 3`），
  //      是纯 durl 流水线，那个回调只是装饰（返回 SSR 常量）。
  //
  // 而 `createPlayer` 在 `__playinfo__` 赋值后 0~2ms 就调用了（实测 407/409/409ms），
  // 接口来不及返回。所以唯一能让播放器拿到完整流的办法是：
  // **下一次加载时它已经在手边** → 缓存 + 二次加载。
  //
  // ## 现在的链路
  //
  //   第一趟：页面正常播试看；ISOLATED 侧取完整流 → 写缓存 → reload
  //   第二趟：ISOLATED 侧预读缓存 → 通过 `cfg` 下发 → 这里在 `__playinfo__` 的
  //          setter 里**同步**把 `result.video_info` 换成完整集的那份
  //
  // 「同步」是硬要求：setter 在 SSR 内联脚本赋值那一刻执行，之后 0~2ms 播放器就来读了。

  /** 页面侧可读的埋点快照（无凭据，仅供排查） */
  var pgcTrace = {
    bootAt: -1,
    patchedAt: -1,
    cacheBytes: 0,
    lastStage: '',
    /**
     * 同步读 `sessionStorage` 的结果（2026-10-28 加，用于定位"新标签页同步读不到"）。
     *
     * - `ssAt`：调用时刻（相对 performance.now）
     * - `ssCid`：当时解析出的 cid（空 = 没拿到 cid，读不了）
     * - `ssHit`：有没有读到（`true` / `false`）
     * - `ssErr`：抛错信息（`sessionStorage` 在 `document_start` 可能不可用）
     */
    ssAt: -1,
    ssCid: '',
    ssHit: false,
    ssErr: '',
  };

  if (IS_PGC) {
    pgcTrace.bootAt = performance.now ? Math.round(performance.now()) : -1;
    pgcTrace.lastStage = 'boot';
    window.__PLUMA_PGC__ = pgcTrace;
  }

  function pgcPost(stage, detail) {
    safePost({ __ns: NS, type: 'pgc', token: token, stage: stage, detail: detail });
  }

  /**
   * 把 PGC 的「试看」标记改写成「完整」（ADR 0021）。
   *
   * ## 为什么必须改（实测，两个方向相反的实验合起来才说明）
   *
   * | 实验 | 改了什么 | 结果 |
   * | --- | --- | --- |
   * | `probe-pgc-is-preview.cjs` | 只改字段、不换流 | `video.duration` 仍是 360 |
   * | P2 真机 | 只换流、不改字段 | **播到 361 秒被拦并弹窗** |
   *
   * → 换流解决"能不能播"，改字段解决"播到哪儿停"。两件都要做。
   *
   * 361 秒是 SSR 的 `durls` 长度（4 组 × 360082ms）—— 播放器按 `play_detail: "PLAY_PREVIEW"`
   * 在试看结束点主动暂停，与"流多长"无关。而现在流已经是 1440 秒的了。
   *
   * ## 为什么这不是伪造服务端权益
   *
   * 流由 `/pgc/player/web/playurl` 发出，Cookie 被 DNR 换成**播放账号**的 ——
   * 是它自己的大会员权益换来的，服务端一点没被骗。
   * 改的这三个字段只影响**播放器本地**"要不要在 361 秒处暂停"，不产生任何取流能力。
   *
   * 所以**只改描述"这份数据"的标记，不碰描述"这个账号"的字段**：
   * `user_status`（`has_paid` / `vip_info`）/ `supplement` / `arc` / `watch_progress` 一律不动。
   * 边界与 [ADR 0013] 同类，同样由 `scripts/check-patch-scope.mjs` 卡死。
   */
  function pgcPatchPreviewFlags(r) {
    if (!r || typeof r !== 'object') return 0;
    var changed = 0;

    if (r.play_video_type === 'preview') {
      r.play_video_type = PGC_PREVIEW_FLAGS.play_video_type;
      changed += 1;
    }
    var pc = r.play_check;
    if (pc && typeof pc === 'object' && pc.play_detail === 'PLAY_PREVIEW') {
      pc.play_detail = PGC_PREVIEW_FLAGS['play_check.play_detail'];
      changed += 1;
    }
    var vi = r.video_info;
    if (vi && typeof vi === 'object' && vi.is_preview === true) {
      vi.is_preview = PGC_PREVIEW_FLAGS['video_info.is_preview'];
      changed += 1;
    }
    return changed;
  }

  /**
   * 把缓存里的完整流塞进 `__playinfo__` 的那份 `result`。
   *
   * ## 为什么在这里合并而不直接赋值
   *
   * SSR 骨架里除了 `video_info` 还有 `arc` / `play_check` / `watch_progress` /
   * `user_status` —— 播放器全都要用。只换 `video_info` 里的**流字段**，
   * 其余原样保留（字段白名单在 `src/core/playinfo/pgc-merge.ts`，这里做同样的裁剪）。
   *
   * ## 顺带改写试看标记
   *
   * 见 `pgcPatchPreviewFlags`（ADR 0021）—— 只换流不够，播放器会在 361 秒处停。
   */
  function pgcPatchPlayinfo(v) {
    if (pgcPatched || !pgcCachedVideoInfo) return;
    // 没装规则（未配置 / 总开关关 / 同账号）时不该注入：
    // 那种情况下这个缓存也未必对得上当前账号权益
    if (pgcActive === false) return;
    var inner = v && v.result ? v : v && v.data && v.data.result ? v.data : null;
    if (!inner || !inner.result) return;

    var r = inner.result;
    var base = r.video_info && typeof r.video_info === 'object' ? r.video_info : {};
    var next = Object.assign({}, base);

    // 白名单：与 core/playinfo/pgc-merge.ts 的 STREAM_FIELDS 一致
    var keys = [
      'quality',
      'timelength',
      'format',
      'dash',
      'durl',
      'durls',
      'accept_quality',
      'accept_description',
      'support_formats',
      'video_codecid',
      'fnval',
    ];
    var moved = 0;
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      // 空数组不算"有流"：接口偶尔返回 `durls: []`，搬过去等于把流清空
      if (Array.isArray(pgcCachedVideoInfo[k]) && pgcCachedVideoInfo[k].length === 0) continue;
      if (pgcCachedVideoInfo[k] === undefined || pgcCachedVideoInfo[k] === null) continue;
      next[k] = pgcCachedVideoInfo[k];
      moved += 1;
    }

    /**
     * 一个**流字段**都没搬过来 → 不动原数据。
     *
     * ⚠️ 判据是"有没有流"，不是"搬到了几个字段"：缓存里可能只有
     * `quality` / `timelength` 这类元信息（比如存的时候拿的是无权益响应），
     * 那种补丁看着改了、其实没流，播放器拿到反而可能播不了。
     * 宁可播试看，不要黑屏。
     */
    var hasStream = false;
    if (next.dash && typeof next.dash === 'object') {
      var dv = next.dash.video;
      if (Array.isArray(dv) && dv.length > 0) hasStream = true;
    }
    if (!hasStream && Array.isArray(next.durl) && next.durl.length > 0) hasStream = true;
    if (!hasStream && Array.isArray(next.durls)) {
      for (var j = 0; j < next.durls.length; j += 1) {
        var g = next.durls[j];
        if (g && Array.isArray(g.durl) && g.durl.length > 0) {
          hasStream = true;
          break;
        }
      }
    }
    if (!hasStream) {
      pgcPost('error', '缓存里没有可用的流字段（' + moved + ' 个元信息），放弃注入');
      return;
    }

    /**
     * ⚠️ **有 dash 时必须把 `durl` / `durls` 删掉**（2026-10-28 真机定位，最关键的一条）。
     *
     * 现象：注入后 `dash.duration = 1441` 是对的，但 `<video>.duration` 仍是 360、
     * `currentSrc` 指向 `.../281989571-1-4...`（**durl 的地址**）、
     * 把 `currentTime` 设到 600 会被夹回 360。
     *
     * 结论：**播放器在 `durl` 存在时优先走 durl**，SSR 那份 360 秒的试看 durl 一直在，
     * 我们注入的 dash 就从来没被用过。所谓"6 分 01 秒被拦"根本不是被字段拦截，
     * 是**流真的只有 360 秒**（SSR durl 的长度）。
     *
     * 所以：给了 dash 就把 durl 抹掉，强制播放器走 dash。
     * 反之（缓存里只有 durl、没有 dash）才保留 durl。
     */
    var nextHasDash =
      next.dash && typeof next.dash === 'object' && next.dash.video && next.dash.video.length > 0;
    if (nextHasDash) {
      delete next.durl;
      delete next.durls;
    }

    r.video_info = next;
    // 试看标记（ADR 0021）—— 只换流不够，播放器会在 361 秒处主动停
    var flags = pgcPatchPreviewFlags(r);
    pgcPatched = true;
    pgcTrace.patchedAt = performance.now ? Math.round(performance.now()) : -1;
    pgcTrace.lastStage = 'patched';
    var timelength = next.timelength || 0;
    pgcPost(
      'patch',
      '已注入缓存流：字段=' + moved + ' 试看标记=' + flags + ' 时长=' + timelength,
    );

    /**
     * 隐藏「试看中」提示条（ADR 0022）。
     *
     * ⚠️ **必须放在注入成功之后**：ADR 0022 的三条边界里，
     * "真的注入了完整流"是其中一条。没注入就藏，用户会以为能看、
     * 实际还是 6 分钟 —— 那比显示提示更难排查。
     */
    pgcHidePreviewToast();
  }

  // ── 2. 会员状态伪装：**绝不接管 __INITIAL_STATE__** ──
  //
  // ## 血泪教训：不能用 defineProperty 替换它
  //
  // `window.__INITIAL_STATE__` 是 B站整棵页面数据树（视频信息、推荐列表、
  // 评论区、用户状态全在里面）。我先后试过两种"接管"写法，**都错了**：
  //
  //   1. `var v = undefined` 再 defineProperty → 直接把数据清空，
  //      于是标题/简介（SSR 静态 HTML）还在，视频/推荐/评论（依赖这棵树）全空
  //   2. 先接住原值再 defineProperty → 数据保住了，但仍然脆：
  //      SSR 可能在我们之后才赋值，且访问器属性会改变页面对它的假设
  //
  // **参考实现（Bili Dual）根本不碰这个变量**：它直接读 `window.__INITIAL_STATE__`，
  // 原地改 `user.vipStatus` 这类字段，用短轮询兜住时序。这就是它没这个问题的原因。
  //
  // ## 为什么这里可以用轮询
  //
  // 之前把 setInterval 当成"后台卡死"的元凶，那条结论是**错的**（真正的元凶是
  // SourceBuffer 监听器泄漏和 `__INITIAL_STATE__` 被清空）。轮询本身开销极小：
  // 只读一个对象引用 + 几个数字字段，命中就跳过。
  //
  // 但为控制开销，轮询只在 enabled 时跑，并在几次成功后就停：
  // 会员状态一旦写上就不会被页面改回去，没必要一直跑。
  var ssPatched = false;
  var ssTimer = null;
  var ssTicks = 0;

  /** 轮询上限：120 次 × 100ms = 12 秒，足够覆盖播放器初始化 */
  var SS_MAX_TICKS = 120;

  function patchSsUser() {
    try {
      var s = window.__INITIAL_STATE__;
      if (!s || !s.user || typeof s.user !== 'object') return false;

      if (typeof s.user.vipStatus === 'number' && s.user.vipStatus !== 1) s.user.vipStatus = 1;
      if (typeof s.user.vipType === 'number' && s.user.vipType !== 2) s.user.vipType = 2;

      if (s.user.vip && typeof s.user.vip === 'object') {
        if (typeof s.user.vip.status === 'number' && s.user.vip.status !== 1) s.user.vip.status = 1;
        if (typeof s.user.vip.type === 'number' && s.user.vip.type !== 2) s.user.vip.type = 2;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function startSsPatch() {
    if (ssTimer !== null) return;
    ssTicks = 0;
    ssTimer = setInterval(function () {
      ssTicks += 1;

      // 关掉开关就停
      if (!enabled) {
        stopSsPatch();
        return;
      }

      if (patchSsUser()) ssPatched = true;

      // 已经改过且超过上限 → 停。避免无限轮询
      if (ssTicks >= SS_MAX_TICKS) stopSsPatch();
    }, 100);

    // 立刻来一发，别等第一个 100ms
    if (patchSsUser()) ssPatched = true;
  }

  function stopSsPatch() {
    if (ssTimer !== null) {
      clearInterval(ssTimer);
      ssTimer = null;
    }
  }

  /** 兼容：拿到配置后决定要不要开始轮询 */
  function syncHooks() {
    /**
     * ⚠️ **PGC 页永远不藏 `__playinfo__`。**
     *
     * `/video` 页藏它是为了逼播放器发 playurl（好让 DNR 有请求可改）；
     * PGC 页的播放器**只吃 SSR 数据**，藏了就等于把流藏了，直接黑屏。
     */
    playinfoHidden = enabled && !IS_PGC;
    if (enabled) startSsPatch();
    else stopSsPatch();
  }

  // ── 3. 观测 + 响应改写 ──
  // 3a. 记录页面是否真的发出了 playurl 请求（只记录不拦截）
  // 3b. 改写「播放器信息」接口的响应，把会员状态改成会员
  //
  // 为什么必须改写响应（参考 Bili Dual Account Helper）：
  // DNR 只能改**请求头**，改不了**响应体**。
  // 播放器切换画质时读 /x/player/wbi/v2（或旧版 /x/player/v2）的响应，
  // 里面带 vip 字段。主账号不是会员 → 播放器判定无权限 → 弹「开通大会员」。
  // 所以必须在这一层把 vip 字段伪装掉。

  /**
   * 需要改写响应的路径（含会员状态的接口）。
   *
   * ## ⚠️ `/x/web-interface/nav` 必须在列表里
   *
   * 这是对着参考实现（Bili Dual）逐项核对出来的遗漏。之前只有
   * `/x/player/wbi/v2` 和 `/x/player/v2`，漏了 `nav`——
   * 而 `nav` 是**账号信息接口**，返回 `vipStatus` / `vipType`。
   * 播放器（以及 B站前端其它模块）会读它来判断当前身份有没有会员权限。
   *
   * 漏掉它的后果就是用户报的那个：**切高清 / 开 Hi-Res 时弹充值页**。
   *
   * 参考实现的列表（`/x/web-interface/nav`、`/x/player/wbi/v2`、`/x/player/v2`、
   * 以及几个番剧接口）在这里取前三个 —— 番剧 v1 不支持（ADR 0007），不列。
   */
  var PATCH_PATHS = ['/x/web-interface/nav', '/x/player/wbi/v2', '/x/player/v2'];

  /**
   * 允许改写**观看进度字段**的路径（ADR 0017）。
   *
   * ⚠️ 与 `PATCH_PATHS` 是两件不同的事，**别合并、别互相顶替**：
   *
   *   - `PATCH_PATHS`      → 把会员字段伪装成"已开通"（ADR 0013 授权）
   *   - `PROGRESS_PATCH_PATHS` → 只把 `last_play_time` / `last_play_cid`
   *                             还原成**主账号自己的**观看进度（ADR 0017）
   *
   * 后者不伪装任何权益，改的是"这个浏览器用户本来就有的数据"。
   * 但它在**响应体**上动手，风险等级和前者同级，所以同样要 ADR 兜着，
   * 并由 `scripts/check-patch-scope.mjs` 校验两边一致。
   */
  var PROGRESS_PATCH_PATHS = ['/x/player/wbi/playurl', '/x/player/playurl'];

  /**
   * 允许改写的主机白名单。
   *
   * 参考实现用的是数组 + `indexOf`，理由是同路径可能出现在别的域上，
   * 写死单个域名会漏。这里保留数组形式，方便以后加 `api.live.bilibili.com`。
   */
  var PATCH_HOSTS = ['api.bilibili.com'];

  function matchPath(url, list) {
    try {
      var u = new URL(url, location.href);
      if (u.protocol !== 'https:') return false;
      if (PATCH_HOSTS.indexOf(u.hostname) === -1) return false;
      for (var i = 0; i < list.length; i++) {
        if (u.pathname === list[i]) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /** 是不是取流接口（精确 pathname 匹配，不用正则，避免误匹配 `/playurlXxx`） */
  function isPlayurlPath(url) {
    return matchPath(url, PROGRESS_PATCH_PATHS);
  }

  function looksLikeVip(obj) {
    return (
      !!obj &&
      typeof obj === 'object' &&
      (typeof obj.status === 'number' || typeof obj.type === 'number' || typeof obj.due_date === 'number')
    );
  }

  function patchVipObj(v) {
    if (typeof v.status === 'number' && v.status !== 1) v.status = 1;
    if (typeof v.type === 'number' && v.type !== 2) v.type = 2;
    if (typeof v.due_date === 'number') v.due_date = 4102444800000; // 2100-01-01
  }

  function patchVipScoped(o) {
    if (Array.isArray(o)) {
      for (var i = 0; i < o.length; i++) patchVipScoped(o[i]);
      return;
    }
    if (!o || typeof o !== 'object') return;

    if (typeof o.vipStatus === 'number' && o.vipStatus !== 1) o.vipStatus = 1;
    if (typeof o.vipType === 'number' && o.vipType !== 2) o.vipType = 2;

    if (looksLikeVip(o.vip)) patchVipObj(o.vip);
    if (looksLikeVip(o.vip_info)) patchVipObj(o.vip_info);

    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      if (k === 'vip' || k === 'vip_info') continue;
      if (o[k] && typeof o[k] === 'object') patchVipScoped(o[k]);
    }
  }

  /** 改写响应文本；解析失败就原样返回 */
  function patchResponseText(url, text) {
    if (!enabled || !matchPath(url, PATCH_PATHS)) return text;
    try {
      var o = JSON.parse(text);
      if (!o || typeof o !== 'object') return text;
      patchVipScoped(o);
      return JSON.stringify(o);
    } catch (e) {
      return text;
    }
  }

  /** 报告一次响应改写（诊断用，去重避免刷屏） */
  var patchReported = {};
  function reportPatch(url, ok) {
    try {
      var path = new URL(url).pathname;
      if (patchReported[path]) return;
      patchReported[path] = 1;
      safePost({ __ns: NS, type: 'patch', token: token, path: path, ok: ok },
        '*',);
    } catch (e) {}
  }

  // ── 4. HDR 检测 ──

  /**
   * PGC 页可改写的「试看」标记 → 改写值（ADR 0021 授权）。
   *
   * ⚠️ **与上面两份清单并列，不许合并**。三份清单授权的是三类不同的事：
   *
   * | 常量 | 授权 | 改的是什么 |
   * | --- | --- | --- |
   * | `PATCH_PATHS` | ADR 0013 | 会员字段伪装（让画质菜单不弹充值页） |
   * | `PROGRESS_PATCH_PATHS` | ADR 0017 | 观看进度还原（用户本来就有的数据） |
   * | `PGC_PREVIEW_FLAGS` | ADR 0021 | 这份播放数据是不是"试看"（让播放器不在 361 秒处停） |
   *
   * 第三份**只描述"这份数据"，不描述"这个账号"** ——
   * `user_status.has_paid` / `vip_info` 一律不动，那是服务端对账号权益的陈述。
   *
   * 字段名是 `a.b.c` 形式的路径，方便 `check-patch-scope.mjs` 逐条比对。
   */
  var PGC_PREVIEW_FLAGS = {
    play_video_type: 'whole',
    'play_check.play_detail': 'PLAY_WHOLE',
    'video_info.is_preview': false,
  };

  /**
   * PGC 页「试看中」提示条的选择器（ADR 0022 授权）。
   *
   * ## ⚠️ 必须藏 `.bpx-player-toast-item`，不是它的子节点（2026-10-28 真机 dump 纠正）
   *
   * 实测的完整层级（`ep341216`，逐层读 `getBoundingClientRect` + `backgroundColor`）：
   *
   * ```
   * .bpx-player-toast-wrap                 透明        (43,386) 32×33
   *   └ .bpx-player-toast-row.bpx-player-toast-un
   *       └ .bpx-player-toast-item          ★ 黑底在这里   rgba(25,25,25,0.88)
   *           └ .bpx-player-toast-text      透明（只有文字）
   *               └ div
   *                   └ .PromptBar_container__dxyIw   透明
   *                       ├ .PromptBar_title      「本片是大会员专享内容」
   *                       ├ .PromptBar_subtitle   「试看中·成为大会员免费看本片」
   *                       └ .PromptBar_btnItemWrap「成为大会员」
   * ```
   *
   * 两次都藏错了层：
   *   - 第一版藏 `.bpx-player-toast-text` → **黑底还在**（它在更外一层 `.toast-item` 上）
   *   - 而且会把「跳过片头/片尾」一起藏掉 —— 两者共用 `.bpx-player-toast-item`
   *
   * ## 所以策略是「只藏含 PromptBar 的那几个 item」
   *
   * `.bpx-player-toast-item` 是**逐条消息**的容器，「跳过片头」也会生成自己的 item。
   * 遍历所有 item，**只藏内部含 `[class*="PromptBar"]` 的那些** ——
   * 跳过片头的 item 里没有 PromptBar，天然不被碰。
   *
   * 这一点很重要：用户明确说过"某些集的片头片尾会提前/延后，有些集根本没有"。
   * 也就是说"有跳过按钮"和"有试看提示"是**两个独立条件**，不能用同一个选择器。
   *
   * 用属性前缀匹配（`[class*="PromptBar"]`）而不是全名，
   * 因为 `PromptBar_container__dxyIw` 后半段是 CSS Modules 的哈希，随时会变。
   *
   * ## ADR 0022 的三条边界（不变）
   *   1. 只在 PGC 页
   *   2. 只在**真的注入了完整流之后**
   *   3. 不扩大到其它 `.bpx-player-*` 层
   *
   * **不动 `user_status.has_paid`** —— 那仍是服务端事实，改它是纯谎报。
   */
  var PGC_TOAST_ITEM = ['.bpx-player-toast-item'];

  /** item 里出现这个标记 = 它是「试看提示」，才该藏 */
  var PGC_TOAST_MARK = '[class*="PromptBar"]';

  /**
   * 隐藏 PGC 的「试看中」提示条（连黑底一起）。
   *
   * ## 为什么用 MutationObserver
   *
   * 播放器按需渲染：切画质、暂停、重新起播都会重建 DOM，一次性隐藏会失效。
   *
   * ## 为什么用内联样式而不是 `<style>`
   *
   * 第一版注入 `<style>` 时，选择器一旦放宽就会波及同一层的其它内容。
   * 内联样式只作用于**当场查出来的那个节点**，天然不会误伤兄弟。
   *
   * ## 为什么不用 `remove()` 而是 `display:none`
   *
   * 播放器可能持有节点引用并在上面读尺寸/做动画；直接移除会让它拿到 `null`
   * 而抛错（表现为播放卡住）。隐藏是更保守的做法。
   */
  function pgcHidePreviewToast() {
    if (!PGC_TOAST_ITEM.length || !PGC_TOAST_MARK) return;
    var itemSel = PGC_TOAST_ITEM.join(',');

    var kill = function () {
      var items = document.querySelectorAll(itemSel);
      var hit = 0;
      for (var i = 0; i < items.length; i += 1) {
        var el = items[i];
        // 只处理"含试看提示"的那几条 —— 跳过片头没有这个标记，不会被碰
        if (!el.querySelector(PGC_TOAST_MARK)) continue;
        if (el.style.display !== 'none') el.style.display = 'none';
        hit += 1;
      }
      return hit;
    };

    try {
      var n = kill();
      if (!pgcToastObserver && typeof MutationObserver === 'function') {
        pgcToastObserver = new MutationObserver(function () {
          kill();
        });
        pgcToastObserver.observe(document.documentElement, { childList: true, subtree: true });
      }
      if (n > 0) pgcPost('toast', '已隐藏试看提示条 ' + n + ' 条（' + itemSel + ' + ' + PGC_TOAST_MARK + '）');
    } catch (e) {
      pgcPost('error', '隐藏试看提示失败：' + (e && e.message ? e.message.slice(0, 60) : '?'));
    }
  }

  /** 只挂一个观察器（重复调 `pgcHidePreviewToast` 不会叠加） */
  var pgcToastObserver = null;


  // ── 4. HDR 检测 ──
  // B站的 playurl 响应**不返回 HDR 元数据**（hdr / colorPrimaries 全是 null），
  // 所以没法从接口判断当前是不是 HDR 轨道。
  // HDR 信息只存在于视频文件（fMP4）自身的元数据里，由浏览器解码时读取。
  //
  // 能直接观测的只有媒体查询：
  //   (dynamic-range: high)        → 当前**显示链路**是否 HDR（屏幕 + 系统 + 浏览器）
  //   (video-dynamic-range: high)  → 当前**视频播放通道**是否以 HDR 呈现
  //
  // 两个都为 high，说明浏览器确实把 HDR 内容当作 HDR 输出，
  // 而不是在 SDR 容器里做了色调映射（后者画面会发灰）。

  function hdrReport() {
    var out = { display: '?', video: '?', videoWidth: 0, videoHeight: 0 };
    try {
      out.display = window.matchMedia('(dynamic-range: high)').matches ? 'high' : 'standard';
    } catch (e) {}
    try {
      out.video = window.matchMedia('(video-dynamic-range: high)').matches ? 'high' : 'standard';
    } catch (e) {}
    try {
      var v = document.querySelector('video');
      if (v) {
        out.videoWidth = v.videoWidth;
        out.videoHeight = v.videoHeight;
      }
    } catch (e) {}
    return out;
  }

  /**
   * 从一组 SourceBuffer 记录里挑出「当前在用」的那一条。
   *
   * ## 判据：**创建顺序**，不是「多久没写入」
   *
   * 踩过三轮的 bug：Hi-Res 徽章闪一下就消失、过一会儿再现、甚至不再出现。
   *
   * 根因不在阈值大小，而在**判据本身错了**。
   *
   * 原来的实现用 `lastUpdate`（最近一次 updateend 的时刻）推断「谁在播」：
   * 3 秒内没写入就算「轨已死」。但实测（用户日志，视频 BV1jt421t7XH）：
   *
   * ```
   * 14:17:05 音轨装载成功: flac
   * 14:17:09 轨道明细 音频[flac(0.1s前)]
   * 14:17:18 轨道明细 音频[flac(5.1s前)]   ← 5.1 秒没写入
   * ```
   *
   * 音频写入间隔是 **4 秒、9 秒**。这不是「轨死了」，而是**缓冲填满后的正常停顿**——
   * 播放器把缓冲灌到阈值就不再写，等播放消耗到水位才补。
   * 于是 3 秒窗口把正常停顿判成死轨 → 返回 `'?'` → Hi-Res 消失 → 下次写入又出现。
   * 这就是「闪烁」。
   *
   * 把窗口从 3 秒调到 15 秒只是**赌一个更大的数**，仍然会在
   * 「缓冲特别长」或「30 秒后不再上报」时失效。判据本身是错的，调参治不好。
   *
   * ## 正确的判据
   *
   * B站播放器每次切画质 / 切音轨都会**新建一个 SourceBuffer**，
   * 由 `trackSourceBuffer` 追加到数组尾部（淘汰时 `shift()` 删的是最旧的）。
   * 所以**数组最后一个元素，就是播放器最新创建的那条轨**。
   *
   * 编码在 `addSourceBuffer` 时就固定了，播放过程中不会变；
   * 而「多久没写入」与「是不是当前轨」根本无关。按创建顺序判断：
   *   - 不受缓冲停顿影响（5 秒不写也还是它）
   *   - 切轨后立刻反映新编码（不等新轨写第一个字节）
   *   - 不需要任何时间常量，没有可以调错的参数
   *
   * ## 一个反直觉但必须坚持的点
   *
   * **不能**写成「取最近写入的那条」。切到 AAC 的瞬间新轨还没灌数据
   * （`lastUpdate` 为 0），旧 FLAC 的 `lastUpdate` 反而更新，
   * 那样会选回旧 FLAC → 误报 Hi-Res。这个错误被
   * `tests/unit/content/main-world-real.test.ts` 的用例钉住了。
   */
  function pickActive(list) {
    if (!list || !list.length) return null;
    return list[list.length - 1];
  }

  /** 统计各类 SourceBuffer 的活跃数量（诊断用） */
  function sbStats(list) {
    // 只看最后两条：更早的都是历史遗留，不代表当前状态。
    // `active > 1` 说明切轨时旧轨还没被销毁，切换是"叠加"而非"替换"。
    var start = list.length > 2 ? list.length - 2 : 0;
    var active = 0;
    for (var i = start; i < list.length; i++) {
      if (list[i].lastUpdate) active += 1;
    }
    return { total: list.length, active: active };
  }

  /**
   * 列出所有活跃轨道及其写入时间差。
   *
   * 用途：切音质时如果出现「音频2/2」，说明旧轨没被销毁、两条都在写。
   *
   * ⚠️ 这里的时间差**只用于诊断**，不参与判定当前轨。
   * 当前轨由 `pickActive` 按创建顺序决定——"多久没写入"与"是不是在用"
   * 无关（缓冲填满后停止写入是正常状态）。
   */
  function sbDetail(list) {
    var now = Date.now();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (!x.lastUpdate) {
        out.push(x.codec + '(未写入)');
        continue;
      }
      var ago = Math.round((now - x.lastUpdate) / 100) / 10;
      out.push(x.codec + '(' + ago + 's前)');
    }
    return out.join(' , ');
  }

  /** 播放稳定后上报一次完整的 HDR / 音频 / 编码状态 */
  function reportHdrAfter(delayMs) {
    setTimeout(reportHdrNow, delayMs);
  }

  /**
   * 立刻上报一次完整状态。
   *
   * ## 为什么需要"立刻"这个入口
   *
   * 原来只有 6s / 15s / 30s 三次固定快照，**30 秒后就再也不报**。
   * 于是：
   *   - 用户在第 31 秒切画质 → 角标永远停在旧画质
   *   - 用户先看 1080P 再切 8K → 角标一直显示 1080P
   *
   * 现在由 `watchPlaybackChanges()` 在**播放器自己恰发的事件**上调用它，
   * 事件驱动比轮询可靠：切画质时 `resize` 必派发，不会漏。
   *
   * ⚠️ 内部全包 try —— 上报失败绝不能影响播放。
   */
  function reportHdrNow() {
    try {
      reportHdrNowUnsafe();
    } catch (e) {}
  }

  function reportHdrNowUnsafe() {
    {
      var r = hdrReport();
      var act = activeCodec();
      var audio = activeAudioCodec();
      safePost({
          __ns: NS,
          type: 'hdr',
          token: token,
          // display = 显示设备是否 HDR；video = 视频通道是否以 HDR 呈现
          // 两者含义不同，必须都传上去，由角标侧组合判断
          display: r.display,
          video: r.video,
          w: r.videoWidth,
          h: r.videoHeight,
          codec: act,
          family: codecFamily(act),
          profile: hevcProfile(act),
          canDecode: act === '?' ? '?' : decodeSupport('video/mp4;codecs="' + act + '"'),
          audio: audio,
          audioFamily: audioFamily(audio),
          canPlayAudio: audio === '?' ? '?' : decodeSupport('audio/mp4;codecs="' + audio + '"'),
          // 当前视频/音频轨道编号，用于判断"画质和音质有没有配对成功"
          videoTrackId: activeVideoTrackId(),
          audioTrackId: activeAudioTrackId(),
          // 当前轨道的实际帧率（0 = 未知）。来源是 playurl 的 frame_rate
          frameRate: resolveHighFrameRate(r.videoHeight),

          // SourceBuffer 统计：active > 1 说明旧轨没被删，切换是"叠加"而非"替换"
          vsb: sbStats(videoSbs),
          asb: sbStats(audioSbs),
          // 逐条列出活跃轨与最后写入时间差
          vDetail: sbDetail(videoSbs),
          aDetail: sbDetail(audioSbs),
        });
    }
  }

  /**
   * 记录 SourceBuffer 与轨道 id 的对应关系。
   *
   * 为什么需要：B站的音视频轨是**配对**的——
   * 杜比视界视频轨可能只配 AAC，不配 FLAC。
   * 光看"最终音频是 AAC"会误判成失败，实际是这条视频轨本来就不带 FLAC。
   */
  var sbTrackMap = [];

  function noteSbCreated(mime, trackId) {
    if (trackId == null) return;
    sbTrackMap.push({ mime: mime, id: trackId, video: mime.indexOf('video/') === 0 });
    // 上限保护：只用来判断"当前活跃轨是哪条"，保留最近若干条足够
    while (sbTrackMap.length > 16) sbTrackMap.shift();
  }

  function activeVideoTrackId() {
    for (var i = sbTrackMap.length - 1; i >= 0; i--) {
      if (sbTrackMap[i].video) return sbTrackMap[i].id;
    }
    return '?';
  }

  function activeAudioTrackId() {
    for (var i = sbTrackMap.length - 1; i >= 0; i--) {
      if (!sbTrackMap[i].video) return sbTrackMap[i].id;
    }
    return '?';
  }

  // 页面加载完、以及用户可能切画质后的几个时间点各报一次
  // 初始的几次固定快照（播放器还没起来时先兜一下）
  reportHdrAfter(6000);
  reportHdrAfter(15000);
  reportHdrAfter(30000);

  // ── 事件驱动的实时更新（切画质必须立刻反映到角标） ──
  //
  // ## 为什么不能只靠固定快照
  //
  // 原来只有上面三次，30 秒后就再也不报。用户在第 31 秒切画质，
  // 角标就永远停在旧画质——这是用户明确报过的 bug。
  //
  // ## 为什么用事件而不是轮询
  //
  // 轮询会漏中间态：切画质时 `videoHeight` 可能先变 0 再变新值，
  // 2 秒一次很可能正好错过，或者在两个值之间反复横跳。
  //
  // 下面三个事件都是**播放器自己触发的**，不会漏：
  //   - `loadedmetadata`：首次拿到视频尺寸
  //   - `resize`：切到不同分辨率时浏览器必派发，最可靠
  //   - `playing`：恢复播放（含从后台回来）
  //
  // 另外 SourceBuffer 的 `updateend` 也顺手触发一次上报，
  // 兜住"分辨率相同但换了编码"的情况（4K AV1 → 4K HEVC）。
  var lastReportKey = '';

  /**
   * 去重：状态没变就不要重复上报，避免刷屏。
   *
   * ## 去重 key 必须只用**稳定的**值
   *
   * 踩过的 bug：角标在「已接管」和正常画质之间乱跳。
   *
   * 原因：key 里含 `activeCodec()` / `activeAudioCodec()`，
   * 而它们在切画质瞬间会在新旧轨之间来回切（新旧轨交接时都有写入）。
   * key 一变就重算，重算的结果又在两个值之间摆 → 角标抖动。
   *
   * 修法：
   *   - key **只用分辨率**（视频尺寸），它是稳定的、不抖的
   *   - 高度为 0 时（切轨瞬间）**直接跳过上报**，不制造抖动样本
   *
   * 编码/音轨的变化由 `hdrReport` 自己带出去，
   * 不需要靠 key 触发——分辨率变化是这个场景里唯一可靠的触发器。
   */
  function reportIfChanged() {
    try {
      var r = hdrReport();

      // 高度为 0 = 播放器正在换轨，此刻的数据不可信，跳过
      if (!r.videoHeight) return;

      var key = String(r.videoHeight);
      if (key === lastReportKey) return;
      lastReportKey = key;
      reportHdrNow();
    } catch (e) {}
  }

  function watchPlaybackChanges() {
    try {
      var v = document.querySelector('video');
      if (!v) {
        // video 元素还没出来，稍后重试（只重试有限次，不建长轮询）
        if (watchTries < 20) {
          watchTries += 1;
          setTimeout(watchPlaybackChanges, 500);
        }
        return;
      }
      if (v.__plumaWatched) return;
      v.__plumaWatched = true;

      v.addEventListener('loadedmetadata', reportIfChanged);
      v.addEventListener('resize', reportIfChanged);
      v.addEventListener('playing', reportIfChanged);
      // durationchange 覆盖切 P（时长变了）
      v.addEventListener('durationchange', reportIfChanged);

      reportIfChanged();
    } catch (e) {}
  }

  var watchTries = 0;
  watchPlaybackChanges();
  // 10 秒后再试一次：有些视频页是 SPA 跳转，video 元素晚于脚本出现
  setTimeout(watchPlaybackChanges, 10000);

  // 3a. 观测 playurl 请求
  var reported = {};

  /** 记录请求 URL（含查询参数摘要），用于确认播放器请求的是哪条轨道 */
  function noteRequest(url, method) {
    try {
      if (!isPlayurlPath(url)) return;
      // 供"主账号基线"判定：这条一旦置位，之后才出现的 __playinfo__ 就是客户端数据
      anyPlayurlSeen = true;
      var key = url.split('?')[0] + '|' + (method || 'GET');
      if (reported[key]) return;
      reported[key] = 1;
      safePost({ __ns: NS, type: 'req', token: token, method: method || 'GET', url: url },
        '*',);
    } catch (e) {}
  }

  /**
   * 判断当前播放的是不是 HDR 轨道。
   *
   * ## 为什么需要它
   * B站 4K 轨道有 3 种编码，分辨率相同但动态范围不同：
   *   av01（AV1）/ avc1（H.264）→ 通常 SDR
   *   hev1 / hvc1（HEVC Main10）→ **HDR 只在这条里**
   * 播放器默认选 AV1（体积小），所以"能播 4K"不等于"在播 HDR"。
   *
   * ## 手段：拦截多个点，越早越好
   * 1. `MediaSource.addSourceBuffer` —— 最准，但可能晚于播放器初始化
   * 2. `URL.createObjectURL` —— 拿到 blob，配合 video 元素
   * 3. `MediaSource.isTypeSupported` / `addSourceBuffer` 调用参数
   * 4. 从 `<video>` 的 `getVideoPlaybackQuality` 拿不到编码，只能作辅助
   *
   * 这里三个都挂，谁先抓到用谁。
   */
  var videoCodecs = []; // { mime, from }
  var audioCodecs = []; // { mime, from }

  /**
   * 活跃的 SourceBuffer 追踪。
   *
   * 为什么不能只看 addSourceBuffer 的调用顺序：
   * 播放器切音轨时会新建 SourceBuffer，但**不一定删掉旧的**。
   * 所以"最后创建的那条"未必是"当前在播的那条"。
   *
   * 判据：记录每个 SB 最近一次收到数据的时间（updateend），
   * 取时间最新的那条 —— 那才是真的在播。
   */
  var videoSbs = []; // { codec, lastUpdate }
  var audioSbs = []; // { codec, lastUpdate }

  function noteCodec(mimeType, from) {
    try {
      if (typeof mimeType !== 'string') return;

      var bucket = null;
      if (mimeType.indexOf('video/') === 0) bucket = videoCodecs;
      else if (mimeType.indexOf('audio/') === 0) bucket = audioCodecs;
      else return;

      for (var i = 0; i < bucket.length; i++) {
        if (bucket[i].mime === mimeType) return;
      }
      bucket.push({ mime: mimeType, from: from });
      // 上限保护：codec 种类理论上很少，但页面反复重建播放器时可能不断出现
      // 新的 mime 变体。不设上限会无界增长（同 trackSourceBuffer 的事故）
      while (bucket.length > 32) bucket.shift();

      safePost({ __ns: NS, type: 'codec', token: token, mime: mimeType, from: from, kind: bucket === videoCodecs ? 'video' : 'audio' },
        '*',);
    } catch (e) {}
  }

  /**
   * 注册一个 SourceBuffer 到活跃追踪。
   *
   * 音频和视频都要注册。曾经写成只追踪音频（`indexOf('video/') !== 0`），
   * 导致日志里「活跃轨 视频0/0」——明明在播 2160p 却抓不到视频轨。
   */
  function trackSourceBuffer(buf, mimeType) {
    if (!buf || typeof mimeType !== 'string') return;

    var id = mimeType.match(/codecs="([^"]+)"/);
    var name = id && id[1] ? id[1] : mimeType;
    var isVideo = mimeType.indexOf('video/') === 0;

    /**
     * ⚠️ 关键：追踪数组必须**有上限并摘掉旧监听器**。
     *
     * 踩过的真实事故：视频页挂后台一段时间再回来，白屏 / 播放器无响应。
     * 根因就在这里——B站播放器在后台被挂起/重建后会重新 addSourceBuffer，
     * 而本函数每次都会 push 一条 entry 并挂一组 updateend 监听，
     * **旧的一个都不摘**。
     *
     * 后果是双重的：
     *   1. `videoSbs` / `audioSbs` 随重建次数线性增长，
     *      `activeCodec()` 每次调用都要遍历全部历史条目
     *   2. 旧 SourceBuffer 的 updateend 监听仍在跑，每次写入都会
     *      把所有历史监听器唤醒一遍，主线程被拖死
     *
     * 挂得越久，恢复时那一次写入要处理的监听器越多 → 白屏。
     *
     * 修法：超过上限就淘汰最旧的一条，并**显式 removeEventListener**。
     */
    var MAX_TRACKED_SB = 8;

    var entry = { codec: name, lastUpdate: 0, buf: buf, onUpdateEnd: null, onError: null };
    var bucket = isVideo ? videoSbs : audioSbs;
    bucket.push(entry);

    // 淘汰最旧的：摘监听器 + 从数组移除。不摘监听器等于没修
    while (bucket.length > MAX_TRACKED_SB) {
      var old = bucket.shift();
      if (old) {
        try {
          if (old.onUpdateEnd) old.buf.removeEventListener('updateend', old.onUpdateEnd);
          if (old.onError) old.buf.removeEventListener('error', old.onError);
        } catch (e) {}
      }
    }

    entry.onError = function () {
      safePost({ __ns: NS, type: 'sb-error', token: token, mime: name });
    };
    buf.addEventListener('error', entry.onError);

    entry.onUpdateEnd = function () {
      // 每次写入都刷新时间——这是判断"谁在播"的依据
      entry.lastUpdate = Date.now();

      if (buf.__plumaSeen) return;
      buf.__plumaSeen = true;
      safePost({
          __ns: NS,
          type: 'sb-ok',
          token: token,
          mime: name,
          kind: isVideo ? 'video' : 'audio',
          buffered: buf.buffered && buf.buffered.length ? buf.buffered.end(0) : 0,
        },
        '*',);
    };
    buf.addEventListener('updateend', entry.onUpdateEnd);
  }

  // ── 拦截 MediaSource：**观测绝不能让主流程失败** ──
  //
  // ## 铁律
  //
  // 这些 hook 的唯一目的是给诊断页提供信息。一旦观测代码抛异常，
  // 页面会拿不到 SourceBuffer → 播放器白屏。**观测的重要性远低于播放**，
  // 所以每个 hook 都必须是：调用原函数 → 拿到返回值 → 尽力观测 → 无论观测是否成功都返回原返回值。
  //
  // 曾经的写法是：
  //   noteCodec(mimeType);                 // ← 在 orig 之前调用
  //   var sb = origAddSB.apply(...);
  // 问题：noteCodec 内部要 window.postMessage，而页面在后台被冻结/恢复的过程中
  // postMessage 可能抛 DataCloneError。异常在 origAddSB 之前抛出，
  // 整个 addSourceBuffer 就失败了 —— 播放器拿不到 SourceBuffer，直接白屏。
  // 这正好解释了"为什么只有挂后台才会发作"。

  /** 安全观测：吞掉一切异常，绝不影响调用方 */
  function safeObserve(fn) {
    try {
      fn();
    } catch (e) {}
  }

  // 拦截 1：addSourceBuffer（最准）
  try {
    var origAddSB = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mimeType) {
      // ⚠️ 顺序至关重要：**先调用原函数**
      var sb = origAddSB.apply(this, arguments);
      // 再观测。观测失败也不影响已经拿到的 sb
      safeObserve(function () {
        noteCodec(mimeType, 'addSourceBuffer');
        trackSourceBuffer(sb, mimeType);
      });
      return sb;
    };
  } catch (e) {}

  // 拦截 2：isTypeSupported（播放器选编码前一定会问能不能解）
  // 这能告诉我们"它考虑过哪些编码"，即使最后没选
  try {
    var origIsSupported = MediaSource.isTypeSupported;
    MediaSource.isTypeSupported = function (mimeType) {
      var r = origIsSupported.apply(this, arguments);
      safeObserve(function () {
        if (r) noteCodec(mimeType, 'isTypeSupported');
      });
      return r;
    };
  } catch (e) {}

  // 拦截 3：ManagedMediaSource（新版播放器可能用这个）
  // ⚠️ 必须和拦截 1 做同样的追踪注册，否则视频轨会漏掉（踩过：视频0/0）
  try {
    if (window.ManagedMediaSource && window.ManagedMediaSource.prototype.addSourceBuffer) {
      var origMAddSB = window.ManagedMediaSource.prototype.addSourceBuffer;
      window.ManagedMediaSource.prototype.addSourceBuffer = function (mimeType) {
        var sb = origMAddSB.apply(this, arguments);
        safeObserve(function () {
          noteCodec(mimeType, 'ManagedMediaSource');
          trackSourceBuffer(sb, mimeType);
        });
        return sb;
      };
    }
  } catch (e) {}

  /** 当前在用的视频编码（最后一条 = 最近切换的） */
  function readCodec() {
    if (!videoCodecs.length) return '?';
    var m = videoCodecs[videoCodecs.length - 1].mime;
    var mm = m.match(/codecs="([^"]+)"/);
    return mm && mm[1] ? mm[1] : m;
  }

  /**
   * 实际在解视频的编码。
   * 由 activeCodec() 按「最近写入时间」判断，见下方。
   */

  /**
   * 判断一段 codec 字符串属于哪**类**编码。
   *
   * ⚠️ 只做编码家族分类，**不推断 HDR 格式**。
   * 曾经把 `hvc1.*` 判成"杜比视界"，这是错的：
   *   - `hvc1` / `hev1` 只是 MP4 封装里 HEVC 的两种 tag
   *   - HDR Vivid、HDR10、杜比视界**都用 HEVC 承载**，光看 codec 字符串区分不了
   *   - 真正区分要看码流里的 SEI / RPU 元数据，浏览器 API 读不到
   *
   * 所以这里只回答"是 AV1 还是 HEVC 还是 H.264"，HDR 格式留给
   * `(video-dynamic-range: high)` 和用户的画质菜单去体现。
   */
  function codecFamily(codec) {
    if (!codec || codec === '?') return 'unknown';
    if (/^hev1\./i.test(codec)) return 'HEVC(hev1)';
    if (/^hvc1\./i.test(codec)) return 'HEVC(hvc1)';
    if (/^av01\./i.test(codec)) return 'AV1';
    if (/^avc1\./i.test(codec)) return 'H.264';
    if (/^vp09\./i.test(codec)) return 'VP9';
    return 'other';
  }

  /**
   * 从 codec 字符串里提取 HEVC 档次信息（客观事实，不做格式推断）。
   * 形如 `hvc1.2.4.L156.90` → profile=2 level=L156 tier=90
   */
  function hevcProfile(codec) {
    if (!codec) return '?';
    // 注意：是 (?:hvc1|hev1)，不是 hv(?:c1|ev1)——后者对 hev1 会展开成 hvev1
    var m = codec.match(/^(?:hvc1|hev1)\.([0-9A-Za-z.]+)$/i);
    return m && m[1] ? m[1] : '?';
  }

  /**
   * 当前在用的音频编码。
   *
   * 判据见 `pickActive`：**看创建顺序，不看多久没写入**。
   *
   * ⚠️ 不要改回「取最近写入的那条」。那是把「缓冲填满后的正常停顿」
   * 误判成「轨已死」的根源——用户实测的写入间隔就有 9 秒，
   * 任何有限的时间窗都会在某些视频上失效。
   */
  function activeAudioCodec() {
    var e = pickActive(audioSbs);
    return e ? e.codec : '?';
  }

  /** 当前在用的视频编码（与 `activeAudioCodec` 同一套判据） */
  function activeCodec() {
    var e = pickActive(videoSbs);
    return e ? e.codec : '?';
  }

  /**
   * 识别音频编码家族。
   *
   * B站实际会遇到：
   *   mp4a.40.2  → AAC-LC（普通音质）
   *   mp4a.40.5  → HE-AAC
   *   ec-3 / ac-3 → 杜比数字+ / 杜比全景声（需系统解码器）
   *   fLaC       → FLAC（Hi-Res 无损）
   *   alac       → ALAC
   */
  function audioFamily(codec) {
    if (!codec || codec === '?') return 'unknown';
    if (/^ec-3|^ac-3/i.test(codec)) return 'Dolby(EC-3)';
    if (/^fLaC/i.test(codec)) return 'FLAC';
    if (/^alac/i.test(codec)) return 'ALAC';
    // 注意用 ($|\.) 收尾：`mp4a.40.2` 会误匹配 `mp4a.40.29` 的前缀
    if (/^mp4a\.40\.5($|\.)/i.test(codec)) return 'HE-AAC';
    if (/^mp4a\.40\.2($|\.)/i.test(codec)) return 'AAC-LC';
    if (/^mp4a/i.test(codec)) return 'AAC';
    if (/^opus/i.test(codec)) return 'Opus';
    return 'other';
  }

  /** 解码能力：浏览器声称能不能解这条流 */
  function decodeSupport(mime) {
    try {
      return MediaSource.isTypeSupported(mime) ? 'yes' : 'no';
    } catch (e) {
      return '?';
    }
  }

  // ── XHR hook ──
  //
  // ## 只做一件事：**观测**
  //
  // 曾经在这里改写 `responseText` / `response`（用 defineProperty 覆盖原型 getter），
  // 那是错的，而且是"点进视频页只有文字、视频和评论都加载不出来"的直接原因：
  //
  //   1. `responseType` 为 `arraybuffer` / `blob` 时读 `responseText` 会**抛异常**，
  //      而这个异常会打断 `readystatechange` 的后续派发
  //   2. 覆盖 `response` 属性后，页面拿到的对象不再是原生 Response 语义
  //   3. 一旦失败（对象不可扩展等），`response` 与 `responseText` 会不一致
  //
  // 参考 Bili Dual Account Helper 的做法：它要改写会员状态时**不执行原请求**，
  // 而是自己发一遍再用 `emulateXhr()` 伪装完整生命周期——那是"接管"，
  // 不是"篡改"。我们不需要走到那一步：会员状态改写改由 fetch 侧负责，
  // XHR 这边只保留观测。
  //
  // ⚠️ 所以：**这个 hook 绝不修改任何页面可见的属性。**
  try {
    var origOpen = XMLHttpRequest.prototype.open;

    var origSend = XMLHttpRequest.prototype.send;
    var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
      var result = origOpen.apply(this, arguments);

      try {
        var abs = url;
        try {
          abs = new URL(url, location.href).href;
        } catch (e) {}

        this.__plumaUrl = abs;
        this.__plumaMethod = String(method || 'GET').toUpperCase();
        this.__plumaHeaders = {};

        // playurl 走的是 XHR（2026-10-26 实测 initiatorType=xmlhttprequest）。
        // 这里做两件事：
        //   1. open 时就并行取一次主账号进度 —— readystatechange 是同步回调，里面没法 await
        //   2. 记录轨道清单 + 把进度写回响应
        if (isPlayurlPath(abs)) {
          if (enabled) {
            var pids = playurlIds(abs);
            if (pids) prefetchProgress(pids.aid, pids.cid);
          }

          var xhr = this;
          xhr.addEventListener('readystatechange', function () {
            if (xhr.readyState !== 4) return;
            if (xhr.__plumaSeen) return;
            xhr.__plumaSeen = true;
            try {
              // 只有文本类响应才读；arraybuffer / blob 直接跳过
              var type = xhr.responseType;
              if (type !== '' && type !== 'text' && type !== 'json') return;
              var raw = xhr.responseText;
              if (typeof raw === 'string' && raw) {
                capturePlayurlJson(xhr.__plumaUrl, raw);
                // ⚠️ 顺序不能反：必须在页面读 responseText **之前**完成遮蔽。
                // 这个监听器是在 open() 里注册的，早于页面自己注册的处理函数。
                patchPlayurlXhrProgress(xhr, raw);
              }
            } catch (e) {}
          });
        }

        noteRequest(abs, method);
      } catch (e) {}

      return result;
    };

    /**
     * 记录请求头。**必须在 send 之前**逐次记录——参考实现踩过
     * "在 send 时才挂钩子导致头丢失"的坑，直接导致重发出来的请求缺 token。
     */
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        if (this.__plumaHeaders) this.__plumaHeaders[String(name)] = String(value);
      } catch (e) {}
      return origSetHeader.call(this, name, value);
    };

    /**
     * 会员状态改写 —— 走**接管**而不是篡改。
     *
     * ## 为什么不能改属性
     *
     * 上一版在这里用 `Object.defineProperty` 覆盖 `responseText` / `response`，
     * 结果 `responseType` 为 arraybuffer/blob 时读 `responseText` 抛异常，
     * 打断 readystatechange 派发 → 视频、推荐、评论全不加载 → 渲染进程崩溃。
     *
     * ## 现在的做法（学 Bili Dual）
     *
     * **不执行原请求**，自己用原生 fetch 发一遍，把改过的响应
     * 伪装成完整 XHR 生命周期。这样页面看到的始终是"一个正常的 XHR"，
     * 不存在第二个读取者，也不依赖可写性。
     *
     * 只在 `enabled && PATCH_PATHS` 命中时接管；其余一律原样走。
     */
    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;

      var shouldTakeOver = false;
      try {
        var url = xhr.__plumaUrl || '';
        // 只对**会员状态接口**接管。playurl 不需要改内容，走原请求即可
        shouldTakeOver = enabled && matchPath(url, PATCH_PATHS);
      } catch (e) {}

      if (!shouldTakeOver) {
        return origSend.apply(this, arguments);
      }

      // 重发时保留原请求的方法与请求头（尤其 csrf / referer / x-requested-with）
      var headers = {};
      try {
        headers = Object.assign({}, xhr.__plumaHeaders || {});
      } catch (e) {}

      nativeFetch
        .call(window, xhr.__plumaUrl, {
          method: xhr.__plumaMethod || 'GET',
          headers: headers,
          credentials: xhr.withCredentials ? 'include' : 'same-origin',
        })
        .then(function (resp) {
          if (!resp || !resp.ok) {
            // 重发失败 → 退回原请求，宁可没有伪装也不能没有数据
            return origSend.call(xhr, body);
          }
          return resp.text().then(function (t) {
            var patched;
            try {
              patched = patchResponseText(xhr.__plumaUrl, t);
            } catch (e) {
              patched = t;
            }
            try {
              reportPatch(xhr.__plumaUrl, patched !== t);
            } catch (e) {}
            emulateXhr(xhr, resp, patched);
          });
        })
        .catch(function () {
          // 任何异常都要兜底：不能让 XHR 永远停在 readyState=1
          try {
            origSend.call(xhr, body);
          } catch (e) {}
        });
    };
  } catch (e) {}

  /**
   * 把 XHR 伪装成"已完成"。
   *
   * 逐项设置 `readyState` / `status` / `response` 等**实例自有属性**，
   * 遮蔽原型上的访问器。这是参考实现的 `emulateXhr()` 做法——
   * 对页面而言，这个 XHR 看起来和真实完成的一模一样。
   *
   * ⚠️ 与"篡改真实响应"的根本区别：**这里没有真实响应**，
   * 原请求根本没发出去，所以不存在"两个读者"或"原生语义被破坏"的问题。
   */
  function emulateXhr(xhr, resp, bodyText) {
    function setProp(name, val) {
      try {
        Object.defineProperty(xhr, name, {
          configurable: true,
          writable: true,
          value: val,
        });
      } catch (e) {}
    }

    setProp('readyState', 4);
    setProp('status', resp.status || 200);
    setProp('statusText', resp.statusText || 'OK');
    setProp('responseURL', resp.url || xhr.__plumaUrl || '');

    var type = '';
    try {
      type = xhr.responseType;
    } catch (e) {}

    if (type === 'json') {
      var parsed = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch (e) {}
      setProp('response', parsed !== null ? parsed : bodyText);
    } else {
      setProp('response', bodyText);
      setProp('responseText', bodyText);
    }
    setProp('responseXML', null);

    try {
      xhr.getResponseHeader = function (name) {
        var v = null;
        try {
          v = resp.headers.get(String(name));
        } catch (e) {}
        return v;
      };
      xhr.getAllResponseHeaders = function () {
        var out = '';
        try {
          resp.headers.forEach(function (v, k) {
            out += k + ': ' + v + '\r\n';
          });
        } catch (e) {}
        return out;
      };
    } catch (e) {}

    function fire(evt) {
      try {
        xhr.dispatchEvent(new Event(evt));
      } catch (e) {}
    }
    fire('readystatechange');
    fire('load');
    fire('loadend');
  }


  // ── fetch hook ──
  //
  // ## 铁律：**只有确定要改写时才动响应，否则原样返回**
  //
  // 这里曾经犯过一个严重错误：对 `PATCH_PATHS` 匹配到的请求都先 `resp.clone()`
  // 再读文本，然后**重建一个全新的 Response** 返回。后果是：
  //
  //   1. `clone()` 会**分流原始 body stream**。之后再把 `resp` 交回给页面，
  //      它读 body 时可能拿到 `body stream already read`
  //   2. 重建的 Response 丢失原始的内部状态（body 流的身份、AbortSignal 关联等）
  //   3. `/x/player/wbi/v2` 是播放器的核心接口，它挂了 → 视频不出来
  //   4. 同一套机制也波及页面其它接口 → 推荐 / 评论全空
  //   5. 最终整个渲染进程崩溃（Crashpad_NotConnectedToHandler）
  //
  // 现在的做法：
  //   - 不需要改写 → **完全不动** `resp`，原样返回（连 clone 都不做）
  //   - 需要改写 → 直接读 `resp.text()`（不 clone），再造新 Response。
  //     原始 resp 不再被任何人使用，所以不存在流冲突
  try {
    // 复用文件顶部保存的 nativeFetch —— 它一定没被替换过
    var origFetch = nativeFetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        var self = this;
        var args = arguments;
        var url = '';
        var method = 'GET';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
          url = new URL(url, location.href).href;
          method = (init && init.method) || (input && input.method) || 'GET';
        } catch (e) {}

        // 观测：吞掉一切异常，且绝不影响原请求
        try {
          noteRequest(url, method);
        } catch (e) {}

        var p = origFetch.apply(self, args);

        var isPlayurl = isPlayurlPath(url);
        var needPatch = enabled && matchPath(url, PATCH_PATHS);

        /**
         * ## PGC SPA 切集：`/ogv/player/playview` 才是真正的数据源（2026-10-28 实测）
         *
         * 在播放器里点选集（SPA 内跳）时：
         *   - `window.__playinfo__` **完全不更新**（实测 `ssAt` 不变、cid 还是上一集的）
         *   - 页面改用 `fetch GET /ogv/player/playview?ep_id=…` 拿新一集的流
         *   - 该响应是 `{code, data:{video_info:{durls:[4 组 × 6 分钟]}}}`
         *
         * 所以 P2 的"在 `__playinfo__` setter 里注入"对切集无效。
         * 这里在**响应层**做同样的事：把 `data.video_info` 换成缓存里的完整流。
         *
         * ⚠️ ADR 0007 说这个接口是 POST + csrf 在 body 里 —— **那是页面初次加载的场景**
         * （实际走 SSR，无请求）。切集场景下它是纯 GET，DNR 能改 Cookie。
         */
        /**
         * ⚠️ **PLAYVIEW 分支必须"能换才换"，否则一个字节都不碰**（2026-10-28 灰屏事故）
         *
         * 第一版写成 `needPatch = enabled`，于是**在读响应之前**就决定了要重建 Response。
         * 而换流需要 `ep → cid` 映射 —— 新集的映射只有在"那一集被打开过一次"之后才存在。
         * 首次切到新集时映射缺失 → `pgcSwapPlayviewBody` 返回 `null` → 代码仍走
         * `rebuildResponse`（因为 `needPatch` 早已为 true）→ **重建后的 Response 让播放器灰屏**
         * （`duration: 0`、`readyState: 0`、无错误码）。
         *
         * 所以：**先判断能不能换，再决定碰不碰**。
         * 这里只做"是否值得读一次 body"的粗判（有映射 + 有缓存），
         * 真正的换流仍在 `pgcSwapPlayviewBody` 里做，失败就返回原 `resp`。
         */
        /**
         * ## PGC SPA 切集：`/ogv/player/playview` 是**唯一**的数据源（ADR 0023）
         *
         * 真机实测（2026-10-28）：在播放器里点选集时
         *   - `window.__playinfo__` **完全不动** —— setter 不触发、cid 停在上一集
         *     （`arc.cid=248742156` 而 URL 已是 `ep341210`）
         *   - 页面改用 `fetch GET /ogv/player/playview?ep_id=…` 拿新一集的流
         *   - 响应是 `{code, data:{arc:{cid}, play_video_type:"preview",
         *     video_info:{timelength:1440000, durls:[4 组 × 6 分钟]}}}`
         *
         * 所以 P2 的"setter 里注入"对切集**完全无效**（不是判定写错，
         * 是 setter 根本没被调用）。换流只能在这里做。
         *
         * ## 灰屏事故的真正原因（2026-10-28 更正）
         *
         * 之前两次灰屏，当时归因于"`new Response()` 重建破坏响应语义"。**那是误判。**
         * 真正原因是**换了 dash**：切集时播放器走 `<video src>` + mp4 直放
         * （`networkState: 1`、`currentSrc` 是 `.mp4`、没有 MSE），
         * 按 durl 分支准备接收，塞 dash 进去就装不上 → `duration:0 / readyState:0`。
         *
         * 换成 **durl 形态**（`playurl?fnval=0` 的完整集 durl，与 `playview` 的
         * `durl[0]` 逐字段同构）之后，重建 Response 完全正常 —— 连续 3 集验证通过：
         * `dur 1420 / 1440 / 1440`、`readyState 4`、零灰屏、零 reload。
         *
         * 详见 ADR 0023。
         */
        var isPgcPlayview = enabled && IS_PGC && /\/ogv\/player\/playview/.test(url);

        // playurl 若走 fetch（2026-10-26 实测主路径是 XHR，这里是兜底），
        // 同样要并行预取主账号进度
        if (isPlayurl && enabled) {
          var fids = playurlIds(url);
          if (fids) prefetchProgress(fids.aid, fids.cid);
        }

        // **三条路（改写 / playurl 观测 / playview 换流）都不需要 → 一字节都不碰**
        if (!needPatch && !isPlayurl && !isPgcPlayview) return p;

        return p.then(function (resp) {
          if (!resp || !resp.ok) return resp;

          /**
           * ## playview 换流：**单独一条路，不跟 `needPatch` 混**
           *
           * 它要读 body 再重建 Response，而 `needPatch` 那套是给 vip 字段的。
           * 两者互斥 —— 这里先处理 playview 并直接返回。
           *
           * ⚠️ 换流失败（返回 `null`）时**仍要重建 Response**，
           * 因为 `resp.text()` 已经把 body 消费掉了，不能原样 `return resp`
           * （再读会抛）。重建用的是原文，内容一致。
           */
          if (isPgcPlayview) {
            return resp
              .text()
              .then(function (t) {
                var body;
                try {
                  body = JSON.parse(t);
                } catch (e) {
                  return rebuildResponse(resp, t);
                }
                return pgcSwapPlayviewBody(body, origFetch).then(function (swapped) {
                  return rebuildResponse(resp, swapped !== null ? swapped : t);
                });
              })
              .catch(function () {
                return new Response('', { status: resp.status, statusText: resp.statusText });
              });
          }

          // 只需要记录轨道清单时，用 clone 是安全的：
          // 拿副本去读，原 resp 仍然完好交回给页面
          if (!needPatch) {
            // 同步判断有没有进度要还原。没有就走**零额外延迟**的老路径 ——
            // 大多数情况（新视频、没看过）都是这条路。
            var entry = null;
            try {
              var ids = playurlIds(url);
              entry = ids ? progressCache[ids.aid + '|' + ids.cid] : null;
            } catch (e) {}
            var hasProgress = !!(entry && entry.value && entry.value.cid);
            if (hasProgress) {
              // 同 XHR 版：已经播起来就不再改写
              try {
                var pv = document.querySelector('video');
                if (pv && pv.currentTime > 3) hasProgress = false;
              } catch (e) {}
            }

            var copy;
            try {
              copy = resp.clone();
            } catch (e) {
              return resp;
            }

            if (!hasProgress) {
              // 后台记录轨道清单，原响应立刻交回页面
              copy
                .text()
                .then(function (t) {
                  try {
                    capturePlayurlJson(url, t);
                  } catch (e) {}
                })
                .catch(function () {});
              return resp;
            }

            // 有进度要还原 → 等副本读完再交回（多一次 JSON 解析）
            return copy
              .text()
              .then(function (t) {
                try {
                  capturePlayurlJson(url, t);
                } catch (e) {}
                var patched = applyProgressToJson(t, entry.value);
                if (patched === null) return resp;
                return rebuildResponse(resp, patched);
              })
              .catch(function () {
                return resp;
              });
          }

          // 需要改写：**读原 resp 而不是 clone 副本**。
          // 反正这个 resp 不会再被返回给页面，不存在"两个读者"的问题
          return resp
            .text()
            .then(function (t) {
              var patched;
              try {
                patched = patchResponseText(url, t);
              } catch (e) {
                patched = t;
              }

              // 没改动 → 用原文重建（内容一致），保证页面拿到的是完整可读的响应
              if (patched === t) {
                return rebuildResponse(resp, t);
              }

              try {
                reportPatch(url, true);
              } catch (e) {}
              return rebuildResponse(resp, patched);
            })
            .catch(function () {
              // 读失败：无法给页面一个可读的响应了。
              // 返回一个空响应比返回半读的 resp 更安全——至少不会卡在流上
              return new Response('', { status: resp.status, statusText: resp.statusText });
            });
        });
      };
    }
  } catch (e) {}

  /**
   * 判断这份 `playview` 响应里的流是不是"试看"（需要换）。
   *
   * ## 为什么不能用 `timelength` 判断（2026-10-28 真机实测）
   *
   * `playview` 的 `timelength` 是 **1440000（整集 24 分钟）**，
   * 但 `durls` 只有 4 组 × 6 分钟。`timelength` 是整集元数据，
   * **不代表流有多长**。用它判断会得出"本来就完整，不用换"的错误结论。
   *
   * 判据只能看**流自己**：`durl`（单段，完整时）或 `durls`（多段，试看时）
   * 里第一段的 `length` 之和 vs `timelength`。
   *
   * @param vi `data.video_info`
   * @returns `true` 表示流短于整集，需要换
   */
  function pgcPlayviewIsTruncated(vi) {
    if (!vi || typeof vi !== 'object') return false;
    var timelength = typeof vi.timelength === 'number' ? vi.timelength : 0;

    // 单段 durl：直接看它多长
    if (Array.isArray(vi.durl) && vi.durl.length > 0) {
      var dl = typeof vi.durl[0].length === 'number' ? vi.durl[0].length : 0;
      if (timelength > 0 && dl > 0) return dl < timelength - 5000;
      return false;
    }

    // 多段 durls：把各段加起来
    if (Array.isArray(vi.durls) && vi.durls.length > 0) {
      var total = 0;
      for (var i = 0; i < vi.durls.length; i += 1) {
        var segs = vi.durls[i] && vi.durls[i].durl;
        if (Array.isArray(segs) && segs.length > 0) {
          total += typeof segs[0].length === 'number' ? segs[0].length : 0;
        }
      }
      if (timelength > 0 && total > 0) return total < timelength - 5000;
      return false;
    }

    return false;
  }

  /**
   * 把 `/ogv/player/playview` 响应里的流换成**完整集的 durl**。
   *
   * ## 这是 SPA 切集唯一的可用方案（ADR 0023，2026-10-28 真机连续 3 集验证）
   *
   * ### 为什么必须是 durl，不能是 dash
   *
   * 切集时播放器走的是 **`<video src>` + mp4 直放**（实测 `networkState: 1`、
   * `currentSrc` 指向 `.mp4`、没有 MSE）。它按 `durl` 分支准备好了接收路径。
   * 前两次灰屏事故就是因为把 **dash** 换进去了 —— 形态不一致，装不进去，
   * `duration: 0 / readyState: 0 / error: null`。
   *
   * 之前把这归因于"`new Response()` 重建破坏了响应语义"，**那是误判**：
   * 真正原因是换了 dash。换成 durl 之后重建 Response 完全正常。
   *
   * ### 完整 durl 从哪来
   *
   * `GET /pgc/player/web/playurl?…&fnval=0`（**注意 fnval=0**，不要 dash）。
   * 这条已在 DNR 白名单里，Cookie 被换成播放账号，拿到的就是完整集：
   *
   * ```
   * result.durl      = [{ size: 292087480, length: 1440000, order: 1, url, md5, backup_url }]
   * result.is_preview = 0
   * result.quality    = 80
   * result.format     = "mp4"
   * ```
   *
   * 与 `playview` 的 `durl[0]` **逐字段同构**，所以播放器无需改变行为。
   *
   * ### 为什么不用 sessionStorage 缓存了
   *
   * 旧实现要求"这一集被打开过、有 ep→cid 映射、sessionStorage 里有缓存"。
   * 但 SPA 切集时 `__playinfo__` 不更新 → ISOLATED 侧根本收不到新 cid →
   * **缓存永远不会为新集生成**，于是旧实现永远返回 `null`。
   *
   * 现在改成**就在这里现取**：cid 从响应自己的 `data.arc.cid` 读
   * （实测存在，`253153139` 这类值），一个网络往返（~200ms）就够，
   * 而这一趟本来就在播放器等数据的路径上。
   *
   * @param body 原响应 JSON
   * @param fetchImpl 原生 fetch（绕开我们自己的包装，避免递归）
   * @returns Promise<string|null> 换好的 JSON 文本；`null` 表示不动
   */
  function pgcSwapPlayviewBody(body, fetchImpl) {
    if (!body) return Promise.resolve(null);
    var data = body && body.data;
    if (!data || typeof data !== 'object') return Promise.resolve(null);

    var vi = data.video_info;
    if (!vi || typeof vi !== 'object') return Promise.resolve(null);

    // 本来就完整 → 一个字节都不碰
    if (!pgcPlayviewIsTruncated(vi)) return Promise.resolve(null);

    // cid 就在响应自己里（实测 `data.arc.cid` 一定存在）
    var cid = data.arc && data.arc.cid ? String(data.arc.cid) : '';
    if (!/^\d+$/.test(cid)) {
      pgcPost('playview', '响应里没有 arc.cid，跳过换流');
      return Promise.resolve(null);
    }

    /**
     * ## 用 `fnval=4048` 取 **dash**，不再用 `fnval=0` 取 durl（2026-10-28 修正）
     *
     * ADR 0023 最初用 `fnval=0`（durl 形态），是为了绕过灰屏 —— 那确实解决了
     * "切集能播"，但留下一个**画质锁死**的坑。真机实测（cid=32547932835）：
     *
     * ```
     * fnval=4048 → quality 120, dash 19 轨, 2160p 齐全   ← 有 4K
     * fnval=0    → quality 64,  durl 单段, 标签 "1-192"  ← 只有 720P
     * ```
     * `durl` 那串后缀 `1-192` 里的 **192 就是 720P 的 qn 编码**，
     * 而且 `fnval=0` 无论 `qn` 传 80 还是 120 都只给 720P —— 不是"参数没传对"，
     * 是**这个组合根本不返回高清 durl**。
     *
     * 后果：SPA 切集后 `realQ` 锁在 64、`videoWidth` 1280，用户在菜单里点 4K，
     * 播放器**根本没有 4K 轨可切** → 表现为"切画质失败"。
     *
     * 所以改成取 dash，并把 `type` / `format` 一起改成 DASH 形态
     * （`fnval=4048` 的响应是 `type: "DASH"` 字符串 + `format: "hdflv2"`，
     * 而 `fnval=0` 是 `type: 3` 数字 + `format: "mp4720"` —— 两种形态的
     * `type` **连类型都不同**，播放器靠它选管道）。
     */
    var url =
      'https://api.bilibili.com/pgc/player/web/playurl' +
      '?cid=' +
      encodeURIComponent(cid) +
      '&avid=0&qn=120&fnval=4048&fnver=0&fourk=1';

    return fetchImpl(url, { credentials: 'include' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var full = j && j.result;
        if (!full) {
          pgcPost('playview', 'cid=' + cid + ' 取流结果为空，跳过换流');
          return null;
        }

        var dv = full.dash && full.dash.video;
        var hasDash = Array.isArray(dv) && dv.length > 0;

        if (hasDash) {
          var heights = [];
          for (var hi = 0; hi < dv.length; hi += 1) {
            if (typeof dv[hi].height === 'number' && heights.indexOf(dv[hi].height) < 0) {
              heights.push(dv[hi].height);
            }
          }
          var dashDur = full.dash && typeof full.dash.duration === 'number' ? full.dash.duration : 0;
          // dash 时长不够 = 拿到的不是完整集（权益不足）→ 不动，宁可播试看
          if (dashDur < 600) {
            pgcPost('playview', 'cid=' + cid + ' dash 时长太短(' + dashDur + 's)，跳过换流');
            return null;
          }

          /**
           * 换 dash：把 dash / type / format 一起对齐到 4048 响应的形态。
           *
           * ⚠️ 必须 `delete vi.durl` / `delete vi.durls` —— 有 durl 时播放器
           * **优先走 durl**（ADR 0020 实测），那样又回到 720P 了。
           */
          vi.dash = full.dash;
          delete vi.durl;
          delete vi.durls;
          if (typeof full.timelength === 'number') vi.timelength = full.timelength;
          if (typeof full.quality === 'number') vi.quality = full.quality;
          if (typeof full.format === 'string') vi.format = full.format;
          if (full.type !== undefined) vi.type = full.type;
          if (typeof full.accept_quality !== 'undefined') vi.accept_quality = full.accept_quality;
          if (typeof full.accept_description !== 'undefined') {
            vi.accept_description = full.accept_description;
          }
          if (typeof full.support_formats !== 'undefined') {
            vi.support_formats = full.support_formats;
          }
          vi.is_preview = 0;

          // 试看标记一并改写（ADR 0021）—— 不改播放器会在试看结束点主动暂停
          if (data.play_video_type === 'preview') {
            data.play_video_type = PGC_PREVIEW_FLAGS.play_video_type;
          }
          if (data.play_check && data.play_check.play_detail === 'PLAY_PREVIEW') {
            data.play_check.play_detail = PGC_PREVIEW_FLAGS['play_check.play_detail'];
          }

          pgcPost(
            'playview',
            '已换流 dash cid=' + cid + ' q=' + full.quality + ' 高度=[' + heights.join(',') + ']',
          );
          return JSON.stringify(body);
        }

        /**
         * 没有 dash → 退回 durl 形态（老路，能播但只有 720P）。
         * 至少"能看完整集"，比灰屏/试看强。
         */
        if (!Array.isArray(full.durl) || full.durl.length === 0) {
          pgcPost('playview', 'cid=' + cid + ' 既无 dash 也无 durl，跳过换流');
          return null;
        }
        var fullLen = typeof full.durl[0].length === 'number' ? full.durl[0].length : 0;
        if (fullLen < 600000) {
          pgcPost('playview', 'cid=' + cid + ' 完整流太短(' + fullLen + 'ms)，跳过换流');
          return null;
        }

        vi.durl = full.durl;
        delete vi.durls;
        delete vi.dash;
        if (typeof full.timelength === 'number') vi.timelength = full.timelength;
        if (typeof full.quality === 'number') vi.quality = full.quality;
        if (typeof full.format === 'string') vi.format = full.format;
        if (full.type !== undefined) vi.type = full.type;
        vi.is_preview = 0;

        if (data.play_video_type === 'preview') {
          data.play_video_type = PGC_PREVIEW_FLAGS.play_video_type;
        }
        if (data.play_check && data.play_check.play_detail === 'PLAY_PREVIEW') {
          data.play_check.play_detail = PGC_PREVIEW_FLAGS['play_check.play_detail'];
        }

        pgcPost('playview', '已换流 durl(降级) cid=' + cid + ' len=' + fullLen);
        return JSON.stringify(body);
      })
      .catch(function (e) {
        pgcPost('playview', '取完整流失败：' + (e && e.message ? e.message : 'throw'));
        return null;
      });
  }


  /**
   * 用给定文本重建一个 Response，尽量保留原始元信息。
   *
   * ⚠️ 必须手动补 `url` / `redirected` / `type`：
   * `new Response()` 构造出来的这三个属性是空值，而 B站播放器会用 `resp.url`
   * 做后续判断，丢了就拿到空字符串。
   */
  function rebuildResponse(resp, text) {
    var rebuilt;
    try {
      rebuilt = new Response(text, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    } catch (e) {
      // 极少见：headers 里有 forbidden 组合。退化成不带 headers 的响应
      rebuilt = new Response(text, { status: resp.status });
    }

    try {
      Object.defineProperty(rebuilt, 'url', { value: resp.url });
      Object.defineProperty(rebuilt, 'redirected', { value: resp.redirected });
      Object.defineProperty(rebuilt, 'type', { value: resp.type });
    } catch (e) {}

    return rebuilt;
  }

  // ── 4c. 把主账号的观看进度写回 playurl 响应（续播） ──
  //
  // ## 症状
  //
  // 看到一半的视频，重新打开后**从 0:00 开始**。
  //
  // ## 根因（2026-10-26 实测）
  //
  // playurl 是被 DNR 换成播放账号凭据的那一条请求，所以响应里的
  // `last_play_time` / `last_play_cid` 也是**播放账号的**。实测同一页面同一时刻：
  //
  //   /x/player/wbi/playurl（播放账号）→ last_play_time=0     last_play_cid=0
  //   /x/player/wbi/v2    （主账号）  → last_play_time=15000  last_play_cid=<cid>
  //
  // 播放器（core.js）的续播判定是：
  //
  //   var y = (p.lastPlayTime || 0) / 1e3;
  //   var m = (cid === p.lastPlayCid);          // ← 0 永远不等于 cid
  //   m && duration > 30 && y >= 5 && y < duration - 5 && seek(y)
  //
  // `p` 就是 playurl 响应体。播放账号从没看过这个视频 → `m` 恒为 false
  // → **永远不续播**，而且不报错、不降级，只是静默地从开头放。
  //
  // ## 数据从哪来
  //
  // `/x/player/wbi/v2` **不在代理白名单里**，所以它天然是主账号身份。
  // 这里用浏览器自己的 cookie（`credentials:'include'`）取一次 ——
  // 不读取、不接触主账号的 SESSDATA，与「主账号 = 浏览器当前登录态」一致。
  //
  // ## 时序：为什么必须提前取
  //
  // XHR 的 `readystatechange` 是**同步**回调，没法在里面 await。
  // 所以在 `open()` 时就把 v2 请求发出去（与 playurl 并行），
  // 等 playurl 下完（4K 响应通常比这个小 JSON 慢）时，值一般已经在手上了。
  // 拿不到就**什么都不做** —— 退化成"这次不续播"，绝不阻断视频。

  /** key = `aid|cid` → { done, value: { time, cid } | null } */
  var progressCache = {};

  function playurlIds(url) {
    try {
      var u = new URL(url, location.href);
      var aid = u.searchParams.get('avid') || u.searchParams.get('aid');
      var cid = u.searchParams.get('cid');
      if (!aid || !cid) return null;
      return { aid: aid, cid: cid };
    } catch (e) {
      return null;
    }
  }

  function prefetchProgress(aid, cid) {
    var key = aid + '|' + cid;
    if (progressCache[key]) return;
    var entry = { done: false, value: null };
    progressCache[key] = entry;

    try {
      nativeFetch
        .call(
          window,
          'https://api.bilibili.com/x/player/wbi/v2?aid=' +
            encodeURIComponent(aid) +
            '&cid=' +
            encodeURIComponent(cid),
          { credentials: 'include' },
        )
        .then(function (r) {
          return r && r.ok ? r.json() : null;
        })
        .then(function (j) {
          var d = j && j.data;
          if (d && typeof d.last_play_time === 'number' && typeof d.last_play_cid === 'number') {
            entry.value = { time: d.last_play_time, cid: d.last_play_cid };
          }
          entry.done = true;
        })
        .catch(function () {
          entry.done = true;
        });
    } catch (e) {
      entry.done = true;
    }
  }

  /**
   * 把进度写进已解析的 playurl JSON。改动了返回新的文本，没改动返回 null。
   */
  function applyProgressToJson(raw, prog) {
    try {
      var o = JSON.parse(raw);
      var d = o && o.data;
      if (!d || typeof d.last_play_time !== 'number') return null;
      if (d.last_play_time === prog.time && d.last_play_cid === prog.cid) return null;
      d.last_play_time = prog.time;
      d.last_play_cid = prog.cid;
      return JSON.stringify(o);
    } catch (e) {
      return null;
    }
  }

  /**
   * XHR 版：就地遮蔽这个实例的 `responseText` / `response`。
   *
   * ⚠️ 只在**这个实例**上 defineProperty，不动原型；只在 `responseType`
   * 是文本/JSON 时动手。历史上"给所有 XHR 覆盖 responseText"导致过
   * arraybuffer 响应读文本抛异常 → 打断 readystatechange → 渲染进程崩溃。
   * 这里逐条排除那些情形。
   *
   * @returns 是否改写了
   */
  function patchPlayurlXhrProgress(xhr, raw) {
    if (!enabled) return false;

    // 已经播起来了就不再改写。切清晰度 / 换轨会重新拉一次 playurl，
    // 那时缓存里的进度是**页面打开时**的旧值，再写回去可能把播放位置拽回过去。
    // 播放器自己也有 `currentTime < 3` 的闸门，这里再加一道，双保险。
    try {
      var v = document.querySelector('video');
      if (v && v.currentTime > 3) return false;
    } catch (e) {}

    var ids = playurlIds(xhr.__plumaUrl || '');
    if (!ids) return false;

    var entry = progressCache[ids.aid + '|' + ids.cid];
    if (!entry || !entry.value || !entry.value.cid) return false; // 没有可还原的进度

    var prog = entry.value;
    var type = '';
    try {
      type = xhr.responseType;
    } catch (e) {}

    if (type === 'json') {
      // 页面读的是对象 → 直接改那个对象，不碰任何访问器
      try {
        var live = xhr.response;
        var ld = live && live.data;
        if (ld && typeof ld.last_play_time === 'number') {
          ld.last_play_time = prog.time;
          ld.last_play_cid = prog.cid;
          return true;
        }
      } catch (e) {}
      return false;
    }

    if (type !== '' && type !== 'text') return false; // arraybuffer / blob 一律不碰

    var patched = applyProgressToJson(raw, prog);
    if (patched === null) return false;

    try {
      Object.defineProperty(xhr, 'responseText', {
        configurable: true,
        get: function () {
          return patched;
        },
      });
      // responseType 为 '' 时 `response` 等价于 `responseText`，两个都要遮
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get: function () {
          return patched;
        },
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── 5. 记录 playurl 响应里的音频轨道清单 ──
  // 为什么要额外做这一步：
  // SourceBuffer 只能看到"播放器真的装了什么"。如果它没为 Hi-Res / 杜比
  // 创建独立轨道，就什么都看不到。
  // 而 playurl 响应里有完整清单（flac / dolby），能确认"这些轨到底有没有下发"。

  function summarizePlayurl(json) {
    try {
      var d = json && json.data;
      if (!d) return null;

      var dash = d.dash || {};

      // 普通音轨：完整列出 id + 码率
      var audioList = (dash.audio || []).map(function (a) {
        return { id: a.id, bw: a.bandwidth || 0 };
      });

      // 视频轨：列出 id / 高度 / codecid，用于判断"当前画质是哪条"
      var videoList = (dash.video || []).map(function (v) {
        return {
          id: v.id,
          h: v.height,
          codecid: v.codecid,
          bw: v.bandwidth || 0,
          // 帧率是字符串（"60.000"），解析成数字；解析不出就不给
          fps: parseFloat(v.frame_rate || v.frameRate || '0') || 0,
        };
      });

      var flacInfo = null;
      if (dash.flac && dash.flac.audio) {
        var fa = dash.flac.audio;
        flacInfo = {
          id: fa.id,
          bw: fa.bandwidth || 0,
          // B站字段名不统一，几种都试
          sampleRate: fa.sampleRate || fa.sample_rate || fa.samplerate || 0,
          display: !!dash.flac.display,
        };
      }

      var dolbyList = null;
      if (dash.dolby && dash.dolby.audio && dash.dolby.audio.length) {
        dolbyList = dash.dolby.audio.map(function (a) {
          return { id: a.id, bw: a.bandwidth || 0, type: a.type || 0 };
        });
      }

      /**
       * `dolby.vision` —— B站服务端明确标注「这个视频提供杜比视界」。
       *
       * ## 为什么必须单独取出来
       *
       * 之前只读了 `dolby.audio`（杜比全景声），**漏了 `dolby.vision`**。
       * 于是角标只能靠 quality id 猜杜比视界 —— 而那条路已经证明不可靠
       * （用户实测：杜比视界视频被显示成 HDR / 4K）。
       *
       * 这个字段是**服务端给的布尔值**，不需要推断。
       * 但它只说明"视频提供杜比视界版本"，**不等于"当前在播杜比视界"**，
       * 所以角标只能把它写成"本视频提供杜比视界"，不能当主文案。
       */
      var dolbyVision = !!(dash.dolby && dash.dolby.vision);

      return {
        audio: audioList,
        video: videoList,
        flac: flacInfo,
        dolby: dolbyList,
        dolbyVision: dolbyVision,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * 最近一次 playurl 响应的轨道清单。
   *
   * 用来把"当前播放高度 + 编码"反查成 B站的 quality id。
   *
   * ## 为什么要反查
   *
   * 角标要显示"杜比视界"而不是笼统的"4K"，靠的是 quality id。
   * 但 `<video>` 元素只给宽度和高度，不给 id。
   * 所以从 playurl 的 `dash.video[]` 里按 (height, codecid) 找回来。
   *
   * 找不到就返回 null —— 角标会退化成按高度显示，**不猜**。
   */
  var lastVideoTracks = [];

  /**
   * 根据实际播放高度与编码，判断当前是否在高帧率轨道上。
   *
   * ## 为什么不能直接读 `<video>`
   *
   * `<video>` 元素**没有暴露帧率**。唯一来源是 playurl 的 `dash.video[].frame_rate`。
   *
   * ## 判据
   *
   * 在同高度的轨道里，找出与当前编码家族匹配的那条，看它的 fps 是否 >= 50。
   * 取不到任何匹配就返回 false —— **宁可不说 60fps，也不能瞎标**。
   *
   * ⚠️ 这是"轨道清单里有 60fps 轨"的弱推断，不是"播放器确实选了它"的证明。
   * 但配合同高度 + 同编码两个条件，误报概率很低；
   * 而且即使误报，代价只是多一个 60fps 徽章，不像 HDR 那样影响判断。
   */
  function resolveHighFrameRate(height) {
    try {
      if (!height || !lastVideoTracks.length) return 0;

      var best = 0;
      for (var i = 0; i < lastVideoTracks.length; i += 1) {
        var t = lastVideoTracks[i];
        if (t.h !== height) continue;
        if (!t.fps) continue;
        if (t.fps > best) best = t.fps;
      }

      // 返回**实际帧率**而不是布尔值。
      // 踩过的 bug：曾经返回 `best >= 50`，然后角标文案写死 "60fps"，
      // 于是 120fps 的视频被标成 60fps。
      // 帧率种类很少（24/25/30/48/60/120），直接报真实数值最省事也最准确。
      return Math.round(best);
    } catch (e) {
      return 0;
    }
  }

  function rememberVideoTracks(summary) {
    try {
      if (summary && summary.video && summary.video.length) {
        lastVideoTracks = summary.video;
      }
    } catch (e) {}
  }

  /**
   * ⚠️ 这里**故意不做** quality id 反查。
   *
   * ## 为什么撤掉了
   *
   * 曾经试图用 `(height, codecFamily)` 从 playurl 的轨道清单里反查
   * "当前播放的是哪条 dash 轨"，再拿它的 `id` 判断 HDR / 杜比视界。
   * 这是**错的**，用户实测已经证明：
   *
   *   播的是 4K SDR + Hi-Res（AV1 编码），角标却显示「杜比视界 HDR」。
   *
   * 错在三点：
   *   1. 同高度的轨道有多条（4K SDR / HDR / 杜比视界都是 2160p），
   *      取 `same[0]` 完全取决于数组顺序，**不是当前播放的那条**
   *   2. `<video>` 元素只给宽高，**永远不知道自己在放哪条 dash 轨**
   *   3. 用编码家族去猜更不可靠：AV1 / HEVC 都能承载 SDR 和 HDR
   *
   * ## 结论
   *
   * **不显示无法确定的东西。** 角标只报三类可验证的事实：
   *   - 分辨率：来自 `<video>.videoHeight`（确定）
   *   - 音频特性：来自 SourceBuffer 的实际 mime（确定）
   *   - HDR：来自 `(video-dynamic-range: high)`（浏览器判断，确定）
   *
   * 杜比视界**不显示** —— 它和普通 4K 在浏览器 API 层面无法区分。
   * 宁可少说，不能说错。
   */

  /** 拦截 playurl 响应，把轨道清单记下来 */
  function capturePlayurlJson(url, text) {
    try {
      if (!isPlayurlPath(url)) return;
      var j = JSON.parse(text);
      var s = summarizePlayurl(j);
      if (!s) return;
      // 记住轨道清单，供 quality id 反查
      rememberVideoTracks(s);
      safePost({ __ns: NS, type: 'playurl-tracks', token: token, summary: s });

      /**
       * 再上报一次**原文**（只一次）。
       *
       * 为什么原文也要：ISOLATED 侧用 `core/playinfo/parse.ts` 统一解析，
       * 这样"主账号基线"和"播放账号实际拿到"走**同一套解析逻辑**，
       * 不会出现两套归一化互相漂移。上面的 summary 仍保留给角标/诊断用。
       */
      if (!rawPlayurlPosted) {
        rawPlayurlPosted = true;
        safePost({ __ns: NS, type: 'playurl-raw', token: token, json: j });
      }
    } catch (e) {}
  }

  /**
   * 主账号的**显示**信息（uname / face）。
   *
   * ⚠️ 只取这两个字段，**不碰任何凭据**。`mid` 由 ISOLATED 侧从页面 cookie 读
   * （`readPrimaryMidFromCookie`），不在这里重复取。
   * 游客态下 `__INITIAL_STATE__.user` 存在但没有 uname，返回 null。
   */
  function primaryUser() {
    try {
      var s = window.__INITIAL_STATE__;
      var u = s && s.user;
      if (!u) return null;
      var uname = typeof u.uname === 'string' ? u.uname : '';
      var face = typeof u.face === 'string' ? u.face : null;

      /**
       * 等级。B站把等级放在 `level_info.current_level`。
       *
       * ⚠️ **这个形状没有实测确认过**，所以容错读取：拿不到就是 null，
       * UI 会退化成"只读"标签。**绝不编一个等级** —— 卡片上写 LV6 就必须真是 6。
       */
      var level = null;
      try {
        if (u.level_info && typeof u.level_info.current_level === 'number') {
          level = u.level_info.current_level;
        }
      } catch (e) {}

      if (!uname && !face) return null;
      return { uname: uname, face: face, level: level };
    } catch (e) {
      return null;
    }
  }

  /**
   * 上报主账号基线（ADR 0014）。
   *
   * 会被调用多次（hello / ready / 延迟补报）：`__playinfo__` 与 `__INITIAL_STATE__`
   * 谁先就绪不确定，多报几次让 ISOLATED 侧做合并。重复上报是幂等的
   * （能力只在可用时接受，user 后到覆盖先到）。
   */
  function postSsrPlayinfo() {
    safePost({
      __ns: NS,
      type: 'ssr-playinfo',
      token: token,
      firstSeen: ssrFirstSeen,
      playurlBefore: ssrPlayurlBefore,
      data: ssrPlayinfo || null,
      user: primaryUser(),
    });
  }

  // ── 通信 ──
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__ns !== NS || d.type !== 'cfg') return;

    /**
     * ⚠️ **先处理载荷，再进行 token 校验。**
     *
     * 顺序踩过（2026-10-28）：原实现先校验 token，而 token 只由**第一个** `cfg`
     * 锁定。ISOLATED 侧第一次推的 `cfg` 往往不带 `pgcVideoInfo`（那时它还没读完缓存），
     * 带缓存的那次反而…能过校验。但换成"网页/测试先伪造一个 token 空串的 cfg"
     * 就会把下面整段挡掉 —— 表现为"缓存永远到不了主世界"。
     *
     * 现在的取舍：**数据类字段（`pgcVideoInfo`）先收，行为类开关（`enabled`）仍要 token。**
     * `pgcVideoInfo` 只是一份流地址，篡改它最多让播放器播别人的流（而那条流仍然要
     * 播放账号的 Cookie 才能取），拿不到凭据、改不了身份 —— 与主世界其它上报同级的风险。
     */
    var hasPgcPayload = d.pgcVideoInfo && typeof d.pgcVideoInfo === 'object';

    if (!tokenLocked) {
      if (d.token && typeof d.token === 'string') {
        token = d.token;
        tokenLocked = true;
      }
    } else if (!d.token || d.token !== token) {
      // token 对不上：只有"纯数据"能通过，任何开关/状态一律拒绝
      if (!hasPgcPayload || d.enabled !== undefined || d.pgcActive !== undefined) return;
    }

    // 配置变化仍然生效（将来若要支持热切换），但**回执只发一次**
    if (!!d.enabled !== enabled) {
      enabled = !!d.enabled;
      syncHooks();
    }

    /**
     * `page/activate` 的结果（只对 PGC 有意义）。
     *
     * `false` = background 明确没装规则（未配置 / 总开关关着 / 两个账号相同）。
     * 那时注入完整流毫无意义（请求还是主账号身份），而且没装规则说明用户不想用。
     * `true` / 未收到 → 允许注入。
     */
    if (typeof d.pgcActive === 'boolean') pgcActive = d.pgcActive;

    /**
     * PGC 完整流缓存（ADR 0020）—— ISOLATED 侧从 `storage.local` 预读后下发给这里。
     *
     * ## 为什么数据要往 `cfg` 里塞（明明 ADR 里有"握手消息不许放大对象"）
     *
     * 那条规则的教训是**回环**：`cfg` 每轮夹带几十 KB 会 OOM。这里不构成回环的两个理由：
     *   1. `cfg` 只由 ISOLATED 侧发，且已有一条"`ready` 不回 `cfg`"的硬约束（见下）
     *   2. 这份数据**只发一次**（`pgcVideoInfo` 送达后置空），不是每轮都带
     *
     * 体积也要控制：只带 `video_info`（实测约 20–40 KB），不带整份 `__playinfo__`
     * （那还含 `arc` / `plugin` / 弹幕配置等，几倍大且用不上）。
     */
    if (IS_PGC && d.pgcVideoInfo && typeof d.pgcVideoInfo === 'object') {
      pgcCachedVideoInfo = d.pgcVideoInfo;
      /**
       * 记住这份缓存对应的 cid（消息里带 `pgcCid` 就用它，否则沿用当前页面 cid）。
       *
       * ⚠️ 不记归属会导致 SPA 切集时把新送来的缓存误判成"上一集的"而丢掉
       * —— 那个 bug 让注入连续失效过三轮。
       */
      pgcCachedForCid =
        typeof d.pgcCid === 'string' && d.pgcCid ? d.pgcCid : pgcPatchedCid || '';
      pgcTrace.cacheBytes = JSON.stringify(d.pgcVideoInfo).length;
      pgcTrace.lastStage = 'cfg-with-cache';
      pgcPost('cfg', '收到缓存 video_info（' + pgcTrace.cacheBytes + ' B）');
      // 缓存可能比 `__playinfo__` 赋值晚到 —— 那就补一次
      if (playinfoValue && !pgcPatched) pgcPatchPlayinfo(playinfoValue);
    }

    /**
     * ⚠️ **`ready` 只能回一次 —— 这是防无限回环的唯一闸门。**
     *
     * ISOLATED 侧收到 `ready` 会回发 `cfg`，而这里收到 `cfg` 又回 `ready`。
     * 2026-10-26 实测：这个回环本来就在（当时每轮只发两个小消息，表现为空转 CPU），
     * 后来往 `cfg` 里加了一份完整的 `__playinfo__` 上报，于是每轮都结构化克隆几十 KB，
     * 视频页停留几十秒就 **Out of Memory**（页面崩溃，两种模式都会）。
     *
     * 两道保险：
     *   1. 这里用 `cfgApplied` 卡住回执
     *   2. ISOLATED 侧也不再对 `ready` 回 `cfg`（见 `entrypoints/content.ts`）
     * 只留一道也能断环，但**任何一道被后人"优化"掉都会立刻复发**，所以两道都留。
     *
     * 顺带：**握手消息里不许放大对象**。基线数据走 `hello` + 两次延迟补报，
     * 不搭 `cfg` 的车 —— 握手有回程，数据没有。
     */
    if (cfgApplied) return;
    cfgApplied = true;

    safePost({ __ns: NS, type: 'ready', token: token, enabled: enabled });
  });

  // ── 就绪握手 ──
  // 带上注入时刻的关键状态，用于确认 hook 有没有抢在 SSR 之前。
  safePost({
      __ns: NS,
      type: 'hello',
      token: '',
      flags: {
        define: defineResult,
        hadExisting: hadExisting,
        playinfo: playinfoState(),
        hasInitialState: typeof window.__INITIAL_STATE__ !== 'undefined',
        readyState: document.readyState,
      },
    },
    '*',);

  /**
   * 主账号基线：立刻报一次，再延迟补两次。
   *
   * 为什么延迟：`document_start` 时 `__INITIAL_STATE__`（uname）通常还没就绪，
   * 而 `__playinfo__` 可能在页面脚本跑完之后才被赋值。
   * 补报不改变判定 —— `ssrFirstSeen` 在第一次赋值时就定死了。
   */
  postSsrPlayinfo();
  setTimeout(postSsrPlayinfo, 1500);
  setTimeout(postSsrPlayinfo, 5000);
})();
