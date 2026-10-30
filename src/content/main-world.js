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

  /**
   * 「token 握手现在处于什么状态」的埋点对象（B-04，2026-10-29）。
   *
   * 只观测，不改握手行为 —— 理由见「通信」一节里写它的那段注释
   * （`docs/plans/1.0.0-release-plan.md` §11 决策 D1：方案丙）。
   *
   * 「最近一次收到的 token 是否与锁定的相同」这个字段（`matches`）
   * 决定了几件事：`false` + `locked === true` 就是「新 token 被拒」的状态。
   *
   * 注意别和 `window.__PLUMA_MAIN__` 搞混：那个是**布尔守卫**，
   * 含义是"主世界脚本已经加载过"（重复注入靠它挡），由本文件最开头置位。
   * 所以这里**不能**复用它，另开 `window.__PLUMA_HANDSHAKE__`。
   *
   * ⚠️ **在这里就建好并挂上去**，不要等第一条 `cfg` 才建：
   * 诊断侧可能在页面加载早期就来读，那时 `undefined` 和"没锁定"分不清，
   * 而这两件事在排查 B-04 时完全不是一回事。
   */
  var handshakeTrace = { locked: false, matches: null, seen: 0, rejected: 0 };

  /**
   * `cfg` 里那个 `enabled` 开关的**最近一次明确值**。`null` = 还没收到任何 `cfg`。
   *
   * ⚠️ 与文件后面那个 `var enabled = false` **不是一回事**，别合并：
   *   - `enabled`（第 47 行）是主世界自己的**行为开关**，初值 `false`，
   *     决定要不要藏 `__playinfo__` / 轮询会员状态
   *   - 这个的用途只有一个：**在诊断里回答"当时开关是什么值"**
   *     （`lastSkipEnabled` 要报它）。`enabled` 在 `cfg` 到达前是 `false`，
   *     conflate 会把"还没收到"误报成"用户关了"
   */
  var cfgEnabled = null;

  try {
    window.__PLUMA_HANDSHAKE__ = handshakeTrace;
  } catch (e) {}

  var IS_PGC = location.pathname.indexOf('/bangumi/play/') === 0;

  /**
   * ## 观测 `createPlayer` 的调用时刻 —— **只记时间，不改行为**（2026-10-29 加）
   *
   * ## 为什么需要它
   *
   * 真机现场：`ssAt 749 / patchedAt 750`（注入只晚 1ms，确实在 setter 里同步做了），
   * 但 `video.duration` 仍是 180。纸面上"同步注入 + 1ms"该赢，实际没赢。
   *
   * 继续推理已经失败过一次（我先后猜过「durls 求和误判」「cfg 补注入」，
   * 都被数据推翻）。所以把「播放器什么时候调用 `createPlayer`」**测出来**：
   *
   * - `createPlayerAt > patchedAt` → 注入先于读数据，播放器**应该**读到新流。
   *   若 `duration` 仍 180，说明播放器读的**不是** `__playinfo__`（或读的是被缓存的副本）。
   * - `createPlayerAt < patchedAt` → 播放器先读了旧数据，注入再成功也没用，**必须 reload**。
   *
   * ## ⚠️ 只用 `apply` 透传，绝不替换逻辑（ADR 0019 的教训）
   *
   * ADR 0019 曾经想「hook `createPlayer` 换回调」，真机三条证据把它否掉了。
   * 那个否掉的结论是「**不要靠改 createPlayer 来注入流**」，
   * 不是「不能观察它」。这里只在调用**之前**记一个时间戳，然后原样 `apply` ——
   * 参数不碰、返回值不碰、`this` 不碰。
   *
   * ## 为什么挂 `window.nano` 的 setter
   *
   * `createPlayer` 不是全局函数，它挂在页面自己赋值的 `window.nano` 上
   * （`poc/probe/probe-pgc-timing.cjs` 实测验证过这条路可行）。
   * 在 `document_start` 抢在页面脚本之前挂 setter，才能在 `nano` 一赋值就包住它。
   *
   * 失败（页面没有 `nano` / `defineProperty` 被拒）只影响观测，不影响功能。
   */
  function installCreatePlayerProbe() {
    if (!IS_PGC) return;
    var nanoRef;
    try {
      Object.defineProperty(window, 'nano', {
        configurable: true,
        enumerable: true,
        get: function () {
          return nanoRef;
        },
        set: function (v) {
          nanoRef = v;
          if (!v || typeof v.createPlayer !== 'function') return;
          // 已经包过就不再包（防止重复注入叠罗汉）
          if (v.createPlayer.__plumaProbed) return;
          var orig = v.createPlayer;
          var wrapped = function () {
            try {
              pgcTrace.createPlayerCalls += 1;
              if (pgcTrace.createPlayerAt < 0) {
                pgcTrace.createPlayerAt = performance.now
                  ? Math.round(performance.now())
                  : -1;
              }
            } catch (e) {}
            // 原样透传：参数、this、返回值全不动
            return orig.apply(this, arguments);
          };
          wrapped.__plumaProbed = true;
          v.createPlayer = wrapped;
        },
      });
    } catch (e) {
      /* 观测装不上就算了，不影响播放 */
    }
  }

  /**
   * `page/activate` 的结果。`false` = 明确没装规则（未配置 / 总开关关 / 同账号 / 出错）。
   *
   * ## ⚠️ 它**不是**判断总开关的合适信号（2026-10-29 真机否掉过一次）
   *
   * 它只由 `page/activate` 的回复驱动（`content.ts:1085`），而那条路要走
   * content → background 解密凭据 → 装 DNR 规则 → 返回。页面对 `__playinfo__`
   * 的赋值在 ~409–599ms，**这两者没有先后保证**。
   *
   * 曾经把门控写成 `if (pgcActive !== true) return;`（未知即拒绝），真机一测：
   * **开关正常开着时 `skipUnknownCount` 也会 +1**，注入从 ~600ms 拖到 1879ms。
   * 原因：`hello` 那条 `cfg`（`content.ts:296`）**不带 `pgcActive`**，只带 `enabled`。
   * 所以"`pgcActive` 未知"是**每次正常加载的常态**，不是极端时序。
   *
   * 现在：`null` 一律放行；总开关的判断改用 `cfgEnabled`（见 `pgcPatchPlayinfo`）。
   * 这个变量只剩一个用途 —— `pgcActive === false` 时拦住"页面级激活失败"那几种情况。
   */
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
   * 截断判定的容差：**5 秒**。
   *
   * ⚠️ **必须与 `src/content/isolated/pgc-cache-inject.ts` 的
   * `TRUNCATION_SLACK_MS` 一致**。主世界是裸 JS，无法 import 那个常量。
   *
   * 为什么需要容差：实测 `timelength = 1440083ms`、`dash.duration = 1441s`
   * （= 1441000ms），差 917ms 是正常的秒/毫秒取整。不设容差的话完整集
   * 也会被误判成"被截断"，于是每集都白取一次流。
   *
   * 一致性由 `tests/unit/content/main-world-pgc.test.ts` 读源码比对断言。
   */
  var PGC_TRUNCATION_SLACK_MS = 5000;

  /**
   * 同步读缓存。
   *
   * @param {string} cid 章节 id
   * @returns {object|null}
   *
   * ⚠️ **永不抛错**：`sessionStorage` 在隐私模式 / 配额满 / 跨源 iframe 里可能抛。
   * 抛在 `document_start` 会让整份脚本挂掉，那比"没有缓存"严重得多。
   */
  /**
   * 判断一份 `video_info` 的流**是否短于 `timelength`**（= 试看流）。
   *
   * ## 为什么主世界也要判这一道（2026-10-29 加，问题 5 的最后一道防线）
   *
   * ISOLATED 侧已经在**写入**（`prepareFullStream`）和**读取**（`orchestratePgc`）
   * 两处校验了。这里是第三道，理由有两条：
   *
   * 1. **旧版本的坏数据还在用户机器上**。`sessionStorage` 的 TTL 是 100 分钟，
   *    只要它还没过期，主世界就可能读到 —— 而主世界正是**直接把它注入**的那一方。
   * 2. 主世界与 ISOLATED 是两个 world，`cfg.pgcVideoInfo` 那条**绕过 sessionStorage**
   *    直接送进来（见 `cfg` 分支），那条路不经过 `pgcReadCacheSync`。
   *
   * ## 判据与 `pgc-cache-inject.ts` 的 `isStreamTruncated` **必须同源**
   *
   * 裸 JS 无法 import，所以这里是**手写的一份等价实现**。
   * 两者不一致的后果是"上层觉得是试看、下层觉得能用"，注入照旧发生。
   * 一致性由 `tests/unit/content/main-world-pgc.test.ts` 读源码逐个比对常量断言。
   *
   * ## ⚠️ 不能拿"有没有 dash"当判据
   *
   * 完整集也可能是**纯 durl**（`fnval=0` 的老路：单段 durl，长度 = timelength）。
   * 用"有没有 dash"会把那种合法缓存误杀 → 每次进页面都白取一次流。
   * 长度判据对两种形态都成立。
   *
   * 判断不了（没有可比的时长字段）时**返回 false**（放行）—— 与
   * `isStreamTruncated` 的"保守不注入"方向一致：宁可播一次旧缓存，
   * 也不要因为判不出来就把正常数据丢掉。
   *
   * @param {object} vi `video_info`
   * @returns {boolean} `true` = 流短于 timelength（试看流）
   */
  function pgcVideoInfoTruncated(vi) {
    if (!vi || typeof vi !== 'object') return false;
    var timelengthMs = typeof vi.timelength === 'number' ? vi.timelength : 0;
    if (!(timelengthMs > 0)) return false;

    // ① durl：把所有段相加（多段完整流不能只看第一段；2026-10-29 verifier 反例）
    if (Array.isArray(vi.durl) && vi.durl.length > 0) {
      var totalDurlMs = 0;
      for (var di = 0; di < vi.durl.length; di += 1) {
        var seg = vi.durl[di];
        if (seg && typeof seg === 'object' && typeof seg.length === 'number' && seg.length > 0) {
          totalDurlMs += seg.length;
        }
      }
      if (totalDurlMs > 0) return totalDurlMs < timelengthMs - PGC_TRUNCATION_SLACK_MS;
    }

    // ② dash
    var dash = vi.dash;
    var dashSec = dash && typeof dash.duration === 'number' ? dash.duration : 0;
    if (dashSec > 0) return dashSec * 1000 < timelengthMs - PGC_TRUNCATION_SLACK_MS;

    // ③ durls：只看第一组的段总长（各画质组时长相同）
    var durls = vi.durls;
    if (Array.isArray(durls) && durls.length > 0) {
      var totalMs = 0;
      for (var gi = 0; gi < durls.length; gi += 1) {
        var g = durls[gi];
        if (!g || typeof g !== 'object') continue;
        var segs = g.durl;
        if (!Array.isArray(segs)) continue;
        for (var si = 0; si < segs.length; si += 1) {
          var s = segs[si];
          if (s && typeof s === 'object' && typeof s.length === 'number') totalMs += s.length;
        }
        break;
      }
      if (totalMs > 0) return totalMs < timelengthMs - PGC_TRUNCATION_SLACK_MS;
    }

    // 判断不了 → 放行
    return false;
  }

  function pgcReadCacheSync(cid) {
    if (!cid) return null;
    try {
      var raw = window.sessionStorage.getItem(PGC_SS_PREFIX + cid);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      // 过期判断：流地址实测约 110 分钟，缓存写的时候带 ttl
      if (typeof o.exp === 'number' && Date.now() > o.exp) return null;
      var vi = o.vi && typeof o.vi === 'object' ? o.vi : null;
      if (!vi) return null;
      /**
       * 读取侧的第三道防线：**短于 timelength 的缓存不拿来注入**。
       *
       * 旧版本会把「durl 180 秒 + timelength 19 分钟」这种自相矛盾的数据
       * 写进缓存（写入侧校验是 2026-10-29 才加的）。那种数据注入进去，
       * 播放器只能播 180 秒 —— 表现为「重开开关后画质不恢复」。
       *
       * 这里返回 `null` 而不是删掉 key：主世界不该做删除（它是页面的"旁观者"），
       * 而且删了也没用 —— ISOLATED 侧下一趟会重新写。返回 null 的效果是
       * "这次没有缓存可用"，播放器照常播 SSR 的试看流，等 ISOLATED 去取完整流。
       */
      if (pgcVideoInfoTruncated(vi)) {
        pgcTrace.cacheRejectedTruncated = true;
        pgcPost('cache-truncated', '同步缓存短于 timelength，拒绝注入');
        return null;
      }
      return vi;
    } catch (e) {
      return null;
    }
  }

  /**
   * 总开关「关着」的本地标记（ADR 0028 第一层）。
   *
   * ⚠️ **必须与 `entrypoints/content.ts` 的 `PROXY_OFF_KEY` 字符串一致**。
   * 主世界是裸 JS（不参与 TS 编译），无法共享常量，所以两边各写一份；
   * 不一致的后果是"门控静默失效"，与 `PGC_SS_PREFIX` 是同一类风险。
   * 一致性由 `tests/unit/content/main-world-pgc.test.ts` 读源码断言。
   */
  var PROXY_OFF_KEY = 'pluma:proxy-off';

  /**
   * 标记的时间上界：30 分钟。
   *
   * ## 为什么必须有上界（ADR 0028「第一层」的「新鲜」一条）
   *
   * 标记记的是**写入那一刻**的状态，不是**读的那一刻**的状态。
   * 某次写入失败（配额满 / 隐私模式 / SW 没醒）会留下一个旧标记，
   * 若永久有效就会**永久拦住注入** —— 那等于让 PGC 功能静默消失。
   *
   * 给一个时间上界，把"最多错多久"变成可陈述的数字：最坏 30 分钟。
   * 到期后标记自动失效、恢复放行，用户重开开关也不会被困住。
   */
  var PROXY_OFF_TTL_MS = 30 * 60 * 1000;

  /**
   * 读「总开关关着」的标记 —— **三态**，与 `cfgEnabled` 同构。
   *
   * | 返回 | 含义 | 调用方动作 |
   * | --- | --- | --- |
   * | `true` | 标记存在且新鲜 → 开关明确关着 | **不注入** |
   * | `null` | 没有标记 / 已过期 / 读不出来 | 放行（判不了） |
   *
   * ⚠️ **永不返回 `false`**：用 `null` 表示"判不了"，这样调用点写成
   * `=== true` 才拦，**默认方向是放行**。ADR 0028 的硬约束是
   * 「不放行比多注入危险得多」—— 判不了时宁可多注入一次。
   *
   * ## 为什么用 `localStorage` 而不是 `sessionStorage`
   *
   * 三个性质缺一不可（ADR 0028「第一层」的表格）：
   *   - **同步 API**：读在 `__playinfo__` 的 setter 里，只有微秒级预算
   *   - **跨标签页共享**：一处写，所有已开的番剧标签页全部生效（补掉洞 3）
   *   - **不依赖扩展消息**：`cfg` 永远不到也照样能判（不违背"不许绑异步通道"）
   *
   * ⚠️ **永不抛错**：隐私模式 / 配额满时 `localStorage` 会抛。
   * 抛在 `document_start` 会让整份脚本挂掉，那比"没有门控"严重得多。
   *
   * @returns {boolean|null} `true` = 明确关着；`null` = 判不了
   */
  function pgcReadProxyOff() {
    try {
      var raw = window.localStorage.getItem(PROXY_OFF_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      var at = o.at;
      if (typeof at !== 'number') return null;
      // 未来时间戳（用户改过系统时钟）也算数，但同样受上界约束
      var age = Date.now() - at;
      if (!(age < PROXY_OFF_TTL_MS)) return null;
      return true;
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
          /**
           * 记录 `__playinfo__` 被赋值的时刻（只观测）。
           *
           * 与 `patchedAt` 相减 = 「赋值 → 注入完成」的耗时；
           * 与 `createPlayerAt` 相减 = 「赋值 → 播放器建好」的耗时。
           * 排查「注入了但 duration 还是 180」时这三个时刻必须一起看。
           */
          try {
            if (pgcTrace.playinfoAt < 0 && performance.now) {
              pgcTrace.playinfoAt = Math.round(performance.now());
            }
          } catch (e) {}
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
            // `true` = 来自 setter 同步路径（唯一能赶上播放器的时机）
            pgcPatchPlayinfo(v, true);
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
     * ## 这次注入**有没有赶上播放器**（2026-10-29 加，排查「注入了但 duration 还是 180」）
     *
     * 真机现场（`ep3854818`，开关开着、刷新后）：
     *
     * ```
     * ssAt      : 749   ← setter 触发
     * patchedAt : 750   ← 只晚 1ms，注入**确实**在 setter 里同步完成
     * duration  : 180   ← 但播放器仍在播试看
     * ```
     *
     * 纸面上「同步注入 + 只差 1ms」应该赢，实际没赢。所以需要把
     * 「注入」和「播放器读数据」这两件事的先后**测出来**，而不是继续推理。
     *
     * - `patchedInSetter`：注入发生在 setter 同步路径（true）还是 `cfg` 补注入（false）。
     *   ⚠️ **不能用 `lastStage` 代替** —— `cfg` 分支会在注入之后把 `lastStage`
     *   覆写成 `'cfg-with-cache'`，看它完全判断不出注入来源（已害过一次误判）。
     * - `injectedFrom` / `injectedTo`：注入前后 `dash.duration`。
     *   若 from=180、to=1166 则注入数据是对的，问题在「播放器没采用」；
     *   若 to 也是 180，则注入本身有问题。
     * - `createPlayerAt`：页面 `createPlayer` 被调用的时刻（`-1` = 没观测到）。
     *   与 `patchedAt` 比大小就能定死是「读之前」还是「读之后」。
     * - `playinfoAt`：`__playinfo__` 被赋值的时刻，用于核对 setter 时序。
     */
    patchedInSetter: null,
    injectedFrom: -1,
    injectedTo: -1,
    createPlayerAt: -1,
    createPlayerCalls: 0,
    playinfoAt: -1,
    /**
     * 读取侧有没有因为"流短于 timelength"而拒绝过同步缓存（2026-10-29 加，问题 5）。
     *
     * `true` = 至少有一次读到了试看流缓存并**没有**注入它。
     * 排查「重开开关后仍卡在试看」时要看这个：它为 true 说明坏缓存被挡住了，
     * 剩下的问题在 ISOLATED 侧能不能取到完整流。
     */
    cacheRejectedTruncated: false,

    /**
     * 注入被门控拦下的**累计次数**（2026-10-29 加，配合问题 4 的门控）。
     *
     * 为什么计数而不是只记 `lastStage`：`lastStage` 是"最后一次"，
     * 刷新一次就被覆盖；而这两个数的意义在于**判断分支死活**：
     *
     * - `skipDisabledCount`：「总开关关着所以不注入」。**预期内**的正常拒绝，
     *   关开关后刷新番剧页应该看到它 ≥1、且画质回落。
     * - `skipInactiveCount`：「`page/activate` 回报未激活（未配置 / 同账号 / 出错）」。
     *   也属于预期内。
     *
     * ⚠️ **曾经还有一个 `skipUnknownCount`**（"`pgcActive` 还没到就不注入"），
     * 2026-10-29 真机实测后删掉：它在**开关正常开着**时也会 +1，
     * 因为 `pgcActive` 要等 `page/activate` 往返，而 `hello` 那条 `cfg`
     * 只带 `enabled`。拿"未知"当拒绝等于每次正常加载都漏一次注入。
     * 现在未知一律放行，改用 `cfgEnabled` 判断总开关（见 `pgcPatchPlayinfo`）。
     */
    skipDisabledCount: 0,
    skipInactiveCount: 0,
    /**
     * 被**第一道**（`localStorage` 的 `pluma:proxy-off` 标记）拦下的次数（ADR 0028）。
     *
     * ## 为什么三个计数必须分开（不能合成一个）
     *
     * 上一轮排查走了三版弯路，一半原因是"看不出是哪条路在拦"。
     * 三道门控是**冗余观测**而不是互补条件，所以：
     *
     * | 计数器 | 含义 | 关着开关刷新后应看到 |
     * | --- | --- | --- |
     * | `skipProxyOffCount` | 被 ① `localStorage` 标记拦了 | **≥1**（第一道先跑，必然先命中） |
     * | `skipDisabledCount` | 被 ② `cfgEnabled` 拦了 | 可能为 0（① 先拦了） |
     * | `skipInactiveCount` | 被 ③ `pgcActive` 拦了 | 可能为 0 |
     *
     * **关着开关多刷几次，应当同时看到过 `skip-proxy-off` 和 `skip-disabled`；
     * 只看到一条说明另一条坏了。** 合成一个计数就做不到这个判断。
     */
    skipProxyOffCount: 0,
    /**
     * 「cfg 还没到，先不注入，等它到了再补」的次数。
     *
     * **不是错误，是常态**：`cfg` 要等 `page/activate` 往返，必然晚于 SSR 赋值。
     * 计数是为了回答"这个分支到底被走了多少次" ——
     * 如果它一直是 0，说明时序变了（cfg 早于 SSR 了），那时可以简化门控。
     */
    deferUnknownCount: 0,
    /**
     * 最后一次 skip 时 `cfg.enabled` 的值：`true` / `false` / `null`（`null` = 还没收到 cfg）。
     *
     * ⚠️ 只有 `lastStage` 是 `skip-*` 时它才有意义。用途：看到
     * `lastStage: 'skip-disabled'` 时要能立刻确认"是总开关关了"。
     */
    lastSkipEnabled: null,
    /**
     * **最近一次收到的 `cfg.enabled`**（`true` / `false` / `null`）。
     *
     * 与 `lastSkipEnabled` 的区别：那个只在**跳过时**才写，这个每收到一条 `cfg`
     * 都会更新。加它的理由（2026-10-29）：
     *
     * 排查「关开关后仍然注入 4K」时，我需要知道**主世界到底有没有收到
     * `enabled: false`** —— 而 `lastSkipEnabled` 是 `null` 时有两种可能：
     *   1. 门控没触发（因为 `cfgEnabled` 一直是 `true`）
     *   2. 门控触发了但 `cfgEnabled` 也是 `null`
     *
     * 这两件事的修法完全不同（前者改 ISOLATED 侧的下发，后者改主世界的判断），
     * 而原来的埋点**区分不出来**。有了这个字段就能一眼看出。
     */
    lastCfgEnabled: null,
    /** 收到过几条 `cfg`（与 `__PLUMA_HANDSHAKE__.seen` 独立计数，这个是主循环里的） */
    cfgCount: 0,

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
    /**
     * SPA 切集换流的观测点（2026-10-29 加，排查「切集后画质掉到 1080P」）。
     *
     * - `swapCount`：`pgcSwapPlayviewBody` 被调用了几次
     * - `swapLastCid` / `swapLastQ` / `swapLastMaxH`：最后一次换流的 cid、
     *   请求 qn、换进去的 dash 最高高度
     * - `swapSkip`：最后一次**没换**的原因（空 = 换了）
     *
     * 这三个值一起看就能回答「切集时到底有没有把 4K dash 交出去」——
     * 之前只能靠诊断日志的环形缓冲猜，滚掉了就看不见。
     */
    swapCount: 0,
    swapLastCid: '',
    swapLastQ: -1,
    swapLastMaxH: 0,
    swapSkip: '',
  };

  if (IS_PGC) {
    pgcTrace.bootAt = performance.now ? Math.round(performance.now()) : -1;
    pgcTrace.lastStage = 'boot';
    window.__PLUMA_PGC__ = pgcTrace;

    /**
     * 装 `createPlayer` 观测（只记时刻，不改行为 —— 见函数头注释）。
     *
     * 必须在这里调：越早越好，要抢在页面内联脚本给 `window.nano` 赋值之前。
     */
    installCreatePlayerProbe();
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
  /**
   * @param v 待注入的 `__playinfo__` 对象
   * @param {boolean=} fromSetter 这次调用是否来自 `__playinfo__` 的 setter。
   *   `true` = setter 同步路径（能赶上播放器）；`false` = `cfg` 到达后的补注入（必然晚）。
   *   **只用于埋点**（`pgcTrace.patchedInSetter`），不参与任何分支判断 ——
   *   以免"为了观测而改变行为"。
   */
  function pgcPatchPlayinfo(v, fromSetter) {
    if (pgcPatched || !pgcCachedVideoInfo) return;

    /**
     * ## 总开关门控 —— **只有明确 `true` 才注入**（2026-10-29 修问题 4）
     *
     * ### 原来的写法错在哪
     *
     * ```js
     * if (pgcActive === false) return;   // ← 只拦"明确关闭"
     * ```
     *
     * `pgcActive` 的初值是 `null`（"还不知道"），于是 **`cfg` 到达之前放行**。
     * 而 `cfg` 要跨进程往返，`__playinfo__` 的 setter 却是页面自己同步赋值的
     * （实测 409–599ms）。两者**没有先后保证** —— 赛跑输了就注入缓存里的 4K 流，
     * 于是**关掉总开关后刷新番剧页，画质不回落**（问题 4 的真因）。
     *
     * `sessionStorage` 里的 `pluma:pgc-vi:<cid>` 是完整 4K 流（实测
     * `height: [2160,1080,720,480,360]`、`timelength` 整集），
     * 而同标签页刷新**不清 sessionStorage** —— 所以这份数据一直在手边。
     *
     * ⚠️ **不清 `sessionStorage`**：那份缓存是有效数据，用户重开开关后
     * 立刻就能用上，不用重新取流。这里只做"不注入"，不做"删数据"。
     */
    /**
     * 门控：**用 `cfgEnabled`（总开关），不用 `pgcActive`（页面级激活结果）**。
     *
     * ## 为什么换信号（2026-10-29 真机实测，推翻了当天早些时候的版本）
     *
     * 上一版写成 `if (pgcActive !== true) return;`（把"未知"翻转成拒绝），
     * 意图是修「关开关后刷新番剧页画质不回落」。**真机一测就否掉了**：
     *
     * ```
     * 开关【正常开着】进 ep3854818 →
     *   skipUnknownCount: 1        ← 被"未知"拦了一次
     *   lastSkipEnabled:  true     ← 而当时开关明明是开的
     *   patchedAt:        1879ms   ← 正常应在 ~600ms
     * ```
     *
     * 原因：`pgcActive` **只由 `page/activate` 的回复驱动**（`content.ts:1085`），
     * 而 `page/activate` 要走 content → background 解密凭据 → 装 DNR 规则 → 返回。
     * 而 `hello` 那条 `cfg`（`content.ts:296`）**不带 `pgcActive`**，只带 `enabled`。
     *
     * 所以"`pgcActive` 未知"**不是极端时序，是每次正常加载都会发生的常态**。
     * 拿它当门控 = 用"必然漏一次注入"换"关开关后不回落"，
     * 而漏掉的这一次是**用户正常看番时的第一次注入**（`MEMORY` 里记着：
     * `__playinfo__` 必须在 setter 里同步注入，晚一步播放器就已经按试看起步了）。
     *
     * ## 现在用 `cfgEnabled`
     *
     * `enabled` 由 `content.ts:296` 在收到 `hello` 时**立刻**下发（不等任何往返），
     * 所以它比 SSR 赋值早是常态。语义也对得上：`pgcPatchPlayinfo` 要防的是
     * 「用户关了总开关」，那正是 `enabled === false`。
     *
     * | `cfgEnabled` | 含义 | 动作 | lastStage |
     * | --- | --- | --- | --- |
     * | `false` | 用户关了总开关 | 不注入 | `skip-disabled` |
     * | `true` | 开关开着 | 注入（若 `pgcActive === false` 再拦一道） | `patched` / `skip-inactive` |
     * | `null` | 连 `hello` 都还没到 | 注入 | `patched` |
     *
     * ⚠️ **`null` 放行**（与上一版相反）：`cfg` 一条都没到时，
     * `__playinfo__` 的 setter 也还没装（`syncHooks` 靠 `cfg` 驱动），
     * 所以这里根本不会被调用到。真到了这里说明 hook 已装但配置没来 ——
     * 那种情况**宁可注入**（缓存里的流是对的，注入最多是没生效，不注入是必然没效果）。
     */
    /**
     * ## 三态门控（2026-10-29 第三版，**真机实测两轮才定下来**）
     *
     * | `cfgEnabled` | 含义 | 动作 | lastStage |
     * | --- | --- | --- | --- |
     * | `false` | 用户关了总开关 | **不注入** | `skip-disabled` |
     * | `true` | 开关开着 | 注入 | `patched` |
     * | `null` | cfg 还没到 | **注入**（放行） | `patched-unconfirmed` |
     *
     * ### 为什么 `null` 必须放行（第三版结论，两次真机 + 3 条现有测试否定了"等 cfg"）
     *
     * 真机时序（`ep3854818`，开关关闭）：
     *
     * ```
     * ssAt      : 357ms   ← SSR 赋值，setter 触发
     * patchedAt : 358ms   ← 注入发生（此刻 cfg 还没到）
     * cfgCount  : 4       ← cfg 全部在 358ms 之后才到
     * ```
     *
     * 我一度改成"`null` 也等 cfg"，立刻打破三条既有测试，其中一条是
     * **ADR 0020 的最终修法**：`cfg 完全不到场时，只要有 sessionStorage 就在 setter 里注入`。
     * 那条断言的是"**不允许把注入绑在任何异步通道上**" —— 这是 PGC 支持的根基
     * （`cfg` 可能永远不到，那时不注入就等于功能不存在）。
     *
     * **所以 `null` 必须放行。** "关开关后不回落"不能靠这里拦。
     *
     * ### 为什么最终还是靠 `cfgEnabled` 拦，而不是"清缓存"（第四版结论）
     *
     * 我一度想改成"开关关闭时由 ISOLATED 侧把 `sessionStorage` 里的缓存清掉"。
     * **架构评审否掉了，理由成立**：清缓存的时机（`page/activate` 回包）**必然晚于**
     * 这里的注入（实测 358ms）。那只是把竞争从"读缓存"挪到"删缓存"，
     * 同一个赛跑、换了个赛道 —— **不算修好**。
     *
     * 而且它还有 B 面：`content.ts` 的 `orchestratePgc` 里 `alreadyTried` 为 true
     * 时直接 return、不取流不刷新，所以"清 vi 但留 guard"会让用户
     * **重开开关后永久卡在试看**，直到 guard 的 10 分钟 TTL 过期。
     *
     * 所以现在这一道 `cfgEnabled === false` 保留 —— 它**能覆盖"关闭后刷新"这个主场景**
     * （那时 `page/activate` 通常抢在 SSR 之前，因为 `disableProxy` 之后
     * `isProxyEnabled()` 读 storage 很快）。真正覆盖不了的边角场景由
     * ADR 0028 的 `localStorage` 读时校验解决（见那份 ADR）。
     */
    /**
     * ## ① 第一道门控：`localStorage` 的「开关关着」标记（ADR 0028 第一层，**核心**）
     *
     * ### 为什么它排在最前面
     *
     * 三道门控是**冗余观测**，任一道明确为「关」就拦，没有一道明确为「关」就注入。
     * 既然 ① 和 ② 都会在"关开关"时为「关」，就必须**先判 ①** —— 否则日志里
     * 永远只出现 `skip-disabled`，看不出"两条冗余观测各自还活着吗"。
     * 关着开关多刷几次应当同时看到过 `skip-proxy-off` 与 `skip-disabled`。
     *
     * ### 为什么这道能修好「关开关后画质不回落」
     *
     * 前两版（`pgcActive !== true`、`cfgEnabled !== true`）都试过门控，全被否 ——
     * 根因是**信号必然晚于注入**：真机 `ssAt 357ms / patchedAt 358ms / cfgCount 4`，
     * `cfg` 全部在注入之后才到。任何依赖扩展消息的判据都赢不了这场赛跑。
     *
     * `localStorage` 不同：**同步 API + 跨标签页共享 + 不依赖扩展消息**。
     * 用户在 popup 里关开关的那一刻，标记就写好了；之后任何一次刷新，
     * setter 里读到的都是"已经关着" —— **与时序无关**，因为它不在赛道上。
     *
     * ### 为什么 `null` 放行（不是 `!== true` 就拦）
     *
     * ADR 0020 的硬约束：**不允许把注入绑在任何异步通道上**。`cfg` 可能永远不到
     * （扩展上下文失效 / SW 没唤醒 / content script 崩了），那时不注入就等于
     * "这个功能不存在"。标记读不出来（隐私模式 / 配额满 / 从没写过）同理 ——
     * **判不了就放行**，最坏是多注入一次，而不是功能静默消失。
     *
     * 有 TTL（`PROXY_OFF_TTL_MS`）兜底：写入失败留下的旧标记最多再拦 30 分钟，
     * 之后自动失效、恢复放行。
     */
    if (pgcReadProxyOff() === true) {
      pgcTrace.skipProxyOffCount += 1;
      pgcTrace.lastStage = 'skip-proxy-off';
      pgcPost('skip', '本地标记显示总开关已关闭（proxy-off 新鲜），不注入');
      return;
    }

    /**
     * ## ② 第二道门控：`cfgEnabled`（总开关，`hello` 时同步下发）
     *
     * | `cfgEnabled` | 含义 | 动作 | lastStage |
     * | --- | --- | --- | --- |
     * | `false` | 用户关了总开关 | **不注入** | `skip-disabled` |
     * | `true` | 开关开着 | 注入 | `patched` |
     * | `null` | cfg 还没到 | **注入**（放行） | `patched-unconfirmed` |
     *
     * 与 ① 是**同一件事的两个独立观测**（冗余，不是互补）：① 不依赖扩展消息，
     * ② 不依赖页面存储能力，**任一条能到就够**。
     *
     * 真机时序（`ep3854818`，开关关闭）说明为什么不能只靠这一道：
     *
     * ```
     * ssAt      : 357ms   ← SSR 赋值，setter 触发
     * patchedAt : 358ms   ← 注入发生（此刻 cfg 还没到）
     * cfgCount  : 4       ← cfg 全部在 358ms 之后才到
     * ```
     *
     * 所以这一道**结构性必然漏掉第一次注入** —— 它只是双保险，不是主修复。
     * 主修复是上面那道 `localStorage`。
     */
    if (cfgEnabled === false) {
      pgcTrace.skipDisabledCount += 1;
      pgcTrace.lastStage = 'skip-disabled';
      pgcTrace.lastSkipEnabled = cfgEnabled;
      pgcPost('skip', '总开关已关闭（cfgEnabled=false），不注入');
      return;
    }
    // `cfgEnabled === null`：放行，但标记出来（便于排查"为什么关着却注入了"）
    if (cfgEnabled === null) pgcTrace.lastStage = 'patched-unconfirmed';

    /**
     * ## ③ 第三道门控：页面级激活失败（未配置 / 同账号 / 出错）。
     * `null`（`page/activate` 还没回来）**不拦**。
     *
     * 与 ② 是**互补的**：② 管"用户不想用"，③ 管"想用但用不了"。
     */
    if (pgcActive === false) {
      pgcTrace.skipInactiveCount += 1;
      pgcTrace.lastStage = 'skip-inactive';
      pgcTrace.lastSkipEnabled = cfgEnabled;
      pgcPost('skip', 'page/activate 回报未激活（pgcActive=false），不注入');
      return;
    }

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

    /**
     * 记录**注入前后**的 `dash.duration`（2026-10-29 加，只观测）。
     *
     * 排查「注入了但 duration 仍是 180」时，这两个值能把问题切成两半：
     *
     * | from | to | 结论 |
     * | --- | --- | --- |
     * | 180 | 1166 | 注入数据是对的 → 问题在「播放器没采用」 |
     * | 180 | 180 | 注入本身没换掉 dash → 问题在注入逻辑 |
     *
     * ⚠️ 必须在 `r.video_info = next` **之前**取 `from`，否则拿到的是新值。
     */
    var prevDash = base && base.dash && typeof base.dash === 'object' ? base.dash : null;
    pgcTrace.injectedFrom =
      prevDash && typeof prevDash.duration === 'number' ? prevDash.duration : -1;

    r.video_info = next;
    // 试看标记（ADR 0021）—— 只换流不够，播放器会在 361 秒处主动停
    var flags = pgcPatchPreviewFlags(r);
    pgcPatched = true;
    pgcTrace.patchedAt = performance.now ? Math.round(performance.now()) : -1;
    pgcTrace.lastStage = 'patched';

    var nextDash = next.dash && typeof next.dash === 'object' ? next.dash : null;
    pgcTrace.injectedTo = nextDash && typeof nextDash.duration === 'number' ? nextDash.duration : -1;

    /**
     * `patchedInSetter`：这次注入发生在 setter 同步路径，还是 `cfg` 补注入。
     *
     * 由调用方通过 `pgcPatchPlayinfo(v, fromSetter)` 传进来 —— 不能靠 `lastStage` 判断，
     * 因为 `cfg` 分支会在注入**之后**把它覆写成 `'cfg-with-cache'`。
     */
    if (typeof fromSetter === 'boolean') pgcTrace.patchedInSetter = fromSetter;

    /**
     * **把注入结果告诉 ISOLATED 侧**（2026-10-29 修：首次进入番剧页 popup 显示「等待取流…」）。
     *
     * ## 为什么必须有这条
     *
     * `pageState.playback`（popup §2.3 徽章的数据源）只有两种写法：
     *   1. `prepareFullStream` 里取流成功后
     *   2. 切集时收到 `pgc-playview-stream`
     *
     * **首次进入走的是第三条路**：`sessionStorage` 里已经有缓存 → 这里同步注入
     * → **ISOLATED 侧从头到尾不知道发生过这件事**。于是 `playback` 恒为 null，
     * popup 显示「等待取流…」—— 而画面其实已经 3840×2160。
     *
     * 真机现场（ep3854816）：`video 3840×2160`、`dur 1173`，
     * 而 popup 是 `{title:'等待取流…', badges:[]}`。切到下一集立刻正常
     * （那条走 `pgc-playview-stream`），所以用户看到的是"切一下就好了"。
     *
     * ## 为什么复用 `pgc-playview-stream` 而不是新加消息类型
     *
     * ISOLATED 侧对它的处理正好是我们要的（先 `setPageKey` 再 `applyPlayback`），
     * 语义也一致 —— 都是"播放账号侧拿到了这份流"。
     * 新加类型要多改 `messages.ts` + `check-messages`，收益为零。
     *
     * ⚠️ 只发**注入后的 `video_info`**，不是整份 `__playinfo__` ——
     * `applyPlayback` 只需要流字段，几十 KB 的 `arc`/`plugin` 没有用。
     */
    if (IS_PGC && pgcPatchedCid) {
      safePost({
        __ns: NS,
        type: 'pgc-playview-stream',
        token: token,
        cid: String(pgcPatchedCid),
        result: next,
      });
    }

    var timelength = next.timelength || 0;
    pgcPost(
      'patch',
      '已注入缓存流：字段=' +
        moved +
        ' 试看标记=' +
        flags +
        ' 时长=' +
        timelength +
        ' dashDur ' +
        pgcTrace.injectedFrom +
        '→' +
        pgcTrace.injectedTo +
        (fromSetter === true ? ' (setter)' : fromSetter === false ? ' (cfg补)' : ''),
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
   *
   * ## ⚠️ `api.biliapi.net` 必须在（2026-10-29 真机）
   *
   * **播放器对同一次画质切换会同时向两个域名发 playurl 请求**，
   * 并采用备选域名那条的结果。只写主域名 → 备选那条：
   *   - DNR 不换 Cookie（`routes.ts` 的 `BILI_API_HOSTS` 控制）→ 主账号身份，拿不到 4K
   *   - 这里的响应体改写也不生效 → 会员字段没伪装 → 播放器判「无权限」
   *
   * 两个都要改，缺一个就是上面那种「点击 4K，菜单变了但画面没变」。
   * 必须与 `src/shared/constants/routes.ts` 的 `BILI_API_HOSTS` 保持一致
   * （主世界是裸 JS，没法 import 那个常量）。
   */
  var PATCH_HOSTS = ['api.bilibili.com', 'api.biliapi.net'];

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

  // ── 3b. PGC 试看标记的改写（ADR 0021）与提示条隐藏（ADR 0022）──
  // ⚠️ 本段原来挂着「4. HDR 检测」的标题，但下面处理的是 PGC 试看标记 ——
  // 标题与内容不符（真正的 HDR 检测在后面那段，见 `hdrReport`）。2026-10-30 更正。

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
  /**
   * `video_info` 里 dash 轨道的**最高 quality id**。
   *
   * ## 为什么用 id 而不是 height
   *
   * `height` 在同一档上会重复（`125`/`120` 都是 2160、`112`/`80` 都是 1080），
   * 判"还能不能更高"时用 height 会把 HDR 和 4K 看成一样。
   * id 是 B 站的档位序号，**越大越高**，单调可比。
   *
   * @returns 最高 id；没有 dash 或没有视频轨时返回 `0`
   */
  function pgcMaxQualityId(vi) {
    if (!vi || typeof vi !== 'object') return 0;
    var dash = vi.dash;
    if (!dash || typeof dash !== 'object') return 0;
    var tracks = dash.video;
    if (!Array.isArray(tracks)) return 0;
    var max = 0;
    for (var i = 0; i < tracks.length; i += 1) {
      var id = tracks[i] && typeof tracks[i].id === 'number' ? tracks[i].id : 0;
      if (id > max) max = id;
    }
    return max;
  }

  /**
   * 最高视频高度（画质比较用，与 `pgcMaxQualityId` 互补）。
   *
   * @returns 最高 height；没有轨时 `0`
   */
  function pgcMaxHeight(vi) {
    if (!vi || typeof vi !== 'object') return 0;
    var dash = vi.dash;
    if (!dash || typeof dash !== 'object') return 0;
    var tracks = dash.video;
    if (!Array.isArray(tracks)) return 0;
    var max = 0;
    for (var i = 0; i < tracks.length; i += 1) {
      var h = tracks[i] && typeof tracks[i].height === 'number' ? tracks[i].height : 0;
      if (h > max) max = h;
    }
    return max;
  }

  /**
   * `/ogv/player/playview` 的流是否短于 `timelength`（G7，2026-10-30）。
   *
   * ## 为什么不能只看"每组首段"
   *
   * 旧实现把 `durls` **每个画质组的首段**相加：
   *   试看 = 4 组 × 1 段 × 360109ms → total ≈ 1440s ≈ timelength
   *   → 误判"完整" → 随后 `pgcMaxQualityId` 在无 dash 的响应上返回 0
   *   → `pgcSwapPlayviewBody` 直接 return null，跳过换流。
   *
   * 真机 2026-10-30（ep341217/218）响应当前同时带 `durl` 与 `durls`，
   * 先命中 `durl` 分支，所以没有复现；但只要出现"只有 durls"的形状就会踩到。
   * 这里改成与 ISOLATED 的 `streamDurationMs` 一致：**同一组内全段相加**。
   */
  function pgcPlayviewIsTruncated(vi) {
    if (!vi || typeof vi !== 'object') return false;
    var timelength = typeof vi.timelength === 'number' ? vi.timelength : 0;
    if (!(timelength > 0)) return false;

    // ① durl：所有段相加（多段完整流不能只看第一段）
    if (Array.isArray(vi.durl) && vi.durl.length > 0) {
      var totalDurl = 0;
      for (var di = 0; di < vi.durl.length; di += 1) {
        var seg = vi.durl[di];
        if (seg && typeof seg === 'object' && typeof seg.length === 'number' && seg.length > 0) {
          totalDurl += seg.length;
        }
      }
      if (totalDurl > 0) return totalDurl < timelength - PGC_TRUNCATION_SLACK_MS;
      // 段长全无效 → 继续看 durls（与 ISOLATED 的 streamDurationMs 一致）
    }

    // ② durls：**同一组内**全段相加（不是每组首段相加）
    if (Array.isArray(vi.durls) && vi.durls.length > 0) {
      var firstGroup = vi.durls[0];
      var segs = firstGroup && firstGroup.durl;
      var total = 0;
      if (Array.isArray(segs)) {
        for (var si = 0; si < segs.length; si += 1) {
          var s = segs[si];
          if (s && typeof s === 'object' && typeof s.length === 'number' && s.length > 0) {
            total += s.length;
          }
        }
      }
      if (total > 0) return total < timelength - PGC_TRUNCATION_SLACK_MS;
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

    pgcTrace.swapCount += 1;

    /**
     * ## ⚠️ 「本来就完整 → 不碰」这条判据**只判了时长，没判画质**（2026-10-29 修）
     *
     * 原实现：`if (!pgcPlayviewIsTruncated(vi)) return null;`
     *
     * 意思是"这条流够长，不用换"。真机实测（国创 ep733318/733321，限免集）证明它漏了另一半：
     *
     * ```
     * playview 原始响应: dash 只有 80@1080 64@720 32@480 16@360  → 画面 1080
     * 但播放账号能取到:   [125@2160, 120@2160, 112@1080, …]      → 本来能 4K
     * 限免集是完整流 → isTruncated = false → 直接 return → **4K 永远拿不到**
     * ```
     *
     * 用户在 SPA 切集后点 4K：播放器手里没有 2160 轨 → 「切换失败」+ 画面停在 1080。
     *
     * 修法与整页加载一致（`entrypoints/content.ts` 的 `tryUpgradeForQuality`）：
     * **「需要换」= 流被截断 或 画质还能提升**。两条独立判据，互不替代 ——
     * 只看画质会让会员老番掉回试看，只看时长则让限免集拿不到 4K。
     *
     * 这里先只放宽"进入函数"的条件，画质比较在取流之后做（省一次网络往返：
     * 本来就要取，取回来再比）。
     */
    var truncated = pgcPlayviewIsTruncated(vi);
    if (!truncated) {
      /**
       * 不截断 → 只在「可能画质更高」时才继续。
       *
       * 判据：当前 dash 最高高度 **低于** `accept_quality` 里的最高档对应高度。
       * 但 `accept_quality` 只有 id 没有高度，所以这里用**经验映射**判断"还有更高档"：
       * 只要 `accept_quality` 里出现比当前 dash 最高 id 更大的 id，就值得取一次。
       *
       * ⚠️ 这个判据**只用于"要不要试一次"**，不用于"能不能拿到"——
       * 后者由取回来的 dash 事实决定（下面 `isBetterSwap` 严格比较）。
       * 所以即使判错了，最坏也只是多一次请求，不会漏取。
       */
      var curMaxId = pgcMaxQualityId(vi);
      var acceptMaxId = 0;
      var aq = Array.isArray(vi.accept_quality) ? vi.accept_quality : [];
      for (var ai = 0; ai < aq.length; ai += 1) {
        var qq = Number(aq[ai]);
        if (Number.isFinite(qq) && qq > acceptMaxId) acceptMaxId = qq;
      }
      if (curMaxId <= 0 || acceptMaxId <= curMaxId) {
        pgcTrace.swapSkip = 'not-truncated-and-no-higher-qid(cur=' + curMaxId + ',accept=' + acceptMaxId + ')';
        return Promise.resolve(null);
      }
      pgcTrace.swapSkip = '';
      pgcPost(
        'playview',
        '流完整但画质可能更高（cur=' + curMaxId + ' accept=' + acceptMaxId + '），尝试补取',
      );
    }

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
           * ## 画质必须**严格更高**才换（2026-10-29 加）
           *
           * 放宽"进入函数"的条件之后，会有一批集数取回来发现画质一样 ——
           * 那种情况换上去只是白改一遍响应，播放器还要重建一次管道（用户看到闪一下）。
           *
           * ⚠️ **只在"流原本是完整的"这条新路径上比**（`truncated === false`）。
           * 截断的集数必须无条件换 —— 那是"能不能看完整集"的问题，
           * 与画质无关。这条区分是防止把会员老番的完整流挡掉。
           */
          if (!truncated) {
            var curH = pgcMaxHeight(vi);
            var newH = pgcMaxHeight(full);
            if (!(newH > curH)) {
              pgcTrace.swapSkip = 'not-better(cur=' + curH + ',new=' + newH + ')';
              pgcPost(
                'playview',
                'cid=' + cid + ' 取到的画质不更高(' + curH + '→' + newH + ')，不换',
              );
              return null;
            }
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

          /**
           * 埋点：换流成功时把「换进去什么」记在 `window.__PLUMA_PGC__` 上。
           *
           * 为什么需要它：诊断日志是 30 条环形缓冲，切集换流那几条经常被后面的
           * 角标日志挤掉，排查时只能看个大概。这几个值能直接在页面里读，
           * 回答「切集后到底有没有把 4K dash 交出去」。
           */
          pgcTrace.swapLastCid = cid;
          pgcTrace.swapLastQ = typeof full.quality === 'number' ? full.quality : -1;
          pgcTrace.swapLastMaxH = pgcMaxHeight(full);
          pgcTrace.swapSkip = '';

          pgcPost(
            'playview',
            '已换流 dash cid=' + cid + ' q=' + full.quality + ' 高度=[' + heights.join(',') + ']' +
              (truncated ? '（截断→完整）' : '（画质升级）'),
          );

          /**
           * ## 把这次切集拿到的流告诉 ISOLATED（2026-10-29 加，ADR 0024 的配套）
           *
           * ## 为什么必须有这一条
           *
           * 主世界与 ISOLATED 是两个 world，`pageState` 只在 ISOLATED 里。
           * SPA 切集时：
           *   - `__playinfo__` **完全不重新赋值**（ADR 0023 实测），所以 `ssr-playinfo` 不会再来
           *   - `playurl-raw` 更不会来（PGC 的请求不走 `/x/player/…`）
           *
           * 于是不补这一条的话，`pageState` 会**永远停在首次加载那一集** ——
           * popup 的徽章在切集后不更新，显示的是上一集的画质，而且不报错。
           *
           * 带上 `cid` 是因为 ISOLATED 侧要据此把 `pageKey` 换到新集
           * （`ep:` 前缀靠 ep_id，但响应里只有 cid —— 映射在 ISOLATED 侧用
           * `pluma:pgc-ep:` 那份 sessionStorage 做，那里已经存了）。
           *
           * 只发 `full`（即 `j.result`），不带整份 `body`：`body.data` 里还有
           * `arc` / `plugins` / 弹幕配置等，几十倍大且用不上。
           */
          safePost({
            __ns: NS,
            type: 'pgc-playview-stream',
            token: token,
            cid: cid,
            result: full,
          });

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
      /**
       * ## 这份 `data` 里的流**是不是我们自己注入进去的**（2026-10-29 加）
       *
       * ## 为什么必须告诉 ISOLATED 侧
       *
       * `ssrPlayinfo` 是 setter 里 `ssrPlayinfo = v` 记下的**引用**，
       * 而同一个 setter 紧接着 `pgcPatchPlayinfo(v)` 会
       * `r.video_info = next` **原地替换**。引用没变，所以上报出去的
       * `data` 里已经是注入后的完整流。
       *
       * 后果：ISOLATED 侧拿它判 `isStreamTruncated()` 会得到 `false`
       * （完整流当然"够长"），于是走「无需注入」的早退分支，
       * **永远进不到 cache 分支，也就永远不会 reload** ——
       * 这正是「重开开关后卡在试看」的真因。
       *
       * **注入越成功，那条路越进不去。** 所以这个布尔量是必需的：
       * 让上层能区分「SSR 本来就是完整流」和「SSR 被我们改成了完整流」。
       */
      pgcPatched: pgcPatched,
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

    /**
     * 埋点：这条 `cfg` 收到了。对象本身在脚本开头就建好挂上 `window` 了，
     * 这里只**原地累加**，不重新赋值（否则诊断侧持有的引用会停在旧对象上）。
     */
    handshakeTrace.seen += 1;

    if (!tokenLocked) {
      if (d.token && typeof d.token === 'string') {
        token = d.token;
        tokenLocked = true;
      }
    }

    /**
     * 埋点：这条 `cfg` 与锁定的 token 对不对得上。
     *
     * ⚠️ **位置在拒绝分支之前**：B-04 关心的恰恰是被 `return` 掉的那些条，
     * 写在 `return` 之后等于永远看不到"新 token 被拒"这个状态。
     *
     * 三种情况分开记，别合并成一个 boolean：
     *   - 还没锁定（首条 cfg 没带 token）→ `matches = null`（"未知"，不是"不匹配"）
     *   - 锁定了且相等 → `true`
     *   - 锁定了但不等 / 没带 token → `false`
     */
    if (tokenLocked) {
      handshakeTrace.matches = !!d.token && d.token === token;
      if (!handshakeTrace.matches) handshakeTrace.rejected += 1;
    }
    handshakeTrace.locked = tokenLocked;

    if (tokenLocked && (!d.token || d.token !== token)) {
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
     * 记下 `enabled` 的明确值，供 `pgcTrace.lastSkipEnabled` 使用。
     *
     * 与下面 `if (!!d.enabled !== enabled)` 那段**分开写**：那个是行为开关，
     * 这个是诊断值。`d.enabled` 缺失时（伪造的 cfg / 老版本 ISOLATED）
     * 不覆盖已记下的值 —— 否则一次缺字段的 cfg 会把"开关开着"抹成 `null`。
     */
    if (typeof d.enabled === 'boolean') cfgEnabled = d.enabled;
    // 埋点：每收到一条 cfg 都记，用来区分"没收到 false"与"收到了但没触发"
    pgcTrace.cfgCount += 1;
    pgcTrace.lastCfgEnabled = cfgEnabled;

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
      /**
       * ## 第三道防线也管这条路（2026-10-29 加，问题 5）
       *
       * `cfg.pgcVideoInfo` **绕过 `sessionStorage`** 直接把 `video_info` 送进来，
       * 所以上面 `pgcReadCacheSync()` 的校验管不到它。
       *
       * 正常情况下 ISOLATED 侧在写入前已经校验过了（`prepareFullStream`），
       * 走到这里应该是干净的。但两个理由让这道值得留：
       *   1. `cfg` 可能来自**另一个标签页**写进 `storage.local` 的旧坏数据
       *   2. 防御性：任何一条新加的写入路径漏了校验，这里都能兜住
       *
       * 拒绝时**不赋值** `pgcCachedVideoInfo` —— 保持 `null`，
       * 于是后面的 `pgcPatchPlayinfo()` 会因为"没有缓存"直接返回，
       * 播放器照常播 SSR 的试看流。
       */
      if (pgcVideoInfoTruncated(d.pgcVideoInfo)) {
        pgcTrace.cacheRejectedTruncated = true;
        pgcPost('cache-truncated', 'cfg 送来的缓存短于 timelength，拒绝注入');
        return;
      }
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
      if (playinfoValue && !pgcPatched) pgcPatchPlayinfo(playinfoValue, false);
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
