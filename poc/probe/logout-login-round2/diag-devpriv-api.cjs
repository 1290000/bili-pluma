#!/usr/bin/env node
/**
 * 诊断 3：枚举 chrome.developerPrivate 的真实方法名，
 * 找出等价于「在 InPrivate 中允许」开关的 setter。
 * 只读（只列方法名，不调用）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROUND = path.resolve(__dirname);
const TMP = path.resolve(ROUND, '..', '..', '..', '.tmp', 'investigator-q4diag3');
const PROFILE = path.join(TMP, 'profile');
const EXT = path.resolve(ROUND, '..', '..', '..', '.output', 'chrome-mv3');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9413;

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
        if (!hs) { this.buf = Buffer.concat([this.buf, c]); const i = this.buf.indexOf('\r\n\r\n'); if (i >= 0) { const h = this.buf.slice(0, i).toString(); if (!/101/.test(h)) return reject(new Error(h.split('\r\n')[0])); this.buf = this.buf.slice(i + 4); hs = true; resolve(); this._d(); } return; }
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
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('to ' + method)); } }, 20000); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(e, a = false) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: a, userGesture: true }); if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails)).slice(0, 300) }; return r.result.value; }
  close() { this.ws.close(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hj(u) { const r = await fetch(u); return r.json(); }

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience', `--remote-debugging-port=${PORT}`, `--load-extension=${EXT}`, 'about:blank'];
  const proc = spawn(EDGE, args, { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { await hj(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
    const list = await hj(`http://127.0.0.1:${PORT}/json/list`);
    const tab = list.find((t) => t.type === 'page');
    const c = new CDP(); await c.attach(tab.webSocketDebuggerUrl);
    await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Page.navigate', { url: 'edge://extensions/' });
    await sleep(7000);

    console.log('=== chrome.developerPrivate 全部键 ===');
    console.log(await c.ev(`JSON.stringify(Object.keys(chrome.developerPrivate).sort(), null, 0)`));

    console.log('\n=== 含 incognito / private / allow 的方法 ===');
    console.log(await c.ev(`JSON.stringify(Object.keys(chrome.developerPrivate).filter(k=>/incognito|private|allow/i.test(k)))`));

    console.log('\n=== 每个函数的 typeof（找出真能调用的）===');
    console.log(await c.ev(`JSON.stringify(Object.keys(chrome.developerPrivate).filter(k=>/incognito|private|allow/i.test(k)).map(k=>({k, t: typeof chrome.developerPrivate[k]})))`));

    console.log('\n=== Object.getOwnPropertyNames + 原型链（API 可能是 getter）===');
    console.log(await c.ev(`(() => {
      const out = new Set();
      let o = chrome.developerPrivate;
      while (o && o !== Object.prototype) {
        Object.getOwnPropertyNames(o).forEach(n => out.add(n));
        o = Object.getPrototypeOf(o);
      }
      return JSON.stringify(Array.from(out).filter(k=>/incognito|private|allow/i.test(k)));
    })()`));

    console.log('\n=== 完整 owned property 列表（前 200）===');
    console.log(await c.ev(`JSON.stringify(Object.getOwnPropertyNames(chrome.developerPrivate).sort())`));

    console.log('\n=== 有没有 chrome.extensions / chrome.management 可用 ===');
    console.log(await c.ev(`JSON.stringify({
      chromeKeys: Object.keys(window.chrome||{}).sort(),
      hasDeveloperPrivate: !!window.chrome.developerPrivate,
      hasManagement: !!window.chrome.management,
      hasExtensions: !!window.chrome.extensions
    }, null, 1)`));

    console.log('\n=== developerPrivate 里所有属性的 typeof（找 setter）===');
    console.log(await c.ev(`(() => {
      const r = {};
      for (const k of Object.getOwnPropertyNames(chrome.developerPrivate)) {
        try { r[k] = typeof chrome.developerPrivate[k]; } catch(e) { r[k] = 'THROW'; }
      }
      return JSON.stringify(r);
    })()`));
    c.close();
  } catch (e) { console.log('❌', e.message); }
  finally { try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {} }
})();
