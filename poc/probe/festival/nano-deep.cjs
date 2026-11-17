// 只读探针：活动页 createPlayer(config) 深层形状 + 播放器读键 + playurl 请求来自谁。
// 产出：poc/probe/festival/result-nano-deep.json
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET =
  process.env.POC_TARGET ||
  'https://www.bilibili.com/festival/COLMO2026?bvid=BV1ydeX65Edn';
const OUT = path.join(__dirname, 'result-nano-deep.json');
const HEADLESS = process.env.POC_HEADLESS !== '0';

const INIT = () => {
  const P = { events: [], reads: [], config: null, fetch: [], xhr: [], cbHits: 0 };
  window.__DEEP__ = P;
  const log = (m) => P.events.push({ t: Math.round(performance.now()), m });

  // 深拷贝的「形状」：不保留任何 URL 字符串 / 大数组内容，只保留 key、类型、标量短值。
  const shape = (v, depth, seen) => {
    if (depth > 4) return '...';
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'function') return 'fn:' + (v.name || '(anon)') + '(' + (v.length ?? '?') + ')';
    if (t !== 'object') {
      const s = String(v);
      return t + ':' + (s.length > 90 ? s.slice(0, 60) + '…(' + s.length + ')' : s);
    }
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (typeof Node !== 'undefined' && v instanceof Node) {
      return 'DOM<' + String(v.tagName || v.nodeName) + '>';
    }
    if (Array.isArray(v)) {
      return { __array: v.length, first: v.length ? shape(v[0], depth + 1, seen) : null };
    }
    const out = {};
    for (const k of Object.keys(v)) {
      try {
        out[k] = shape(v[k], depth + 1, seen);
      } catch (e) {
        out[k] = '!get:' + e.message;
      }
    }
    // 原型上的方法名也有用（nano 的 createPlayer 在原型上）
    let proto = Object.getPrototypeOf(v);
    const protoKeys = [];
    while (proto && proto !== Object.prototype && protoKeys.length < 30) {
      protoKeys.push(...Object.getOwnPropertyNames(proto).filter((x) => x !== 'constructor'));
      proto = Object.getPrototypeOf(proto);
    }
    if (protoKeys.length) out.__protoKeys = [...new Set(protoKeys)].slice(0, 30);
    return out;
  };

  // 网络层：记录谁取流（fetch / XHR），不记录签名 URL
  const OF = window.fetch;
  window.fetch = function (input, init) {
    const raw = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    const isPlayurl = /playurl/i.test(raw);
    if (isPlayurl) {
      const u = new URL(raw, location.href);
      P.fetch.push({
        t: Math.round(performance.now()),
        host: u.host,
        path: u.pathname,
        qn: u.searchParams.get('qn'),
        fnval: u.searchParams.get('fnval'),
        fourk: u.searchParams.get('fourk'),
        stack: (new Error().stack || '').split('\n').slice(1, 7).join(' | ').slice(0, 900),
      });
      log('fetch playurl ' + u.pathname + ' qn=' + u.searchParams.get('qn'));
    }
    return OF.apply(this, arguments);
  };
  const OO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    if (/playurl/i.test(String(u))) {
      const x = new URL(String(u), location.href);
      P.xhr.push({
        t: Math.round(performance.now()),
        method: m,
        host: x.host,
        path: x.pathname,
        qn: x.searchParams.get('qn'),
        fnval: x.searchParams.get('fnval'),
        stack: (new Error().stack || '').split('\n').slice(1, 7).join(' | ').slice(0, 900),
      });
      log('XHR playurl ' + x.pathname + ' qn=' + x.searchParams.get('qn'));
    }
    return OO.apply(this, arguments);
  };

  let nanoRef;
  Object.defineProperty(window, 'nano', {
    configurable: true,
    enumerable: true,
    get() {
      return nanoRef;
    },
    set(v) {
      nanoRef = v;
      if (!v || typeof v.createPlayer !== 'function' || v.createPlayer.__deepWrapped) return;
      const orig = v.createPlayer;
      v.createPlayer = function (config) {
        log('createPlayer called');
        try {
          P.config = shape(config, 0, new WeakSet());
        } catch (e) {
          log('shape 失败: ' + e.message);
        }
        // 不套 Proxy：config.element / auxiliary 是 DOM 节点，代理会把播放器搞崩（实测栈溢出）。
        // 只读键集合从顶层访问记录（由下列一次性 getter 收集）拿不到，交给 nano-shape.cjs 的 READS=1 模式。
        return orig.call(this, config);
      };
      v.createPlayer.__deepWrapped = true;
      log('createPlayer 已包装');
    },
  });
};

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
  });
  const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  await page.addInitScript(INIT);
  const out = { target: TARGET, at: new Date().toISOString() };
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(14000);
    out.deep = await page.evaluate(() => {
      const d = window.__DEEP__ || {};
      return {
        events: d.events || [],
        config: d.config,
        reads: [...new Set(d.reads || [])].slice(0, 200),
        fetch: d.fetch || [],
        xhr: d.xhr || [],
      };
    });
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { t: Math.round(v?.currentTime ?? 0), dur: Math.round(v?.duration ?? 0), h: v?.videoHeight ?? 0, ready: v?.readyState ?? null };
    });
    out.errors = errors;
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close().catch(() => {});
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2).slice(0, 30000));
})();
