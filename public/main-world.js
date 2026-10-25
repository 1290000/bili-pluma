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

  // ── 1. 藏起 SSR 的 __playinfo__ ──
  // 关键：defineProperty 必须早于 SSR 内联脚本执行。
  // content script 在 document_start 执行 → 早于页面任何脚本，满足条件。
  var playinfoHidden = false;
  var playinfoValue = undefined;
  var defineResult = 'skipped';
  var hadExisting = typeof window.__playinfo__ !== 'undefined';

  try {
    Object.defineProperty(window, '__playinfo__', {
      configurable: true,
      enumerable: true,
      get: function () {
        return playinfoHidden ? undefined : playinfoValue;
      },
      set: function (v) {
        playinfoValue = v;
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

  // ── 2. 伪装 SSR 里的本地会员状态 ──
  function patchSsUser() {
    try {
      var s = window.__INITIAL_STATE__;
      if (!s || !s.user || typeof s.user !== 'object') return;

      if (typeof s.user.vipStatus === 'number' && s.user.vipStatus !== 1) s.user.vipStatus = 1;
      if (typeof s.user.vipType === 'number' && s.user.vipType !== 2) s.user.vipType = 2;

      if (s.user.vip && typeof s.user.vip === 'object') {
        if (typeof s.user.vip.status === 'number' && s.user.vip.status !== 1) s.user.vip.status = 1;
        if (typeof s.user.vip.type === 'number' && s.user.vip.type !== 2) s.user.vip.type = 2;
      }
    } catch (e) {}
  }

  var patchTimer = null;

  function syncHooks() {
    playinfoHidden = enabled;

    if (enabled) {
      if (!patchTimer) patchTimer = setInterval(patchSsUser, 100);
      patchSsUser();
    } else if (patchTimer) {
      clearInterval(patchTimer);
      patchTimer = null;
    }
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

  /** 需要改写响应的路径（播放器信息，含会员状态） */
  var PATCH_PATHS = ['/x/player/wbi/v2', '/x/player/v2'];

  function matchPath(url, list) {
    try {
      var u = new URL(url, location.href);
      if (u.protocol !== 'https:') return false;
      if (u.hostname !== 'api.bilibili.com') return false;
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
      window.postMessage(
        { __ns: NS, type: 'patch', token: token, path: path, ok: ok },
        '*',
      );
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

  /** 统计各类 SourceBuffer 的活跃数量（诊断用） */
  function sbStats(list) {
    var active = 0;
    var now = Date.now();
    for (var i = 0; i < list.length; i++) {
      // 3 秒内有写入视为活跃
      if (list[i].lastUpdate && now - list[i].lastUpdate < 3000) active += 1;
    }
    return { total: list.length, active: active };
  }

  /**
   * 列出所有活跃轨道及其写入时间差。
   *
   * 用途：切音质时如果出现「音频2/2」，说明旧轨没被销毁、两条都在写。
   * 这时要判断哪条是"主轨"——通常是**更早开始写的那条**（旧轨还在续写）
   * 或者**最新开始写的那条**（新轨接管中），只能靠时间差推断。
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
    setTimeout(function () {
      var r = hdrReport();
      var act = activeCodec();
      var audio = activeAudioCodec();
      window.postMessage(
        {
          __ns: NS,
          type: 'hdr',
          token: token,
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
          // SourceBuffer 统计：active > 1 说明旧轨没被删，切换是"叠加"而非"替换"
          vsb: sbStats(videoSbs),
          asb: sbStats(audioSbs),
          // 逐条列出活跃轨与最后写入时间差
          vDetail: sbDetail(videoSbs),
          aDetail: sbDetail(audioSbs),
        },
        '*',
      );
    }, delayMs);
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
  reportHdrAfter(6000);
  reportHdrAfter(15000);
  reportHdrAfter(30000);

  // 3a. 观测 playurl 请求
  var reported = {};

  /** 记录请求 URL（含查询参数摘要），用于确认播放器请求的是哪条轨道 */
  function noteRequest(url, method) {
    try {
      if (!/\/x\/player\/(wbi\/)?playurl/.test(url)) return;
      var key = url.split('?')[0] + '|' + (method || 'GET');
      if (reported[key]) return;
      reported[key] = 1;
      window.postMessage(
        { __ns: NS, type: 'req', token: token, method: method || 'GET', url: url },
        '*',
      );
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

      window.postMessage(
        { __ns: NS, type: 'codec', token: token, mime: mimeType, from: from, kind: bucket === videoCodecs ? 'video' : 'audio' },
        '*',
      );
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

    var entry = { codec: name, lastUpdate: 0 };
    (isVideo ? videoSbs : audioSbs).push(entry);

    buf.addEventListener('error', function () {
      window.postMessage({ __ns: NS, type: 'sb-error', token: token, mime: name }, '*');
    });

    buf.addEventListener('updateend', function () {
      // 每次写入都刷新时间——这是判断"谁在播"的依据
      entry.lastUpdate = Date.now();

      if (buf.__plumaSeen) return;
      buf.__plumaSeen = true;
      window.postMessage(
        {
          __ns: NS,
          type: 'sb-ok',
          token: token,
          mime: name,
          kind: isVideo ? 'video' : 'audio',
          buffered: buf.buffered && buf.buffered.length ? buf.buffered.end(0) : 0,
        },
        '*',
      );
    });
  }

  // 拦截 1：addSourceBuffer（最准）
  try {
    var origAddSB = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mimeType) {
      noteCodec(mimeType, 'addSourceBuffer');
      var sb = origAddSB.apply(this, arguments);
      trackSourceBuffer(sb, mimeType);
      return sb;
    };
  } catch (e) {}

  // 拦截 2：isTypeSupported（播放器选编码前一定会问能不能解）
  // 这能告诉我们"它考虑过哪些编码"，即使最后没选
  try {
    var origIsSupported = MediaSource.isTypeSupported;
    MediaSource.isTypeSupported = function (mimeType) {
      var r = origIsSupported.apply(this, arguments);
      if (r) noteCodec(mimeType, 'isTypeSupported');
      return r;
    };
  } catch (e) {}

  // 拦截 3：ManagedMediaSource（新版播放器可能用这个）
  // ⚠️ 必须和拦截 1 做同样的追踪注册，否则视频轨会漏掉（踩过：视频0/0）
  try {
    if (window.ManagedMediaSource && window.ManagedMediaSource.prototype.addSourceBuffer) {
      var origMAddSB = window.ManagedMediaSource.prototype.addSourceBuffer;
      window.ManagedMediaSource.prototype.addSourceBuffer = function (mimeType) {
        noteCodec(mimeType, 'ManagedMediaSource');
        var sb = origMAddSB.apply(this, arguments);
        trackSourceBuffer(sb, mimeType);
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
   * ⚠️ 不能简单取"最后创建的"：
   * 播放器切音轨时会新建 SourceBuffer，但不一定删掉旧的，
   * 而且 `addSourceBuffer` 的调用顺序 ≠ 当前播放的轨道。
   *
   * 更可靠的做法：记录每个音轨的「最近一次收到数据的时间」，
   * 取最近还在被写入的那条——那才是真正在播的。
   */
  function activeAudioCodec() {
    var best = null;
    for (var i = 0; i < audioSbs.length; i++) {
      var a = audioSbs[i];
      if (!a.lastUpdate) continue;
      if (!best || a.lastUpdate > best.lastUpdate) best = a;
    }
    return best ? best.codec : '?';
  }

  /** 当前在用的视频编码（同样按最近写入时间判断） */
  function activeCodec() {
    var best = null;
    for (var i = 0; i < videoSbs.length; i++) {
      var v = videoSbs[i];
      if (!v.lastUpdate) continue;
      if (!best || v.lastUpdate > best.lastUpdate) best = v;
    }
    return best ? best.codec : '?';
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
  // 注意：改写的监听必须在 open() 时挂上（而不是 send() 里），
  // 否则同步 XHR 或快速完成的请求可能已经结束，来不及改写。
  var origAddListener = XMLHttpRequest.prototype.addEventListener;
  try {
    var origOpen = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function (method, url) {
      var xhr = this;
      var abs = url;
      try {
        abs = new URL(url, location.href).href;
      } catch (e) {}
      xhr.__plumaUrl = abs;
      noteRequest(abs, method);

      // 需要监听的两种情况：
      //   PATCH_PATHS  → 要改写会员状态
      //   playurl      → 要记录音频轨道清单（Hi-Res / 杜比有没有下发）
      var isPlayurl = /\/x\/player\/(wbi\/)?playurl/.test(abs);
      if (matchPath(abs, PATCH_PATHS) || isPlayurl) {
        xhr.__plumaPatched = false;
        origAddListener.call(xhr, 'readystatechange', function () {
          if (xhr.readyState !== 4) return;
          if (xhr.__plumaPatched) return;
          xhr.__plumaPatched = true;
          try {
            var raw = xhr.responseText;
            if (typeof raw !== 'string' || !raw) return;

            // 先记录 playurl 的轨道清单（不管 enabled，这是纯观测）
            capturePlayurlJson(xhr.__plumaUrl, raw);

            // enabled 检查放在这里：open() 时配置可能还没下发
            if (!enabled) return;
            var patched = patchResponseText(xhr.__plumaUrl, raw);
            if (patched === raw) return;
            reportPatch(xhr.__plumaUrl, true);
            Object.defineProperty(xhr, 'responseText', { configurable: true, value: patched });
            if (xhr.responseType === 'json') {
              Object.defineProperty(xhr, 'response', { configurable: true, value: JSON.parse(patched) });
            } else if (xhr.responseType === '' || xhr.responseType === 'text') {
              Object.defineProperty(xhr, 'response', { configurable: true, value: patched });
            }
          } catch (e) {}
        });
      }

      return origOpen.apply(this, arguments);
    };
  } catch (e) {}

  // ── fetch hook ──
  try {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        var self = this;
        var args = arguments;
        var url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
          url = new URL(url, location.href).href;
          noteRequest(url, (init && init.method) || (input && input.method) || 'GET');
        } catch (e) {}

        var p = origFetch.apply(self, args);

        var isPlayurl = /\/x\/player\/(wbi\/)?playurl/.test(url);
        var needPatch = enabled && matchPath(url, PATCH_PATHS);

        // playurl 只为记录轨道清单，不改内容；PATCH_PATHS 才改写
        if (!needPatch && !isPlayurl) return p;

        return p.then(function (resp) {
          if (!resp || !resp.ok) return resp;
          return resp
            .clone()
            .text()
            .then(function (t) {
              if (isPlayurl) capturePlayurlJson(url, t);
              if (!needPatch) return resp;

              var patched = patchResponseText(url, t);
              if (patched !== t) reportPatch(url, true);
              return new Response(patched, {
                status: resp.status,
                statusText: resp.statusText,
                headers: resp.headers,
              });
            })
            .catch(function () {
              return resp;
            });
        });
      };
    }
  } catch (e) {}

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
        return { id: v.id, h: v.height, codecid: v.codecid, bw: v.bandwidth || 0 };
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

      return { audio: audioList, video: videoList, flac: flacInfo, dolby: dolbyList };
    } catch (e) {
      return null;
    }
  }

  /** 拦截 playurl 响应，把轨道清单记下来 */
  function capturePlayurlJson(url, text) {
    try {
      if (!/\/x\/player\/(wbi\/)?playurl/.test(url)) return;
      var j = JSON.parse(text);
      var s = summarizePlayurl(j);
      if (!s) return;
      window.postMessage({ __ns: NS, type: 'playurl-tracks', token: token, summary: s }, '*');
    } catch (e) {}
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

    enabled = !!d.enabled;
    syncHooks();

    window.postMessage({ __ns: NS, type: 'ready', token: token, enabled: enabled }, '*');
  });

  // ── 就绪握手 ──
  // 带上注入时刻的关键状态，用于确认 hook 有没有抢在 SSR 之前。
  window.postMessage(
    {
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
    '*',
  );
})();
