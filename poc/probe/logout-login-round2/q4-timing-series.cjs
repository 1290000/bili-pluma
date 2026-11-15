/**
 * 只读核查：chrome.windows.create({incognito:true}) 的成败到底跟什么相关？
 *
 * 已观察到的矛盾：
 *   轮次A（q4-incognito-api-gate.cjs，主实例启动后 ~12s）：chrome-extension:// 失败，about:blank 成功，https 成功
 *   轮次B（q4-gate-separate G1/G2/G3/G4，主实例启动后 ~11s）：全部失败，连 about:blank 都失败
 *   ⇒ 「启动后多久」和「无痕分区是否已激活」两个变量搅在一起，必须逐一固定。
 *
 * 本脚本在**同一个 profile 的同一个实例**里做时间序列：
 *   先开权限 → 然后每隔 10 秒试一次 create(about:blank, incognito:true)
 *   记录每次的 created 值，直到成功或 180 秒。
 * 这能直接回答「是启动后多久才开始能开」。
 *
 * 用法：node q4-timing-series.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROUND = path.resolve(__dirname);
const TMP = path.resolve(ROUND, '..', '..', '..', '.tmp', 'investigator-q4');
const PROFILE = path.join(TMP, 'profile-timing');
const OUT = path.join(ROUND, 'raw', 'repro7');
const EXT = path.resolve(ROUND, '..', '..', '..', '.output', 'chrome-mv3');
const EXT_ID = 'fgmggjhdbgaclcbeaopajghpnhgkmfnf';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9456;

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
const LOG = [];
function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  LOG.push(line); console.log(line);
  fs.writeFileSync(path.join(OUT, 'q4-timing-series.log'), LOG.join('\n') + '\n', 'utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hj(url) { const r = await fetch(url); return r.json(); }

class RawWS {
  constructor(urlStr) {
    const u = new URL(urlStr);
    this.key = crypto.randomBytes(16).toString('base64');
    this.buf = Buffer.alloc(0); this.waiters = new Map(); this.id = 0;
    this.sock = net.connect({ host: u.hostname, port: Number(u.port) }, () => {
      this.sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    this.ready = new Promise((res, rej) => {
      this.sock.once('data', (d) => {
        if (!d.toString('utf8').includes('101')) return rej(new Error('ws: ' + d.toString('utf8').slice(0, 100)));
        this.sock.removeAllListeners('data');
        this.sock.on('data', (x) => this._onData(x)); res();
      });
      this.sock.once('error', rej);
    });
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1]; const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f; let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off; if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const mask = masked ? this.buf.slice(maskOff, maskOff + 4) : null;
      const payload = Buffer.from(this.buf.slice(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.slice(off + len);
      try { const m = JSON.parse(payload.toString('utf8')); const w = this.waiters.get(m.id); if (w) { this.waiters.delete(m.id); w(m); } } catch {}
    }
  }
  _send(obj) {
    const p = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4); const m2 = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) m2[i] = p[i] ^ mask[i % 4];
    let h;
    if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
    else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0xfe; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0xff; h.writeBigUInt64BE(BigInt(p.length), 2); }
    this.sock.write(Buffer.concat([h, mask, m2]));
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiters.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
      this._send({ id, method, params });
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
  close() { try { this.sock.destroy(); } catch {} }
}
class CDP {
  constructor() { this.ws = null; }
  async attach(u) { this.ws = new RawWS(u); await this.ws.ready; await this.ws.send('Runtime.enable'); }
  send(m, p) { return this.ws.send(m, p); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { this.ws && this.ws.close(); }
}

function listWin(profileDir) {
  const psFile = path.join(TMP, 'enum-timing.ps1');
  const s = [
    '$profileDir = ' + "'" + String(profileDir).replace(/'/g, "''") + "'",
    '$pids = @(Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) } | ForEach-Object { $_.ProcessId })',
    'if ($pids.Count -eq 0) { Write-Output "(none)"; exit 0 }',
    '$h = @(); foreach ($p in $pids) { $pr = Get-Process -Id $p -ErrorAction SilentlyContinue',
    '  if ($pr -and $pr.MainWindowTitle) { $h += ("{0}|{1}" -f $p, $pr.MainWindowTitle) } }',
    'if ($h.Count -eq 0) { Write-Output "(none)" } else { $h | ForEach-Object { Write-Output $_ } }',
  ].join('\r\n');
  try {
    fs.writeFileSync(psFile, s, 'utf8');
    const r = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { encoding: 'utf8', timeout: 25000 });
    return r.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && x !== '(none)');
  } catch (e) { return ['ERR']; }
}

const CREATE = `(async () => {
  try {
    const w = await chrome.windows.create({ url: 'about:blank', type: 'popup', incognito: true, width: 460, height: 420 });
    return JSON.stringify({ ok: true, created: w ? { id: w.id, incognito: w.incognito } : null });
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); }
})()`;
const CREATE_EXT = `(async () => {
  try {
    const w = await chrome.windows.create({ url: 'chrome-extension://${EXT_ID}/need-incognito.html', type: 'popup', incognito: true, width: 460, height: 420 });
    return JSON.stringify({ ok: true, created: w ? { id: w.id, incognito: w.incognito } : null });
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); }
})()`;

(async () => {
  log('=== 时间序列：create({incognito:true}) 什么时候开始成功 ===');
  log('独立 profile: ' + PROFILE);
  log('⛔ 用户浏览器零接触');
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); } catch {}

  const t0 = Date.now();
  const child = spawn(EDGE, [
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience', `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`, 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  log('  主进程 pid=' + child.pid);

  for (let i = 0; i < 60; i++) { try { await hj(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
  log('  CDP 就绪 @ t=' + (Date.now() - t0) + 'ms');

  const getSW = async () => {
    const l = await hj(`http://127.0.0.1:${PORT}/json/list`);
    const sw = l.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
    if (!sw) return null;
    const x = new CDP(); await x.attach(sw.webSocketDebuggerUrl); return x;
  };

  const l0 = await hj(`http://127.0.0.1:${PORT}/json/list`);
  const bt = l0.find((t) => t.type === 'page');
  const page = new CDP(); await page.attach(bt.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: 'edge://extensions/' });
  await sleep(6000);
  const perm = await page.ev(`(async () => {
    try {
      await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(EXT_ID)}, incognitoAccess: true });
      const i = (await chrome.developerPrivate.getExtensionsInfo()).find(e => e.id === ${JSON.stringify(EXT_ID)});
      return JSON.stringify({ incognitoAccess: i && i.incognitoAccess });
    } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
  })()`);
  log('  权限已开 @ t=' + (Date.now() - t0) + 'ms  ' + perm);

  // 每 10 秒试一次 about:blank，连试 18 次（180 秒）
  for (let i = 0; i < 18; i++) {
    const sw = await getSW();
    if (!sw) { log(`  [${i}] t=${((Date.now() - t0) / 1000).toFixed(0)}s  SW 不在，跳过`); await sleep(10000); continue; }
    const r = await sw.ev(CREATE);
    const win = listWin(PROFILE);
    log(`  [${i}] t=${((Date.now() - t0) / 1000).toFixed(0)}s  about:blank → ${r}   OS=${JSON.stringify(win)}`);
    sw.close();
    if (r.includes('"created":{"id"')) {
      log('  ✅ about:blank 成功，接着试 chrome-extension://');
      await sleep(3000);
      const sw2 = await getSW();
      if (sw2) {
        const r2 = await sw2.ev(CREATE_EXT);
        log(`  chrome-extension:// → ${r2}   OS=${JSON.stringify(listWin(PROFILE))}`);
        sw2.close();
        if (r2.includes('"created":{"id"')) { log('  ✅ chrome-extension:// 也成功'); break; }
      }
    }
    await sleep(10000);
  }

  fs.writeFileSync(path.join(OUT, 'q4-timing-series.json'), JSON.stringify({ steps: LOG }, null, 2), 'utf8');
  log('结果 -> raw/repro7/q4-timing-series.json');
  page.close();
  try {
    const p = PROFILE.replace(/\\/g, '\\\\');
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${p}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore', timeout: 25000 });
  } catch {}
  log('=== 结束 ===');
  process.exit(0);
})().catch((e) => { log('❌ ' + e.message); process.exit(1); });
