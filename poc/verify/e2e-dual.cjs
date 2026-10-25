// 双账号验证：主账号（普通用户）浏览，播放账号（大会员）代理取流
// 流程：① 等用户在窗口里登录主账号 ② 再扫码登录播放账号 ③ 打开视频页对比画质
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const EXT_DIR = path.resolve(__dirname, '../../.output/chrome-mv3');
const PROFILE = path.resolve(__dirname, '../../.tmp/dual-profile');
const OUT = path.join(__dirname, 'result-dual-account.json');
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

  const report = { steps: [] };
  const navInfo = async (sw) =>
    sw.evaluate(async () => {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        credentials: 'include',
        cache: 'no-store',
      });
      const j = await r.json();
      return { code: j.code, isLogin: j.data?.isLogin ?? false, mid: j.data?.mid ?? null, uname: j.data?.uname ?? null, vipStatus: j.data?.vipStatus ?? null };
    });

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;

    // ── 步骤 1：等主账号登录 ──
    const primary = await navInfo(sw);
    report.primaryBefore = primary;

    if (!primary.isLogin) {
      console.log('STEP1_NEED_PRIMARY_LOGIN');
      const p = await ctx.newPage();
      await p.goto('https://passport.bilibili.com/login', { waitUntil: 'domcontentloaded' });

      // 等主账号登录（最多 5 分钟）
      const deadline = Date.now() + 5 * 60 * 1000;
      let ok = false;
      while (Date.now() < deadline) {
        const n = await navInfo(sw);
        if (n.isLogin) {
          ok = true;
          report.primaryAfter = n;
          break;
        }
        await p.waitForTimeout(2000);
      }
      await p.close().catch(() => {});
      if (!ok) throw new Error('主账号未登录');
    } else {
      report.primaryAfter = primary;
    }

    report.steps.push('主账号已登录: ' + report.primaryAfter.uname);

    // ── 步骤 2：记录主账号身份下的画质基线（不装任何规则）──
    await sw.evaluate(async () => {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
    });

    const baseline = await ctx.newPage();
    const baselinePlayurls = [];
    baseline.on('response', async (res) => {
      if (!new URL(res.url()).pathname.includes('/x/player/wbi/playurl')) return;
      try {
        const b = await res.json();
        const hs = (b?.data?.dash?.video ?? []).map((x) => x.height);
        baselinePlayurls.push({ code: b.code, maxHeight: hs.length ? Math.max(...hs) : null, heights: [...new Set(hs)].sort((a, c) => c - a) });
      } catch {}
    });
    await baseline.goto(`${BASE}?p=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await baseline.waitForTimeout(12000);
    report.baseline = {
      playurls: baselinePlayurls,
      videoEl: await baseline.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { h: v.videoHeight, w: v.videoWidth } : null;
      }),
      qualityMenu: await baseline.evaluate(() =>
        [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')].map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ')),
      ),
    };
    await baseline.close();

    report.steps.push('基线（纯主账号）已记录');

    // ── 步骤 3：扫码登录播放账号 ──
    const hasVault = await sw.evaluate(async () => {
      const a = await chrome.storage.local.get('pluma:vault:blob');
      return !!a['pluma:vault:blob'];
    });

    if (!hasVault) {
      console.log('STEP2_NEED_PLAYBACK_LOGIN');
      const login = await ctx.newPage();
      await login.goto(`chrome-extension://${extId}/login-window.html`, { waitUntil: 'domcontentloaded' });
      await login.waitForFunction(() => !!document.querySelector('canvas.qr-canvas'), { timeout: 45000 });

      const deadline = Date.now() + 5 * 60 * 1000;
      let ok = false;
      while (Date.now() < deadline) {
        const txt = await login.evaluate(() => document.querySelector('.status')?.textContent ?? '');
        if (txt.includes('登录成功')) {
          ok = true;
          break;
        }
        if (txt.includes('失效')) await login.click('.refresh').catch(() => {});
        await login.waitForTimeout(2000);
      }
      await login.close().catch(() => {});
      if (!ok) throw new Error('播放账号未登录');
    }

    // 检查两账号是否相同
    report.sameAccountCheck = await sw.evaluate(async () => {
      const b64 = (s) => {
        const bin = atob(s);
        const o = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) o[i] = bin.charCodeAt(i);
        return o;
      };
      const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })).json();
      const primaryMid = nav?.data?.mid ?? null;

      const all = await chrome.storage.local.get(null);
      const blob = all['pluma:vault:blob'];
      const material = all['pluma:vault:key'];
      const key = await crypto.subtle.importKey('raw', b64(material), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, key, b64(blob.data));
      const cred = JSON.parse(new TextDecoder().decode(plain));
      return { primaryMid, playbackMid: cred.dedeUserId, same: String(primaryMid) === String(cred.dedeUserId) };
    });

    report.steps.push('两账号检查: ' + (report.sameAccountCheck.same ? '相同(无效)' : '不同(有效)'));

    if (report.sameAccountCheck.same) throw new Error('两账号相同，无法验证');

    // ── 步骤 4：装规则后再打开，看画质 ──
    const test = await ctx.newPage();
    const testPlayurls = [];
    test.on('response', async (res) => {
      if (!new URL(res.url()).pathname.includes('/x/player/wbi/playurl')) return;
      try {
        const b = await res.json();
        const hs = (b?.data?.dash?.video ?? []).map((x) => x.height);
        testPlayurls.push({ code: b.code, maxHeight: hs.length ? Math.max(...hs) : null, heights: [...new Set(hs)].sort((a, c) => c - a) });
      } catch {}
    });

    await test.goto(`${BASE}?p=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await test.waitForTimeout(14000);

    report.afterProxy = {
      playurls: testPlayurls,
      videoEl: await test.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { h: v.videoHeight, w: v.videoWidth } : null;
      }),
      qualityMenu: await test.evaluate(() =>
        [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')].map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ')),
      ),
      activeQuality: await test.evaluate(() => document.querySelector('.bpx-player-ctrl-quality-result')?.textContent?.trim() ?? null),
      pageUser: await test.evaluate(() => {
        const el = document.querySelector('.header-entry-mini, .bili-avatar-img');
        return { hasAvatar: !!el };
      }),
    };

    report.tabRules = await sw.evaluate(async () => {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      return rules.filter((r) => r.id >= 20000).map((r) => ({ id: r.id, tabIds: r.condition.tabIds }));
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
