/**
 * 只读核查：把「① 权限刚打开」和「② 无痕分区已激活」两个变量分开。
 *
 * 上一轮 q4-incognito-api-gate.cjs 的观察：
 *   阶段1 ①（权限刚开 5s，无痕分区从未激活）chrome-extension:// → created:null
 *   阶段1 ②（+10s，无痕分区仍未激活）about:blank → created:成功
 *   阶段2 ①（无痕分区已被 --inprivate 激活）chrome-extension:// → created:成功
 *
 * 但阶段1 ① 和 ② 之间只差 10 秒，无法排除「权限刚开需要时间生效」这个变量。
 * 本脚本设计四组正交实验（每组用**全新 profile**，避免互相污染）：
 *
 *   G1: 全新 profile → 开权限 → **立刻** cre﻿ate(chrome-extension://)   【复现阶段1①】
 *   G2: 全新 profile → 开权限 → 等 60 秒 → create(chrome-extension://) 【排「权限生效延迟」】
 *   G3: 全新 profile → 开权限 → create(about:blank) → 再 create(chrome-extension://)
 *        【无痕分区刚被自己激活，但没用过 --inprivate】
 *   G4: 全新 profile → 开权限 → create(chrome-extension://) 连试 3 次
 *        【排「第一次必失败」还是「永久失败」】
 *
 * 用法：node q4-gate-separate.cjs <G1|G2|G3|G4>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const GROUP = process.argv[2] || 'G1';
const ROUND = path.resolve(__dirname);
const TMP = path.resolve(ROUND, '..', '..', '..', '.tmp', 'investigator-q4');
const PROFILE = path.join(TMP, `profile-gate-${GROUP}`);
const OUT = path.join(ROUND, 'raw', 'repro7');
const EXT = path.resolve(ROUND, '..', '..', '..', '.output', 'chrome-mv3');
const EXT_ID = 'fgmggjhdbgaclcbeaopajghpnhgkmfnf';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9451 + ['G1', 'G2', 'G3', 'G4'].indexOf(GROUP);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
const LOG = [];
function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  LOG.push(line); console.log(line);
  fs.writeFileSync(path.join(OUT, `q4-gate-${GROUP}.log`), LOG.join('\n') + '\n', 'utf8');
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

const CREATE_EXT = `(async () => {
  try {
    const w = await chrome.windows.create({ url: 'chrome-extension://${EXT_ID}/need-incognito.html', type: 'popup', incognito: true, width: 460, height: 420 });
    return JSON.stringify({ ok: true, created: w ? { id: w.id, incognito: w.incognito, type: w.type } : null });
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); }
})()`;

const CREATE_BLANK = `(async () => {
  try {
    const w = await chrome.windows.create({ url: 'about:blank', type: 'popup', incognito: true, width: 460, height: 420 });
    return JSON.stringify({ ok: true, created: w ? { id: w.id, incognito: w.incognito, type: w.type } : null });
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); }
})()`;

const ALL_WIN = `(async () => {
  try {
    const a = await chrome.windows.getAll({});
    return JSON.stringify(a.map(w => ({ id: w.id, incognito: w.incognito, type: w.type })));
  } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
})()`;

(async () => {
  log(`=== ${GROUP} 门槛分离实验 ===`);
  log('独立 profile: ' + PROFILE);
  log('⛔ 用户浏览器零接触');

  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  const child = spawn(EDGE, [
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience', `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`, 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  log('  pid=' + child.pid);

  for (let i = 0; i < 40; i++) { try { await hj(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
  log('CDP 就绪');

  const getSW = async () => {
    const l = await hj(`http://127.0.0.1:${PORT}/json/list`);
    const sw = l.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
    if (!sw) return null;
    const x = new CDP(); await x.attach(sw.webSocketDebuggerUrl); return x;
  };

  const l0 = await hj(`http://127.0.0.1:${PORT}/json/list`);
  const blankT = l0.find((t) => t.type === 'page');
  const page = new CDP(); await page.attach(blankT.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: 'edge://extensions/' });
  await sleep(6000);

  const openPerm = await page.ev(`(async () => {
    try {
      await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(EXT_ID)}, incognitoAccess: true });
      const info = (await chrome.developerPrivate.getExtensionsInfo()).find(e => e.id === ${JSON.stringify(EXT_ID)});
      return JSON.stringify({ incognitoAccess: info && info.incognitoAccess });
    } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
  })()`);
  const tPermOpen = Date.now();
  log('  权限已打开: ' + openPerm);

  let sw = await getSW();
  if (!sw) { await sleep(3000); sw = await getSW(); }
  if (!sw) throw new Error('ext SW not found');

  if (GROUP === 'G1') {
    log('  --- G1: 权限刚开，立刻 create(chrome-extension://) ---');
    log('  Δt=' + (Date.now() - tPermOpen) + 'ms');
    log('  → ' + await sw.ev(CREATE_EXT));
    await sleep(4000);
    log('  windows.getAll: ' + await sw.ev(ALL_WIN));
  }

  if (GROUP === 'G2') {
    log('  --- G2: 开权限后等 60 秒再 create(chrome-extension://) ---');
    for (let t = 10; t <= 60; t += 10) {
      await sleep(10000);
      log(`  t=${t}s 已过，继续等`);
    }
    log('  Δt=' + (Date.now() - tPermOpen) + 'ms');
    log('  → ' + await sw.ev(CREATE_EXT));
    await sleep(4000);
    log('  windows.getAll: ' + await sw.ev(ALL_WIN));
  }

  if (GROUP === 'G3') {
    log('  --- G3: 先 create(about:blank) 激活无痕分区，再 create(chrome-extension://) ---');
    log('  ① about:blank → ' + await sw.ev(CREATE_BLANK));
    await sleep(5000);
    log('  windows.getAll: ' + await sw.ev(ALL_WIN));
    log('  ② chrome-extension:// → ' + await sw.ev(CREATE_EXT));
    await sleep(5000);
    log('  windows.getAll: ' + await sw.ev(ALL_WIN));
  }

  if (GROUP === 'G4') {
    log('  --- G4: create(chrome-extension://) 连试 3 次，看是否「第一次必失败」 ---');
    for (let i = 1; i <= 3; i++) {
      const r = await sw.ev(CREATE_EXT);
      log(`  第${i}次 → ` + r);
      await sleep(4000);
      log(`      windows.getAll: ` + await sw.ev(ALL_WIN));
      if (r.includes('"created":{"id"')) { log('      （成功，停止重试）'); break; }
    }
  }

  fs.writeFileSync(path.join(OUT, `q4-gate-${GROUP}.json`), JSON.stringify({ group: GROUP, steps: LOG }, null, 2), 'utf8');
  log(`结果 -> raw/repro7/q4-gate-${GROUP}.json`);

  page.close(); sw && sw.close();
  try {
    const p = PROFILE.replace(/\\/g, '\\\\');
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${p}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore', timeout: 25000 });
  } catch {}
  log('=== 结束 ===');
  process.exit(0);
})().catch((e) => { log('❌ ' + e.message); process.exit(1); });
