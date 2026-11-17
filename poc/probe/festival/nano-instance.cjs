// 只读探针：createPlayer 返回值 / nano 原型 API / 活动页 SPA 换 bvid 是否复用同一实例。
// 产出：poc/probe/festival/result-nano-instance.json
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET =
  process.env.POC_TARGET ||
  'https://www.bilibili.com/festival/COLMO2026?bvid=BV1ydeX65Edn';
const OUT = path.join(__dirname, 'result-nano-instance.json');
const HEADLESS = process.env.POC_HEADLESS !== '0';

const INIT = () => {
  const P = { events: [], nanoProto: [], nanoOwn: [], returns: [] };
  window.__INST__ = P;
  const log = (m) => P.events.push({ t: Math.round(performance.now()), m });
  const names = (o) => {
    const out = [];
    let p = o;
    while (p && out.length < 120) {
      out.push(...Object.getOwnPropertyNames(p).filter((x) => x !== 'constructor'));
      p = Object.getPrototypeOf(p);
    }
    return [...new Set(out)].slice(0, 120);
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
      if (!v || typeof v.createPlayer !== 'function' || v.createPlayer.__instWrapped) return;
      P.nanoOwn = Object.keys(v);
      P.nanoProto = names(Object.getPrototypeOf(v));
      log('nano own=' + P.nanoOwn.join(',') + ' proto=' + P.nanoProto.join(','));
      const orig = v.createPlayer;
      v.createPlayer = function (config) {
        const n = P.returns.length + 1;
        log('createPlayer #' + n + ' cid=' + (config && config.cid));
        let ret = null;
        let err = null;
        try {
          ret = orig.call(this, config);
        } catch (e) {
          err = e.message;
        }
        P.returns.push({
          n,
          cid: config && config.cid,
          bvid: config && config.bvid,
          type: typeof ret,
          keys: ret && typeof ret === 'object' ? Object.keys(ret).slice(0, 60) : [],
          protoNames: ret && typeof ret === 'object' ? names(ret) : [],
          err,
        });
        window.__LAST_PLAYER__ = ret;
        return ret;
      };
      v.createPlayer.__instWrapped = true;
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
    await page.waitForTimeout(12000);
    out.before = await page.evaluate(() => {
      const p = window.__INST__ || {};
      const v = document.querySelector('video');
      return {
        events: p.events,
        nanoOwn: p.nanoOwn,
        nanoProto: p.nanoProto,
        returns: (p.returns || []).map((r) => ({ ...r, protoNames: r.protoNames.slice(0, 40) })),
        cid: window.__INITIAL_STATE__?.videoInfo?.cid,
        bvid: window.__INITIAL_STATE__?.videoInfo?.bvid,
        dur: Math.round(v?.duration ?? 0),
        h: v?.videoHeight ?? 0,
      };
    });
    // 找活动页自己的 SPA 链接（同路径、不同 bvid）
    out.links = await page.evaluate(() => {
      const here = new URL(location.href);
      return [...document.querySelectorAll('a[href]')]
        .map((a) => ({ text: (a.textContent || '').trim().slice(0, 40), href: a.getAttribute('href') }))
        .filter((x) => /festival/i.test(x.href || '') && /bvid=/i.test(x.href || ''))
        .filter((x) => {
          try {
            return new URL(x.href, location.href).searchParams.get('bvid') !== here.searchParams.get('bvid');
          } catch (e) {
            return false;
          }
        })
        .slice(0, 8);
    });

    if (out.links.length) {
      const href = out.links[0].href;
      out.clicked = href;
      await page.evaluate((h) => {
        const a = [...document.querySelectorAll('a[href]')].find((x) => x.getAttribute('href') === h);
        if (a) a.click();
      }, href).catch((e) => {
        out.clickError = e.message;
      });
      await page.waitForTimeout(12000);
    } else {
      // 没有可用链接时做合成 SPA 切换，明确标记为「非站点原生」
      out.clicked = '(synthetic) history.pushState + popstate';
      await page.evaluate(() => {
        history.pushState({}, '', '/festival/bnj2026?bvid=BV1eoZ7BnEGy');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }).catch((e) => {
        out.clickError = e.message;
      });
      await page.waitForTimeout(12000);
    }

    out.after = await page.evaluate(() => {
      const p = window.__INST__ || {};
      const v = document.querySelector('video');
      return {
        events: p.events,
        returns: (p.returns || []).map((r) => ({ ...r, protoNames: r.protoNames.slice(0, 40) })),
        cid: window.__INITIAL_STATE__?.videoInfo?.cid,
        bvid: window.__INITIAL_STATE__?.videoInfo?.bvid,
        url: location.href,
        dur: Math.round(v?.duration ?? 0),
        h: v?.videoHeight ?? 0,
        samePlayer: window.__LAST_PLAYER__ === (window.nano && window.__LAST_PLAYER__),
      };
    });
    out.errors = errors;
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close().catch(() => {});
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({
    before: out.before,
    links: out.links,
    clicked: out.clicked,
    after: out.after,
    errors: out.errors,
    error: out.error,
  }, null, 2).slice(0, 26000));
})();
