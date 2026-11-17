// 只读探针：活动页 window.nano setter 能否包住 createPlayer？config 形状 / 读键 / 回退回调。
// 用法：
//   node poc/probe/festival/nano-shape.cjs                       # COLMO2026（有 4K）
//   POC_TARGET=https://www.bilibili.com/festival/bnj2026?bvid=BV1eoZ7BnEGy node ...
//   READS=1 node ...                                             # 额外用 Proxy 记录播放器读了 config 哪些键
// 产出：poc/probe/festival/result-nano-shape.json（签名 URL 已脱敏）
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET =
  process.env.POC_TARGET ||
  'https://www.bilibili.com/festival/COLMO2026?bvid=BV1ydeX65Edn';
const OUT = path.join(__dirname, 'result-nano-shape.json');
const READS = process.env.READS === '1';
const HEADLESS = process.env.POC_HEADLESS !== '0';

/**
 * 在页面任何脚本之前运行：模拟 MV3 content script world:'MAIN', runAt:'document_start'。
 * @param {boolean} trackReads 是否用 Proxy 记录 get
 */
const INIT = (trackReads) => {
  const P = {
    events: [],
    nanoSets: 0,
    createCalls: 0,
    cbHits: 0,
    reads: [],
    cbArgs: [],
  };
  window.__NANO_PROBE__ = P;
  const log = (m) => P.events.push({ t: Math.round(performance.now()), m });
  const brief = (v) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array(' + v.length + ')';
    if (typeof v === 'object') {
      try {
        return 'obj{' + Object.keys(v).slice(0, 40).join(',') + '}';
      } catch (e) {
        return 'obj?';
      }
    }
    return typeof v + ':' + String(v).slice(0, 80);
  };

  let nanoRef;
  try {
    Object.defineProperty(window, 'nano', {
      configurable: true,
      enumerable: true,
      get() {
        return nanoRef;
      },
      set(v) {
        P.nanoSets += 1;
        nanoRef = v;
        log('nano set #' + P.nanoSets + ' = ' + brief(v));
        if (!v || typeof v.createPlayer !== 'function') return;
        if (v.createPlayer.__nanoProbeWrapped) return;
        const orig = v.createPlayer;
        const wrapped = function (config) {
          P.createCalls += 1;
          const n = P.createCalls;
          log('createPlayer #' + n + ' called (this=' + (this === v ? 'nano' : 'other') + ')');
          try {
            log('config=' + brief(config));
            const pf = config && config.prefetch;
            log('prefetch=' + brief(pf));
            log('prefetch.playUrl=' + brief(pf && pf.playUrl));
            const rc = config && config.requestConfig;
            log('requestConfig=' + brief(rc));
            log('reqHttpPlayUrlInfo=' + brief(rc && rc.reqHttpPlayUrlInfo));
            if (rc && typeof rc.reqHttpPlayUrlInfo === 'function') {
              const ocb = rc.reqHttpPlayUrlInfo;
              rc.reqHttpPlayUrlInfo = function (...args) {
                P.cbHits += 1;
                log('★ reqHttpPlayUrlInfo 被调用 #' + P.cbHits + ' args=' + args.length);
                P.cbArgs.push(args.map((a) => brief(a)));
                return ocb.apply(this, args);
              };
              log('reqHttpPlayUrlInfo 已包装');
            } else {
              log('!! 没有 requestConfig.reqHttpPlayUrlInfo');
            }
            const st = window.__INITIAL_STATE__ || {};
            log(
              'INITIAL_STATE.videoInfo.cid=' +
                (st.videoInfo && st.videoInfo.cid) +
                ' bvid=' +
                (st.videoInfo && st.videoInfo.bvid),
            );
          } catch (e) {
            log('hook 内部异常: ' + e.message);
          }

          let passed = config;
          if (trackReads && config && typeof config === 'object') {
            // 顶层读键记录。get trap 完全透传，不改语义；只在对象本身被读取时记录。
            passed = new Proxy(config, {
              get(target, key, receiver) {
                if (typeof key === 'string') P.reads.push('config.' + key);
                return Reflect.get(target, key, receiver);
              },
            });
          }
          return orig.call(this, passed);
        };
        wrapped.__nanoProbeWrapped = true;
        v.createPlayer = wrapped;
        log('createPlayer 已包装 (trackReads=' + trackReads + ')');
      },
    });
  } catch (e) {
    log('defineProperty(window.nano) 失败: ' + e.message);
  }
};

/** 只留非敏感字段；签名 / session / 指纹参数一律丢弃 */
const safeUrl = (u) => {
  try {
    const x = new URL(u);
    const keep = ['qn', 'fnval', 'fnver', 'fourk', 'is_main_page', 'type'];
    const q = keep.filter((k) => x.searchParams.has(k)).map((k) => k + '=' + x.searchParams.get(k));
    return x.host + x.pathname + '?' + q.join('&');
  } catch (e) {
    return '(unparsable)';
  }
};

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: HEADLESS,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--lang=zh-CN',
    ],
  });
  const ctx = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  const net = { playurl: [], m4s: 0 };
  const errors = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\/x\/(player\/)?(wbi\/)?playurl/.test(u)) net.playurl.push(safeUrl(u));
    else if (/\.m4s(\?|$)/.test(u)) net.m4s += 1;
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));

  await page.addInitScript(INIT, READS);

  const out = { target: TARGET, readsTracking: READS, at: new Date().toISOString() };
  const watchdog = setTimeout(async () => {
    try {
      writeFileSync(OUT, JSON.stringify({ ...out, error: 'watchdog 100s' }, null, 2), 'utf8');
    } catch (e) {}
    process.exit(2);
  }, 100_000);
  watchdog.unref?.();
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(16000);
    await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return;
        v.muted = true;
        void v.play().catch(() => {});
      })
      .catch(() => {});
    await page.waitForTimeout(6000);

    out.probe = await page.evaluate(() => {
      const p = window.__NANO_PROBE__ || {};
      return {
        events: p.events || [],
        nanoSets: p.nanoSets || 0,
        createCalls: p.createCalls || 0,
        cbHits: p.cbHits || 0,
        cbArgs: p.cbArgs || [],
        reads: p.reads ? [...new Set(p.reads)].slice(0, 100) : [],
      };
    });
    out.nano = await page.evaluate(() => {
      const n = window.nano;
      return {
        type: typeof n,
        createPlayerType: typeof (n && n.createPlayer),
        createPlayerWrapped: !!(n && n.createPlayer && n.createPlayer.__nanoProbeWrapped),
        descriptor: !!Object.getOwnPropertyDescriptor(window, 'nano'),
      };
    });
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      const st = window.__INITIAL_STATE__ || {};
      return {
        cid: st.videoInfo && st.videoInfo.cid,
        bvid: st.videoInfo && st.videoInfo.bvid,
        hasPlayerGlobal: !!(window.player || window.biliPlayer),
        t: Math.round(v?.currentTime ?? 0),
        dur: Math.round(v?.duration ?? 0),
        h: v?.videoHeight ?? 0,
        readyState: v?.readyState ?? null,
        paused: v?.paused ?? null,
        err: v?.error?.code ?? null,
      };
    });
    out.net = net;
    out.errors = errors.slice(0, 20);
  } catch (e) {
    out.error = e.message;
  } finally {
    clearTimeout(watchdog);
    await browser.close().catch(() => {});
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({ probe: out.probe, nano: out.nano, state: out.state, net: out.net, errors: out.errors, error: out.error }, null, 2));
})();
