#!/usr/bin/env node
/**
 * Q4 受控实验（方案 C，最终版）：CDP + chrome.developerPrivate
 *
 * 关键道具：edge://extensions 页面里有 chrome.developerPrivate
 *   - getExtensionsInfo()        → incognitoAccess: { isActive, isEnabled }（权威）
 *   - setAllowedIncognitoAccess(id, boolean) → 等价于点那个开关
 * 这比点 DOM 稳，也不依赖 WebUI 的 shadow 结构。
 *
 * ⛔ 独立 profile，绝不碰用户浏览器。
 *
 * 用法: node q4-cdp-experiment.cjs <mode>
 *   baseline            只开权限，验证道具可用
 *   idle                开权限 → 静置 5 分钟 → 掉不掉
 *   open-window-close   开权限 → 开 InPrivate 窗口 → 关掉 → 掉不掉
 *   open-window-keep    开权限 → 开 InPrivate 窗口不关 → 观察 90 秒
 *   flip-loop           反复开/关权限 + 开窗口，找「开窗后必掉」的复现率
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const mode = process.argv[2] || 'baseline'; // 必须先于 PROFILE 声明（const 有暂时性死区）

const ROUND = path.resolve(__dirname);
const TMP = path.resolve(ROUND, '..', '..', '..', '.tmp', 'investigator-q4');
// 每个 mode 用独立 profile 目录：并发跑时 rmSync 会互相 EPERM
const PROFILE = path.join(TMP, 'profile-' + mode);
const OUT = path.join(ROUND, 'raw', 'repro7');
const EXT = path.resolve(ROUND, '..', '..', '..', '.output', 'chrome-mv3');
const EXT_ID = 'fgmggjhdbgaclcbeaopajghpnhgkmfnf';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const PORT = 9440 + (['baseline', 'idle', 'open-window-close', 'open-window-keep', 'flip-loop'].indexOf(mode) + 1);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
const LOG = [];
function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  LOG.push(line); console.log(line);
  fs.writeFileSync(path.join(OUT, `q4-${mode}.log`), LOG.join('\n') + '\n', 'utf8');
}

class RawWS {
  constructor(u) { this.url = u; this.buf = Buffer.alloc(0); this.onmessage = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const m = /^ws:\/\/([^:\/]+):(\d+)(\/.*)$/.exec(this.url);
      const host = m[1], port = Number(m[2]), p = m[3];
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(port, host, () => this.sock.write(`GET ${p} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      let hs = false;
      this.sock.on('data', (c) => {
        if (!hs) {
          this.buf = Buffer.concat([this.buf, c]);
          const i = this.buf.indexOf('\r\n\r\n');
          if (i >= 0) { const h = this.buf.slice(0, i).toString(); if (!/101/.test(h)) return reject(new Error(h.split('\r\n')[0])); this.buf = this.buf.slice(i + 4); hs = true; resolve(); this._d(); }
          return;
        }
        this.buf = Buffer.concat([this.buf, c]); this._d();
      });
      this.sock.on('error', reject);
    });
  }
  _d() {
    for (;;) {
      if (this.buf.length < 2) return;
      const o = this.buf[0] & 0x0f; let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const pl = this.buf.slice(off, off + len); this.buf = this.buf.slice(off + len);
      if (o === 1 && this.onmessage) this.onmessage(pl.toString('utf8'));
    }
  }
  send(t) {
    const p = Buffer.from(t, 'utf8'), mk = crypto.randomBytes(4);
    let h;
    if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
    else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0xfe; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0xff; h.writeBigUInt64BE(BigInt(p.length), 2); }
    const m2 = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) m2[i] = p[i] ^ mk[i & 3];
    this.sock.write(Buffer.concat([h, mk, m2]));
  }
  close() { try { this.sock.destroy(); } catch {} }
}
class CDP {
  constructor() { this.id = 0; this.p = new Map(); }
  async attach(u) {
    this.ws = new RawWS(u);
    this.ws.onmessage = (t) => { let m; try { m = JSON.parse(t); } catch { return; } if (m.id != null && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
    await this.ws.connect(); return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('to ' + method)); } }, 25000); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async ev(e, a = false) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: a, userGesture: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
  close() { this.ws.close(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hj(u) { const r = await fetch(u); return r.json(); }

/**
 * Edge 157 没有 developerPrivate.setAllowedIncognitoAccess（已实测：not a function）。
 * 它把同一能力合并进了 updateExtensionConfiguration({ extensionId, incognitoAccess: boolean })。
 * 定义来源：msedge.dll @0x13154... 的 API schema
 *   {"id":"developerPrivate.ExtensionConfigurationUpdate","properties":{
 *      "extensionId":{"type":"string"},
 *      "fileAccess":{...},"incognitoAccess":{"type":"boolean","optional":true},
 *      "userScriptsAccess":{...},...}}
 */
const JS_READ = `(async () => {
  const infos = await chrome.developerPrivate.getExtensionsInfo({includeDisabled:true, includeTerminated:true});
  const me = infos.find(e => e.id === '${EXT_ID}');
  return JSON.stringify(me ? {
    isActive: me.incognitoAccess.isActive,
    isEnabled: me.incognitoAccess.isEnabled,
    pending: me.incognitoAccessPendingChange,
    state: me.state
  } : { err: 'not found' });
})()`;

const jsSet = (want) => `(async () => {
  await chrome.developerPrivate.updateExtensionConfiguration({
    extensionId: '${EXT_ID}',
    incognitoAccess: ${want}
  });
  await new Promise(r => setTimeout(r, 800));
  const infos = await chrome.developerPrivate.getExtensionsInfo({includeDisabled:true});
  const me = infos.find(e => e.id === '${EXT_ID}');
  return JSON.stringify(me ? {
    isActive: me.incognitoAccess.isActive,
    isEnabled: me.incognitoAccess.isEnabled,
    pending: me.incognitoAccessPendingChange
  } : { err: 'not found' });
})()`;

/** 经由扩展自己的 SW 读权威判据 isAllowedIncognitoAccess() */
async function readViaSW() {
  const list = await hj(`http://127.0.0.1:${PORT}/json/list`);
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  if (!sw) return { ok: false, err: 'ext SW not listed' };
  const c = new CDP();
  try {
    await c.attach(sw.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    const v = await c.ev(`chrome.extension.isAllowedIncognitoAccess()`, true);
    return { ok: true, allowed: v };
  } catch (e) { return { ok: false, err: String(e.message || e) }; }
  finally { c.close(); }
}

/**
 * 经 OS 层枚举 InPrivate 窗口，并**按本实例的 user-data-dir 精确归属**。
 * 为什么不只看标题：并发跑多个实例时 "InPrivate" 标题会互相污染
 * （本轮 E1 就被 E4 实例的窗口串了，见报告 §自更正）。
 * 做法：先用 Get-CimInstance 找出 cmdline 含本 profile 目录的所有 msedge pid，
 * 再在这些 pid 里找 MainWindowTitle 带 InPrivate 的。
 */
function listIncognitoWindows(profileDir) {
  const psFile = path.join(TMP, `enum-inprivate-${mode}.ps1`);
  const script = [
    '$profileDir = ' + "'" + String(profileDir).replace(/'/g, "''") + "'",
    '$pids = @(Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) } |',
    '  ForEach-Object { $_.ProcessId })',
    'if ($pids.Count -eq 0) { Write-Output "(no-process-for-this-profile)"; exit 0 }',
    '$hit = @()',
    'foreach ($p in $pids) {',
    '  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue',
    '  if ($proc -and $proc.MainWindowTitle -and $proc.MainWindowTitle -match "InPrivate") {',
    '    $hit += ("{0}|{1}" -f $p, $proc.MainWindowTitle)',
    '  }',
    '}',
    'if ($hit.Count -eq 0) { Write-Output "(none)" } else { $hit | ForEach-Object { Write-Output $_ } }',
  ].join('\r\n');
  try {
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(psFile, script, 'utf8');
    const r = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { encoding: 'utf8', timeout: 25000 });
    return r.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== '(none)' && s !== '(no-process-for-this-profile)');
  } catch (e) { return ['ERR:' + String(e.message).slice(0, 200)]; }
}

/**
 * 双判据读取：
 *   ① 扩展 SW 的 chrome.extension.isAllowedIncognitoAccess()（业务真值，但 SW 会休眠 → "ext SW not listed"）
 *   ② edge://extensions 页面的 developerPrivate.getExtensionsInfo().incognitoAccess.isEnabled
 *      （不受 SW 生命周期影响）
 * 两者都有时以 ① 为准，② 交叉验证。任一为 true 即"权限还在"。
 */
async function readBoth(pageCdp) {
  const sw = await readViaSW();
  let dp = null;
  if (pageCdp) {
    try { dp = JSON.parse(await pageCdp.ev(JS_READ, true)); } catch (e) { dp = { err: String(e.message || e).slice(0, 120) }; }
  }
  const allowed = sw.ok ? sw.allowed : (dp && typeof dp.isEnabled === 'boolean' ? dp.isEnabled : null);
  return { sw, dp, allowed };
}

/** 经扩展 SW 开 InPrivate 窗口（等价 Pluma 的 openLoginWindow 行为） */
async function openIncognitoViaSW() {
  const list = await hj(`http://127.0.0.1:${PORT}/json/list`);
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  if (!sw) return { ok: false, err: 'ext SW not listed' };
  const c = new CDP();
  try {
    await c.attach(sw.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    const r = await c.ev(`chrome.windows.create({url:'about:blank', type:'popup', incognito:true, width:420, height:600}).then(w=>({id:w&&w.id, incognito:w&&w.incognito})).catch(e=>({err:String(e)}))`, true);
    return { ok: true, created: r };
  } finally { c.close(); }
}

async function closeWindowViaSW(id) {
  const list = await hj(`http://127.0.0.1:${PORT}/json/list`);
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  if (!sw) return 'no sw';
  const c = new CDP();
  try {
    await c.attach(sw.webSocketDebuggerUrl); await c.send('Runtime.enable');
    return await c.ev(`chrome.windows.remove(${id}).then(()=>'ok').catch(e=>String(e))`, true);
  } finally { c.close(); }
}

(async () => {
  log(`=== Q4 mode=${mode} port=${PORT} ===`);
  log(`独立 profile: ${PROFILE}`);
  log(`扩展: ${EXT}`);
  log(`⛔ 用户浏览器零接触`);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const args = [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience', `--remote-debugging-port=${PORT}`, `--load-extension=${EXT}`, 'about:blank'];
  log(`启动: "${EDGE}" ${args.join(' ')}`);
  const proc = spawn(EDGE, args, { stdio: 'ignore' });
  log(`  pid=${proc.pid}`);

  const results = { mode, steps: [] };
  const step = (name, data) => { results.steps.push({ at: new Date().toISOString(), name, data }); log(`  ${name}: ${JSON.stringify(data)}`); };

  try {
    for (let i = 0; i < 60; i++) { try { await hj(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
    log('CDP 就绪');

    const list = await hj(`http://127.0.0.1:${PORT}/json/list`);
    const tab = list.find((t) => t.type === 'page');
    const c = new CDP(); await c.attach(tab.webSocketDebuggerUrl);
    await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Page.navigate', { url: 'edge://extensions/' });
    await sleep(6000);
    log('edge://extensions 已加载，chrome.developerPrivate 可用');

    step('初始 isAllowedIncognitoAccess', await readBoth(c));
    step('初始 developerPrivate', JSON.parse(await c.ev(JS_READ, true)));

    log('--- 打开「在 InPrivate 中允许」---');
    step('setAllowedIncognitoAccess(true)', JSON.parse(await c.ev(jsSet(true), true)));
    await sleep(2000);
    step('打开后 isAllowedIncognitoAccess', await readBoth(c));

    if (mode === 'baseline') {
      await sleep(5000);
      step('5 秒后再读', await readBoth(c));
      step('5 秒后 developerPrivate', JSON.parse(await c.ev(JS_READ, true)));
    }

    if (mode === 'idle') {
      log('--- 静置 5 分钟，每 30 秒读一次 ---');
      for (let t = 30; t <= 300; t += 30) {
        await sleep(30000);
        step(`t=${t}s`, await readBoth(c));
      }
    }

    if (mode === 'open-window-close') {
      log('--- 开 InPrivate 窗口（经扩展 SW，等价 Pluma 行为）---');
      const before = listIncognitoWindows(PROFILE);
      step('开窗前 OS 层 InPrivate 窗口', before);
      const opened = await openIncognitoViaSW();
      step('windows.create(incognito:true)', opened);
      await sleep(3000);
      const mid = listIncognitoWindows(PROFILE);
      step('开窗后 OS 层 InPrivate 窗口', mid);
      step('OS 层验证', {
        开窗前数: before.length,
        开窗后数: mid.length,
        真的开出来了: mid.length > before.length
      });
      for (const t of [5, 10, 20, 30]) {
        await sleep(t === 5 ? 5000 : (t === 10 ? 5000 : 10000));
        step(`开窗 t≈${t}s`, await readBoth(c));
      }
      if (opened.created && opened.created.id != null) {
        step('windows.remove', await closeWindowViaSW(opened.created.id));
      } else {
        log('  ⚠️ windows.create 没返回 id（与真机 diag 的 id=undefined 一致），改用 OS 层关闭');
        try {
          const ps = `Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'InPrivate|无痕' } | ForEach-Object { Stop-Process -Id $_.Id -Force }`;
          execSync(`powershell -NoProfile -Command ${JSON.stringify(ps)}`, { stdio: 'ignore', timeout: 20000 });
        } catch {}
      }
      await sleep(3000);
      step('关窗后 OS 层 InPrivate 窗口', listIncognitoWindows(PROFILE));
      await sleep(5000);
      step('关窗后 +5s', await readBoth(c));
      await sleep(10000);
      step('关窗后 +15s', await readBoth(c));
      await sleep(15000);
      step('关窗后 +30s', await readBoth(c));
    }

    if (mode === 'open-window-keep') {
      log('--- 开 InPrivate 窗口但不关，观察 120 秒 ---');
      const before = listIncognitoWindows(PROFILE);
      step('开窗前 OS 层 InPrivate 窗口', before);
      const opened = await openIncognitoViaSW();
      step('windows.create(incognito:true)', opened);
      await sleep(3000);
      const mid = listIncognitoWindows(PROFILE);
      step('开窗后 OS 层 InPrivate 窗口', mid);
      step('OS 层验证', { 开窗前数: before.length, 开窗后数: mid.length, 真的开出来了: mid.length > before.length });
      for (let t = 15; t <= 120; t += 15) {
        await sleep(15000);
        step(`开窗后 t=${t}s`, await readBoth(c));
      }
    }

    if (mode === 'flip-loop') {
      log('--- 反复：开权限 → 开窗 → 读 → 关窗 → 关权限，共 3 轮 ---');
      const rounds = [];
      for (let r = 1; r <= 3; r++) {
        log(`  第 ${r} 轮`);
        await c.ev(jsSet(true), true);
        await sleep(1500);
        const beforeWin = await readBoth(c);
        const opened = await openIncognitoViaSW();
        await sleep(12000);
        const afterWin = await readBoth(c);
        const dp = JSON.parse(await c.ev(JS_READ, true));
        rounds.push({ round: r, beforeWin, opened, afterWin, developerPrivate: dp });
        log(`    开窗前=${JSON.stringify(beforeWin)} 开窗后=${JSON.stringify(afterWin)} dp=${JSON.stringify(dp)}`);
        if (opened.created && opened.created.id != null) await closeWindowViaSW(opened.created.id);
        await sleep(3000);
        await c.ev(jsSet(false), true);
        await sleep(1500);
        step(`第${r}轮收尾`, await readBoth(c));
      }
      results.rounds = rounds;
    }

    fs.writeFileSync(path.join(OUT, `q4-${mode}.json`), JSON.stringify(results, null, 2), 'utf8');
    log(`结果 -> raw/repro7/q4-${mode}.json`);
    c.close();
  } catch (e) {
    log(`❌ ${e.message}`);
    log(e.stack || '');
    fs.writeFileSync(path.join(OUT, `q4-${mode}.json`), JSON.stringify(results, null, 2), 'utf8');
  } finally {
    log('关闭实验进程树…');
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    log('=== 结束 ===');
  }
})();
