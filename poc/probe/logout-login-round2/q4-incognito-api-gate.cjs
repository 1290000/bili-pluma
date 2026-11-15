/**
 * 只读核查：为什么独立 profile 里 chrome.windows.create({incognito:true}) 返回 null，
 * 而用户真实 profile 里能开出窗口（OS 层确认过 HWND 4393142 / pid=508 等）。
 *
 * 已知差异候选：
 *   D1. 独立 profile 从未开过 InPrivate 窗口 —— 第一次 create 可能被 Edge 拦（首次体验/引导）
 *   D2. 独立 profile 缺 "InPrivate" 相关 onboarding 状态
 *   D3. Edge 157 对「扩展在全新 profile 里开无痕窗口」有额外门槛
 *   D4. windows.create 的 url 是 chrome-extension:// 而 Edge 拒绝了这种组合
 *
 * 判据设计：在同一个独立 profile 里先后试三种 url，
 *   ① chrome-extension://<id>/need-incognito.html（Pluma 真实用法）
 *   ② about:blank（最简）
 *   ③ https://example.com（普通网页）
 *   每次都在之前先手动用 --inprivate 命令行开一个 InPrivate 窗口"激活"无痕分区，
 *   再试 API。若激活后 API 变成功 ⇒ D1 成立。
 *
 * 用法：node q4-incognito-api-gate.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROUND = path.resolve(__dirname);
const TMP = path.resolve(ROUND, '..', '..', '..', '.tmp', 'investigator-q4');
const PROFILE = path.join(TMP, 'profile-incog-gate');
const OUT = path.join(ROUND, 'raw', 'repro7');
const EXT = path.resolve(ROUND, '..', '..', '..', '.output', 'chrome-mv3');
const EXT_ID = 'fgmggjhdbgaclcbeaopajghpnhgkmfnf';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9450;

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
const LOG = [];
function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  LOG.push(line); console.log(line);
  fs.writeFileSync(path.join(OUT, 'q4-incognito-api-gate.log'), LOG.join('\n') + '\n', 'utf8');
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
        const s = d.toString('utf8');
        if (!s.includes('101')) return rej(new Error('ws handshake: ' + s.slice(0, 120)));
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
      try { const msg = JSON.parse(payload.toString('utf8')); const w = this.waiters.get(msg.id); if (w) { this.waiters.delete(msg.id); w(msg); } } catch {}
    }
  }
  _send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4); const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xff; header.writeBigUInt64BE(BigInt(payload.length), 2); }
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
  async attach(u) { this.ws = new RawWS(u); await this.ws.ready; await this.ws.send('Runtime.enable'); }
  send(m, p) { return this.ws.send(m, p); }
  async ev(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { this.ws && this.ws.close(); }
}

function listWindows(profileDir) {
  const psFile = path.join(TMP, 'enum-gate.ps1');
  const script = [
    '$profileDir = ' + "'" + String(profileDir).replace(/'/g, "''") + "'",
    '$pids = @(Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) } | ForEach-Object { $_.ProcessId })',
    'if ($pids.Count -eq 0) { Write-Output "(no-process)"; exit 0 }',
    '$hit = @()',
    'foreach ($p in $pids) { $proc = Get-Process -Id $p -ErrorAction SilentlyContinue',
    '  if ($proc -and $proc.MainWindowTitle) { $hit += ("{0}|{1}" -f $p, $proc.MainWindowTitle) } }',
    'if ($hit.Count -eq 0) { Write-Output "(no-titled-window)" } else { $hit | ForEach-Object { Write-Output $_ } }',
  ].join('\r\n');
  try {
    fs.writeFileSync(psFile, script, 'utf8');
    const r = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { encoding: 'utf8', timeout: 25000 });
    return r.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== '(no-process)');
  } catch (e) { return ['ERR:' + String(e.message).slice(0, 150)]; }
}

const tryCreate = (url) => `(async () => {
  try {
    const w = await chrome.windows.create({ url: ${JSON.stringify(url)}, type: 'popup', incognito: true, width: 460, height: 420 });
    return JSON.stringify({ ok: true, created: w ? { id: w.id, incognito: w.incognito, type: w.type } : null });
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); }
})()`;

const tryCreateNormal = (url) => `(async () => {
  try {
    const w = await chrome.windows.create({ url: ${JSON.stringify(url)}, type: 'popup', width: 460, height: 420 });
    return JSON.stringify({ ok: true, created: w ? { id: w.id, incognito: w.incognito, type: w.type } : null });
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); }
})()`;

(async () => {
  log('=== InPrivate 窗口创建门槛诊断 ===');
  log('独立 profile: ' + PROFILE);
  log('⛔ 用户浏览器零接触');

  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  const args = [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience', `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`, 'about:blank'];
  const child = spawn(EDGE, args, { detached: true, stdio: 'ignore' });
  child.unref();
  log('  主实例 pid=' + child.pid);

  for (let i = 0; i < 40; i++) { try { await hj(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
  log('CDP 就绪');

  const getSW = async () => {
    const l = await hj(`http://127.0.0.1:${PORT}/json/list`);
    const sw = l.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
    if (!sw) return null;
    const x = new CDP(); await x.attach(sw.webSocketDebuggerUrl); return x;
  };

  // 打开权限
  const l0 = await hj(`http://127.0.0.1:${PORT}/json/list`);
  const blank = l0.find((t) => t.type === 'page');
  const c = new CDP(); await c.attach(blank.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: 'edge://extensions/' });
  await sleep(6000);
  const openPerm = await c.ev(`(async () => {
    try {
      await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(EXT_ID)}, incognitoAccess: true });
      const info = (await chrome.developerPrivate.getExtensionsInfo()).find(e => e.id === ${JSON.stringify(EXT_ID)});
      return JSON.stringify({ incognitoAccess: info && info.incognitoAccess });
    } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
  })()`);
  log('  打开权限: ' + openPerm);

  // ── 阶段 1：全新 profile，从没开过 InPrivate 窗口，直接试三种 url ──
  log('');
  log('═══ 阶段 1：全新 profile（从未开过 InPrivate 窗口）═══');
  log('  OS 层: ' + JSON.stringify(listWindows(PROFILE)));
  let sw = await getSW();
  log('  ① chrome-extension://…/need-incognito.html → ' + await sw.ev(tryCreate(`chrome-extension://${EXT_ID}/need-incognito.html`)));
  await sleep(5000);
  log('     OS 层: ' + JSON.stringify(listWindows(PROFILE)));
  sw.close(); sw = await getSW();
  log('  ② about:blank → ' + await sw.ev(tryCreate('about:blank')));
  await sleep(5000);
  log('     OS 层: ' + JSON.stringify(listWindows(PROFILE)));
  sw.close(); sw = await getSW();
  log('  ③ https://example.com → ' + await sw.ev(tryCreate('https://example.com')));
  await sleep(5000);
  log('     OS 层: ' + JSON.stringify(listWindows(PROFILE)));

  // ── 阶段 2：用命令行 --inprivate 先"激活"无痕分区，再试 API ──
  log('');
  log('═══ 阶段 2：先命令行 --inprivate 开一个真无痕窗口（激活无痕分区），再试 API ═══');
  const incog = spawn(EDGE, [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--inprivate', 'about:blank'], { detached: true, stdio: 'ignore' });
  incog.unref();
  log('  --inprivate 实例 pid=' + incog.pid);
  await sleep(8000);
  log('  OS 层: ' + JSON.stringify(listWindows(PROFILE)));
  sw.close(); sw = await getSW();
  if (!sw) { log('  ⚠️ 权限激活后扩展 SW 不在，尝试等待'); await sleep(4000); sw = await getSW(); }
  if (sw) {
    log('  ① chrome-extension://…/need-incognito.html → ' + await sw.ev(tryCreate(`chrome-extension://${EXT_ID}/need-incognito.html`)));
    await sleep(5000);
    log('     OS 层: ' + JSON.stringify(listWindows(PROFILE)));
    sw.close(); sw = await getSW();
    if (sw) {
      log('  ② about:blank → ' + await sw.ev(tryCreate('about:blank')));
      await sleep(5000);
      log('     OS 层: ' + JSON.stringify(listWindows(PROFILE)));
    }
  }

  // ── 阶段 3：对照 incognito:false（不带 incognito 字段）──
  log('');
  log('═══ 阶段 3：对照 —— 不带 incognito 字段 ═══');
  sw && sw.close(); sw = await getSW();
  if (sw) {
    log('  chrome-extension://…/need-incognito.html（无 incognito 字段）→ ' + await sw.ev(tryCreateNormal(`chrome-extension://${EXT_ID}/need-incognito.html`)));
    await sleep(5000);
    log('     OS 层: ' + JSON.stringify(listWindows(PROFILE)));
  }

  fs.writeFileSync(path.join(OUT, 'q4-incognito-api-gate.json'), JSON.stringify({ steps: LOG }, null, 2), 'utf8');
  log('结果 -> raw/repro7/q4-incognito-api-gate.json');

  c.close(); sw && sw.close();
  log('关闭实验进程树…');
  try {
    const p = PROFILE.replace(/\\/g, '\\\\');
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${p}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore', timeout: 25000 });
  } catch {}
  log('=== 结束 ===');
  process.exit(0);
})().catch((e) => { log('❌ ' + e.message); process.exit(1); });
