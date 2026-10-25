// 验证 WBI 签名是否被 B站接受 —— 判据是 code=0 且 dash 里有 2160p 轨道
// 全程不输出任何凭据值
const { chromium } = require('playwright');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EXT_DIR = path.resolve(__dirname, '../../.output/chrome-mv3');
const OUT = path.join(__dirname, 'result-dnr-e2e.json');
const USER_DATA = path.resolve(__dirname, '../../.tmp/dnr-profile-' + Date.now());

const LAUNCH = {
  channel: 'msedge',
  headless: false,
  viewport: { width: 420, height: 560 },
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
  ],
};

(async () => {
  const report = {};
  const ctx = await chromium.launchPersistentContext(USER_DATA, LAUNCH);

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;

    // 先看有没有已存的凭据
    const exists = await sw.evaluate(async () => {
      const all = await chrome.storage.local.get('pluma:vault:blob');
      return !!all['pluma:vault:blob'];
    });
    report.hasCredential = exists;

    if (!exists) {
      // 需要先登录
      const page = await ctx.newPage();
      await page.goto(`chrome-extension://${extId}/login-window.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!document.querySelector('canvas.qr-canvas'), { timeout: 45000 });
      console.log('NEED_LOGIN');

      const deadline = Date.now() + 4 * 60 * 1000;
      let ok = false;
      while (Date.now() < deadline) {
        const txt = await page.evaluate(() => document.querySelector('.status')?.textContent ?? '');
        if (txt.includes('登录成功')) {
          ok = true;
          break;
        }
        if (txt.includes('失效')) await page.click('.refresh').catch(() => {});
        await page.waitForTimeout(2000);
      }
      report.loginSuccess = ok;
      if (!ok) throw new Error('登录未完成');
      await page.close();
    }

    // 核心测试：在 SW 里走完整取流链路
    report.result = await sw.evaluate(async () => {
      // 直接调 background 的模块不方便，这里复现链路：
      // 1) 读凭据  2) 拿 WBI 密钥  3) 签名  4) DNR 换 cookie  5) 请求

      const b64 = (s) => {
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
        return out;
      };

      // 1) 解出凭据（不解密也可以，这里需要真实凭据）
      const all = await chrome.storage.local.get(null);
      const blob = all['pluma:vault:blob'];
      const material = all['pluma:vault:key'];
      if (!blob || !material) return { error: '无凭据' };

      const key = await crypto.subtle.importKey('raw', b64(material), { name: 'AES-GCM', length: 256 }, true, [
        'encrypt',
        'decrypt',
      ]);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, key, b64(blob.data));
      const cred = JSON.parse(new TextDecoder().decode(plain));

      // 2) WBI 密钥
      const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
      const nav = await navRes.json();
      const imgUrl = nav?.data?.wbi_img?.img_url;
      const subUrl = nav?.data?.wbi_img?.sub_url;
      if (!imgUrl || !subUrl) return { error: 'nav 无 wbi_img' };

      const extractKey = (u) => {
        const n = u.slice(u.lastIndexOf('/') + 1);
        const d = n.indexOf('.');
        return d === -1 ? n : n.slice(0, d);
      };

      const TAB = [
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
        12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
        57, 62, 11, 36, 20, 34, 44, 52,
      ];
      const raw = extractKey(imgUrl) + extractKey(subUrl);
      let mixin = '';
      for (const i of TAB) mixin += raw[i] ?? '';
      mixin = mixin.slice(0, 32);

      // MD5（用浏览器没有内置，这里借 SW 的 crypto 不行，改用内置实现）
      const md5 = (str) => {
        const msg = new TextEncoder().encode(str);
        const bitLen = msg.length * 8;
        const padded = (((msg.length + 8) >> 6) + 1) << 6;
        const buf = new Uint8Array(padded);
        buf.set(msg);
        buf[msg.length] = 0x80;
        const dv = new DataView(buf.buffer);
        dv.setUint32(padded - 8, bitLen >>> 0, true);
        dv.setUint32(padded - 4, Math.floor(bitLen / 0x100000000), true);

        let a0 = 0x67452301,
          b0 = 0xefcdab89,
          c0 = 0x98badcfe,
          d0 = 0x10325476;
        const s = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
        const K = new Uint32Array(64);
        for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

        for (let off = 0; off < padded; off += 64) {
          const m = new Uint32Array(16);
          for (let j = 0; j < 16; j += 1) m[j] = dv.getUint32(off + j * 4, true);
          let A = a0,
            B = b0,
            C = c0,
            D = d0;
          for (let i = 0; i < 64; i += 1) {
            let F, g;
            if (i < 16) {
              F = (B & C) | (~B & D);
              g = i;
            } else if (i < 32) {
              F = (D & B) | (~D & C);
              g = (5 * i + 1) % 16;
            } else if (i < 48) {
              F = B ^ C ^ D;
              g = (3 * i + 5) % 16;
            } else {
              F = C ^ (B | ~D);
              g = (7 * i) % 16;
            }
            F = (F + A + K[i] + m[g]) >>> 0;
            A = D;
            D = C;
            C = B;
            const sh = s[(i >> 4) * 4 + (i % 4)];
            B = (B + ((F << sh) | (F >>> (32 - sh)))) >>> 0;
          }
          a0 = (a0 + A) >>> 0;
          b0 = (b0 + B) >>> 0;
          c0 = (c0 + C) >>> 0;
          d0 = (d0 + D) >>> 0;
        }
        const hexLE = (n) => {
          let o = '';
          for (let i = 0; i < 4; i += 1) o += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
          return o;
        };
        return [a0, b0, c0, d0].map(hexLE).join('');
      };

      // 3) 签名
      const wts = Math.floor(Date.now() / 1000);
      const params = {
        bvid: 'BV1beNcz2ECq',
        cid: '36532588493',
        fnval: '4048',
        fourk: '1',
        qn: '0',
        wts: String(wts),
      };
      const query = Object.keys(params)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k].replace(/[!'()*]/g, ''))}`)
        .join('&');
      const wRid = md5(query + mixin);

      // 4) 设备 cookie 从当前页面借（SW 里没有页面，用空的先测凭据本身）
      const cookieHeader = `SESSDATA=${cred.sessdata}; bili_jct=${cred.biliJct}; DedeUserID=${cred.dedeUserId}`;

      const url = `https://api.bilibili.com/x/player/wbi/playurl?${query}&w_rid=${wRid}`;

      // 5) DNR 换 cookie
      const ruleId = 9999;
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [
          {
            id: ruleId,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'cookie', operation: 'set', value: cookieHeader }],
            },
            condition: { urlFilter: `|${url}|`, resourceTypes: ['xmlhttprequest'] },
          },
        ],
      });

      try {
        const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
        const body = await res.json();
        const d = body?.data ?? {};

        const heights = (d.dash?.video ?? []).map((v) => v.height);
        return {
          httpStatus: res.status,
          code: body.code,
          message: body.message,
          maxHeight: heights.length ? Math.max(...heights) : null,
          trackCount: heights.length,
          hasFlac: !!d.dash?.flac?.audio,
          hasDolby: !!(d.dash?.dolby?.audio?.length),
          acceptQuality: d.accept_quality ?? null,
        };
      } finally {
        await chrome.declarativeNetRequest
          .updateSessionRules({ removeRuleIds: [ruleId] })
          .catch(() => {});
      }
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
