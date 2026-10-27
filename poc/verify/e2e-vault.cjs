// 第 3 步端到端：登录 → 关闭浏览器 → 重开 → 凭据仍在（且是密文）
// 容错：窗口被用户关掉时，仍尝试读取已有存储状态
const { chromium } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs');

const EXT_DIR = path.resolve(__dirname, '../../.output/chrome-mv3');
const OUT = path.join(__dirname, 'result-vault-e2e.json');
const USER_DATA = path.resolve(__dirname, '../../.tmp/vault-profile');

const LAUNCH = {
  channel: 'msedge',
  // POC_HEADLESS=1 时无窗口运行（CI / 无显示器环境）。默认 false 保持原行为。
  headless: process.env.POC_HEADLESS === '1',
  viewport: { width: 420, height: 560 },
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
  ],
};

/** 只检查结构与明文泄露，不输出任何值 */
async function inspectLocal(sw) {
  return sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const blob = all['pluma:vault:blob'];
    const material = all['pluma:vault:key'];
    const raw = JSON.stringify(all);

    return {
      hasBlob: !!blob,
      blobMode: blob?.mode ?? null,
      blobVersion: blob?.v ?? null,
      hasIv: typeof blob?.iv === 'string' && blob.iv.length > 0,
      hasData: typeof blob?.data === 'string' && blob.data.length > 0,
      hasKeyMaterial: typeof material === 'string' && material.length > 0,
      keyLooksBase64: typeof material === 'string' && /^[A-Za-z0-9+/=]+$/.test(material),
      leakedPlaintext:
        raw.includes('SESSDATA') || raw.includes('bili_jct') || raw.includes('1000002'),
    };
  });
}

async function tryDecrypt(sw) {
  return sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const blob = all['pluma:vault:blob'];
    const material = all['pluma:vault:key'];
    if (!blob || !material) return { restored: false, reason: 'blob 或 key 缺失' };

    const b64 = (s) => {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
    };

    const key = await crypto.subtle.importKey('raw', b64(material), { name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);

    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, key, b64(blob.data));
      const obj = JSON.parse(new TextDecoder().decode(plain));
      return {
        restored: true,
        mode: blob.mode,
        hasSessdata: typeof obj.sessdata === 'string' && obj.sessdata.length > 0,
        hasBiliJct: typeof obj.biliJct === 'string' && obj.biliJct.length > 0,
        hasDedeUserId: typeof obj.dedeUserId === 'string' && obj.dedeUserId.length > 0,
      };
    } catch (e) {
      return { restored: false, reason: '解密失败: ' + String(e) };
    }
  });
}

(async () => {
  const report = {};

  // ── 阶段 1：登录 ──
  {
    const ctx = await chromium.launchPersistentContext(USER_DATA, LAUNCH);
    try {
      let sw = ctx.serviceWorkers()[0];
      if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
      const extId = new URL(sw.url()).host;

      const page = await ctx.newPage();
      await page.goto(`chrome-extension://${extId}/login-window.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!document.querySelector('canvas.qr-canvas'), { timeout: 45000 });
      console.log('PHASE1_WAITING_FOR_SCAN');

      let closed = false;
      page.on('close', () => {
        closed = true;
      });

      const deadline = Date.now() + 4 * 60 * 1000;
      let success = false;
      while (Date.now() < deadline) {
        if (closed || page.isClosed()) break;
        try {
          const txt = await page.evaluate(() => document.querySelector('.status')?.textContent ?? '');
          if (txt.includes('登录成功')) {
            success = true;
            break;
          }
          if (txt.includes('失效')) await page.click('.refresh').catch(() => {});
        } catch {
          closed = true;
          break;
        }
        await page.waitForTimeout(2000);
      }

      report.phase1 = { loginSuccess: success, windowClosedEarly: closed && !success };
      report.phase1.storage = await inspectLocal(sw);
    } catch (e) {
      report.phase1 = { ...(report.phase1 ?? {}), error: e.message };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // ── 阶段 2：重开浏览器，验证持久化 ──
  {
    const ctx2 = await chromium.launchPersistentContext(USER_DATA, LAUNCH);
    try {
      let sw2 = ctx2.serviceWorkers()[0];
      if (!sw2) sw2 = await ctx2.waitForEvent('serviceworker', { timeout: 20000 });
      report.phase2 = await tryDecrypt(sw2);
    } catch (e) {
      report.phase2 = { error: e.message };
    } finally {
      await ctx2.close().catch(() => {});
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
})();
