// 核实：测试 profile 里到底是什么身份
// 判据：nav 接口返回的 mid 是哪一个，以及 storage 里存的播放账号 mid
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const EXT_DIR = path.resolve(__dirname, '../../.output/chrome-mv3');
const PROFILE = path.resolve(__dirname, '../../.tmp/page-profile');
const OUT = path.join(__dirname, 'result-identity-audit.json');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
    ],
  });

  const out = {};
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });

    // 1) 浏览器当前登录态是谁（不带任何 DNR 规则）
    out.browserIdentity = await sw.evaluate(async () => {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        credentials: 'include',
        cache: 'no-store',
      });
      const j = await r.json();
      return {
        code: j.code,
        isLogin: j.data?.isLogin ?? null,
        mid: j.data?.mid ?? null,
        uname: j.data?.uname ?? null,
        vipStatus: j.data?.vipStatus ?? null,
      };
    });

    // 2) vault 里存的播放账号是谁（只取 mid，不取值）
    out.playbackIdentity = await sw.evaluate(async () => {
      const b64 = (s) => {
        const bin = atob(s);
        const o = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) o[i] = bin.charCodeAt(i);
        return o;
      };
      const all = await chrome.storage.local.get(null);
      const blob = all['pluma:vault:blob'];
      const material = all['pluma:vault:key'];
      if (!blob || !material) return null;
      const key = await crypto.subtle.importKey('raw', b64(material), { name: 'AES-GCM', length: 256 }, true, [
        'encrypt',
        'decrypt',
      ]);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, key, b64(blob.data));
      const cred = JSON.parse(new TextDecoder().decode(plain));
      return { mid: cred.dedeUserId ?? null };
    });

    // 3) 两者是否相同
    out.sameAccount =
      String(out.browserIdentity?.mid ?? '') === String(out.playbackIdentity?.mid ?? '');

    // 4) 浏览器里有多少 bilibili cookie（看是否登录了多个账号）
    out.cookieSummary = await sw.evaluate(async () => {
      const cookies = await chrome.cookies.getAll({ domain: 'bilibili.com' });
      return {
        total: cookies.length,
        hasSessdata: cookies.some((c) => c.name === 'SESSDATA'),
        dedeUserId: cookies.find((c) => c.name === 'DedeUserID')?.value ?? null,
      };
    });
  } catch (e) {
    out.error = e.message;
  } finally {
    await ctx.close().catch(() => {});
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify(out, null, 1));
    process.exit(0);
  }
})();
