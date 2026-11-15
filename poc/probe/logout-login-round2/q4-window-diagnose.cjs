/**
 * 只读核查：chrome.windows.create({incognito:true}) 在独立 profile 里
 * 到底开出了什么窗口？为什么 OS 层看不到 [InPrivate]。
 *
 * 三种可能：
 *   A. 根本没开出任何窗口（API 静默失败）
 *   B. 开出了普通窗口（incognito:true 被降级忽略）—— 标题无 [InPrivate]
 *   C. 开出了 InPrivate 窗口但 MainWindowTitle 拿不到
 *
 * 判据：开窗前 / 开窗后分别枚举本 profile 的全部顶层窗口（不限标题），
 *       比较窗口数与窗口标题，并额外用 windows.getAll() 从 API 侧读。
 *
 * 用法：node q4-window-diagnose.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROUND = path.resolve(__dirname);
const TMP = path.resolve(ROUND, '..', '..', '..', '.tmp', 'investigator-q4');
const PROFILE = path.join(TMP, 'profile-window-diag');
const OUT = path.join(ROUND, 'raw', 'repro7');
const EXT = path.resolve(ROUND, '..', '..', '..', '.output', 'chrome-mv3');
const EXT_ID = 'fgmggjhdbgaclcbeaopajghpnhgkmfnf';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9449;

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const LOG = [];
function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  LOG.push(line); console.log(line);
  fs.writeFileSync(path.join(OUT, 'q4-window-diagnose.log'), LOG.join('\n') + '\n', 'utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hj(url) {
  const res = await fetch(url);
  return res.json();
}

class RawWS {
  constructor(urlStr) {
    const u = new URL(urlStr);
    this.key = crypto.randomBytes(16).toString('base64');
    this.buf = Buffer.alloc(0);
    this.waiters = new Map();
    this.id = 0;
    this.sock = net.connect({ host: u.hostname, port: Number(u.port) }, () => {
      this.sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    this.ready = new Promise((res, rej) => {
      this.sock.once('data', (d) => {
        const s = d.toString('utf8');
        if (!s.includes('101')) return rej(new Error('ws handshake failed: ' + s.slice(0, 120)));
        this.sock.removeAllListeners('data');
        this.sock.on('data', (x) => this._onData(x));
        res();
      });
      this.sock.once('error', rej);
    });
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1];
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const mask = masked ? this.buf.slice(maskOff, maskOff + 4) : null;
      const payload = Buffer.from(this.buf.slice(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.slice(off + len);
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        const w = this.waiters.get(msg.id);
        if (w) { this.waiters.delete(msg.id); w(msg); }
      } catch { /* ignore */ }
    }
  }
  _send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) {
      header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.sock.write(Buffer.concat([header, mask, masked]));
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
  async attach(wsUrl) { this.ws = new RawWS(wsUrl); await this.ws.ready; }
  async send(m, p) { return this.ws.send(m, p); }
  async ev(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { this.ws && this.ws.close(); }
}

/** 枚举本 profile 全部顶层窗口（不限 InPrivate 标题） */
function listAllWindows(profileDir) {
  const psFile = path.join(TMP, 'enum-all-probe.ps1');
  const script = [
    '$profileDir = ' + "'" + String(profileDir).replace(/'/g, "''") + "'",
    '$pids = @(Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) } |',
    '  ForEach-Object { $_.ProcessId })',
    'if ($pids.Count -eq 0) { Write-Output "(no-process)"; exit 0 }',
    '$hit = @()',
    'foreach ($p in $pids) {',
    '  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue',
    '  if ($proc -and $proc.MainWindowTitle) {',
    '    $hit += ("{0}|{1}" -f $p, $proc.MainWindowTitle)',
    '  }',
    '}',
    'if ($hit.Count -eq 0) { Write-Output "(no-titled-window)" } else { $hit | ForEach-Object { Write-Output $_ } }',
  ].join('\r\n');
  try {
    fs.writeFileSync(psFile, script, 'utf8');
    const r = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { encoding: 'utf8', timeout: 25000 });
    return r.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== '(no-process)');
  } catch (e) { return ['ERR:' + String(e.message).slice(0, 200)]; }
}

const JS_ALL_WINDOWS = `(async () => {
  try {
    const all = await chrome.windows.getAll({ populate: false });
    return JSON.stringify(all.map(w => ({ id: w.id, incognito: w.incognito, type: w.type, state: w.state, tabs: (w.tabs||[]).length })));
  } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
})()`;

const JS_CREATE = (url) => `(async () => {
  try {
    const w = await chrome.windows.create({ url: ${JSON.stringify(url)}, type: 'popup', incognito: true, width: 460, height: 420 });
    return JSON.stringify({ created: w ? { id: w.id, incognito: w.incognito, type: w.type, state: w.state } : null });
  } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
})()`;

(async () => {
  log('=== 窗口诊断：windows.create({incognito:true}) 到底开出什么 ===');
  log('独立 profile: ' + PROFILE);
  log('⛔ 用户浏览器零接触');

  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  const args = [
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience', `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`, 'about:blank',
  ];
  const child = spawn(EDGE, args, { detached: true, stdio: 'ignore' });
  child.unref();
  log('  pid=' + child.pid);

  for (let i = 0; i < 40; i++) {
    try { await hj(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); }
  }
  log('CDP 就绪');

  // 用 Page.navigate（工作脚本 q4-cdp-experiment.cjs:263 就是这么做的）
  // /json/new 对 edge:// 会 400；Target.createTarget 也未必被允许
  const list0 = await hj(`http://127.0.0.1:${PORT}/json/list`);
  const blank = list0.find((t) => t.type === 'page');
  if (!blank) { log('❌ 没有可用的 page target'); throw new Error('no page target'); }
  const c = new CDP(); await c.attach(blank.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: 'edge://extensions/' });
  await sleep(6000);

  const list = await hj(`http://127.0.0.1:${PORT}/json/list`);
  log('  tabs: ' + JSON.stringify(list.map((t) => ({ type: t.type, url: t.url.slice(0, 70) }))));
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('edge://extensions'));
  const swT = list.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  if (!page) { log('❌ 找不到 edge://extensions 页面'); throw new Error('no extensions page'); }
  log('  edge://extensions 已加载');

  // 1) 打开权限
  const setR = await c.ev(`(async () => {
    try {
      await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(EXT_ID)}, incognitoAccess: true });
      const info = (await chrome.developerPrivate.getExtensionsInfo()).find(e => e.id === ${JSON.stringify(EXT_ID)});
      return JSON.stringify({ incognitoAccess: info && info.incognitoAccess });
    } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
  })()`, true);
  log('  打开权限: ' + setR);

  // 2) OS 层：开窗前
  log('  --- OS 层（本 profile 全部带标题窗口）---');
  log('  开窗前: ' + JSON.stringify(listAllWindows(PROFILE)));

  // 3) API 侧：开窗前 windows.getAll
  // ⚠️ swT 必须现取：页面导航后 target id 会变（上一轮报 "No such target id"）
  async function getSW() {
    const l = await hj(`http://127.0.0.1:${PORT}/json/list`);
    const sw = l.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
    if (!sw) return null;
    const x = new CDP();
    await x.attach(sw.webSocketDebuggerUrl);
    await x.send('Runtime.enable');
    return x;
  }
  let swc = await getSW();
  if (!swc) { log('❌ 找不到扩展 SW（尝试激活）'); await sleep(3000); swc = await getSW(); }
  if (!swc) throw new Error('ext SW not found');
  log('  API 开窗前 windows.getAll: ' + (await swc.ev(JS_ALL_WINDOWS, true)));

  // 4) 经扩展 SW 开 InPrivate 窗口
  const createR = await swc.ev(JS_CREATE('chrome-extension://' + EXT_ID + '/need-incognito.html'), true);
  log('  windows.create(incognito:true): ' + createR);
  await sleep(6000);

  log('  开窗后: ' + JSON.stringify(listAllWindows(PROFILE)));
  swc.close();
  swc = await getSW();
  if (swc) log('  API 开窗后 windows.getAll: ' + (await swc.ev(JS_ALL_WINDOWS, true)));

  await sleep(6000);
  log('  +6s 再读: ' + JSON.stringify(listAllWindows(PROFILE)));

  // 5) 对照：同一 profile 里用 chrome.windows.create 但 incognito:false
  if (swc) {
    const createNormal = await swc.ev(`(async () => {
      try {
        const w = await chrome.windows.create({ url: 'about:blank', type: 'popup', incognito: false, width: 460, height: 420 });
        return JSON.stringify({ created: w ? { id: w.id, incognito: w.incognito, type: w.type } : null });
      } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
    })()`, true);
    log('  对照 incognito:false: ' + createNormal);
    await sleep(4000);
    log('  对照后 OS 层: ' + JSON.stringify(listAllWindows(PROFILE)));
    log('  对照后 windows.getAll: ' + (await swc.ev(JS_ALL_WINDOWS, true)));
  }

  log('结果 -> raw/repro7/q4-window-diagnose.json');
  fs.writeFileSync(path.join(OUT, 'q4-window-diagnose.json'), JSON.stringify({ steps: LOG }, null, 2), 'utf8');

  if (swc) swc.close(); c.close();
  log('关闭实验进程树…');
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${PROFILE.replace(/\\/g, '\\\\')}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'ignore', timeout: 20000 });
  } catch {}
  log('=== 结束 ===');
  process.exit(0);
})().catch((e) => { log('❌ ' + e.message); process.exit(1); });
