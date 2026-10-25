// 重点验证三件事：
//   1. P3 / P4 的 playurl 到底有没有发（可能是 __playinfo__ 预取）
//   2. 8K（qn=127）能否拿到，需要什么条件
//   3. 播放器实际选的轨道是什么（含 HDR / 杜比视界判定）
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const EXT_DIR = path.resolve(__dirname, '../../.output/chrome-mv3');
const PROFILE = path.resolve(__dirname, '../../.tmp/page-profile');
const OUT = path.join(__dirname, 'result-8k-check.json');
const BASE = 'https://www.bilibili.com/video/BV1beNcz2ECq/';

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const report = {};
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });

    // ── 1. P4（8K 目标）打开，看 playurl 与 __playinfo__ ──
    const page = await ctx.newPage();
    const reqs = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (/playurl|playview/i.test(u.pathname)) {
        reqs.push({ path: u.pathname, qn: u.searchParams.get('qn'), fnval: u.searchParams.get('fnval') });
      }
    });

    await page.goto(`${BASE}?p=4`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(14000);

    report.p4 = {
      requests: reqs,
      pageInfo: await page.evaluate(() => {
        const pi = window.__playinfo__;
        const d = pi?.data ?? pi?.result ?? null;
        const v = document.querySelector('video');
        return {
          hasPlayinfo: typeof pi !== 'undefined',
          playinfoTrackHeights: d?.dash?.video ? d.dash.video.map((x) => x.height) : null,
          playinfoAcceptQuality: d?.accept_quality ?? null,
          videoEl: v ? { h: v.videoHeight, w: v.videoWidth } : null,
          activeQuality: document.querySelector('.bpx-player-ctrl-quality-result')?.textContent?.trim() ?? null,
          qualityMenu: [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')].map((e) => ({
            text: (e.textContent || '').trim().replace(/\s+/g, ' '),
            cls: e.className.includes('active') ? 'ACTIVE' : '',
          })),
        };
      }),
    };

    // ── 2. 手动切到 8K，看能不能成功 ──
    report.switchTo8k = await page.evaluate(async () => {
      const items = [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')];
      const eight = items.find((e) => (e.textContent || '').includes('8K'));
      if (!eight) return { found: false };
      return { found: true, text: (eight.textContent || '').trim().replace(/\s+/g, ' ') };
    });

    // 尝试点击 8K
    try {
      await page.click('.bpx-player-ctrl-quality', { timeout: 5000 });
      await page.waitForTimeout(800);
      const items = await page.$$('.bpx-player-ctrl-quality-menu-item');
      for (const it of items) {
        const txt = (await it.textContent()) || '';
        if (txt.includes('8K')) {
          await it.click();
          break;
        }
      }
      await page.waitForTimeout(8000);
      report.afterSwitch8k = await page.evaluate(() => {
        const v = document.querySelector('video');
        return {
          videoEl: v ? { h: v.videoHeight, w: v.videoWidth } : null,
          activeQuality: document.querySelector('.bpx-player-ctrl-quality-result')?.textContent?.trim() ?? null,
        };
      });
    } catch (e) {
      report.switchError = e.message;
    }

    // ── 3. 用 background 直接请求 8K（qn=127），看服务端给不给 ──
    report.direct8k = await sw.evaluate(async () => {
      const b64 = (s) => {
        const bin = atob(s);
        const o = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) o[i] = bin.charCodeAt(i);
        return o;
      };
      const all = await chrome.storage.local.get(null);
      const blob = all['pluma:vault:blob'];
      const material = all['pluma:vault:key'];
      const key = await crypto.subtle.importKey('raw', b64(material), { name: 'AES-GCM', length: 256 }, true, [
        'encrypt',
        'decrypt',
      ]);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, key, b64(blob.data));
      const cred = JSON.parse(new TextDecoder().decode(plain));

      // WBI
      const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })).json();
      const ik = (nav?.data?.wbi_img?.img_url ?? '').split('/').pop().split('.')[0];
      const sk = (nav?.data?.wbi_img?.sub_url ?? '').split('/').pop().split('.')[0];
      const TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
      const raw = ik + sk;
      let mixin = '';
      for (const i of TAB) mixin += raw[i] ?? '';
      mixin = mixin.slice(0, 32);

      const md5 = (str) => {
        // 简化：调用内置实现不可行，改用 importScripts 不可用，这里用 WebCrypto 无 MD5
        // 退而求其次：不签名，直接带 cookie 请求，看是否仍可用
        return '';
      };

      const cookieValue = `SESSDATA=${cred.sessdata}; bili_jct=${cred.biliJct}; DedeUserID=${cred.dedeUserId}`;
      const results = {};

      for (const qn of ['0', '127']) {
        const url = `https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1beNcz2ECq&cid=36532588493&fnval=4048&fourk=1&qn=${qn}`;
        const id = 4400 + Number(qn);
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [id],
          addRules: [{
            id, priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'set', value: cookieValue }] },
            condition: { urlFilter: `|${url}|`, resourceTypes: ['xmlhttprequest'] },
          }],
        });
        try {
          const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
          const b = await res.json();
          const hs = (b?.data?.dash?.video ?? []).map((x) => x.height);
          results['qn' + qn] = {
            code: b.code,
            message: b.message,
            maxHeight: hs.length ? Math.max(...hs) : null,
            heights: [...new Set(hs)].sort((a, c) => c - a),
            quality: b?.data?.quality ?? null,
          };
        } catch (e) {
          results['qn' + qn] = { error: String(e) };
        } finally {
          await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
        }
      }

      return results;
    });
  } catch (e) {
    report.error = e.message;
  } finally {
    await ctx.close().catch(() => {});
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 1));
    process.exit(0);
  }
})();
