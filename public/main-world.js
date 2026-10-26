/**
 * 主世界脚本 —— 以「扩展内资源文件」形式注入页面。
 *
 * 这是**唯一源文件**（不再从 TS 模板生成），避免两份代码漂移。
 *
 * ## 为什么必须是独立文件而不是内联 script
 * MV3 默认 CSP 禁止执行内联脚本。内联注入会**静默失败**：
 * 插入语句成功返回，但脚本从未执行。
 * （踩过：page/quality 有记录、主世界零输出。）
 *
 * ## 为什么要注入主世界
 * 只靠 DNR 换 Cookie 不够，有两个页面侧的障碍：
 *
 * 1. B站把播放数据 SSR 进 window.__playinfo__
 *    播放器直接读这个全局变量，根本不发 playurl 请求 → DNR 没有请求可改。
 *    必须在页面读它之前藏起来，逼播放器走 playurl API。
 *
 * 2. 播放器用 window.__INITIAL_STATE__.user.vipStatus 判断能否选高清
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
      },
    });
    defineResult = 'ok';
  } catch (e) {
    defineResult = 'fail:' + (e && e.message ? String(e.message).slice(0, 40) : 'unknown');
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
    playinfoHidden = enabled;
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

  /**
   * 把响应 JSON 里所有「会员形状」的对象改成会员。
   *
   * 只动 status / type / due_date 这几个**显示用**字段，
   * 不碰 mid、不碰权限位（rights），避免影响身份归属判断。
   */
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
      if (!/\/x\/player\/(wbi\/)?playurl/.test(url)) return;
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

        // 只监听 playurl —— 纯粹为了记录轨道清单，不碰响应内容
        if (/\/x\/player\/(wbi\/)?playurl/.test(abs)) {
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
              if (typeof raw === 'string' && raw) capturePlayurlJson(xhr.__plumaUrl, raw);
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

        var isPlayurl = /\/x\/player\/(wbi\/)?playurl/.test(url);
        var needPatch = enabled && matchPath(url, PATCH_PATHS);

        // **两条路都不需要 → 一字节都不碰**
        if (!needPatch && !isPlayurl) return p;

        return p.then(function (resp) {
          if (!resp || !resp.ok) return resp;

          // 只需要记录轨道清单时，用 clone 是安全的：
          // 拿副本去读，原 resp 仍然完好交回给页面
          if (!needPatch) {
            var copy;
            try {
              copy = resp.clone();
            } catch (e) {
              return resp;
            }
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
      if (!/\/x\/player\/(wbi\/)?playurl/.test(url)) return;
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
      if (!uname && !face) return null;
      return { uname: uname, face: face };
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

    if (!tokenLocked) {
      if (!d.token || typeof d.token !== 'string') return;
      token = d.token;
      tokenLocked = true;
    } else if (!d.token || d.token !== token) {
      return;
    }

    // 配置变化仍然生效（将来若要支持热切换），但**回执只发一次**
    if (!!d.enabled !== enabled) {
      enabled = !!d.enabled;
      syncHooks();
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
