#!/usr/bin/env node
/**
 * 诊断：CDP 连上 edge://extensions 之后，页面到底长什么样？
 * 目的：确定操作「在 InPrivate 中允许」开关的正确 DOM 路径。
 * 只读，不点任何东西。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROUND = path.resolve(__dirname);
const TMP = path.resolve(ROUND, '..', '..', '..', '.tmp', 'investigator-q4diag');
const PROFILE = path.join(TMP, 'profile');
const EXT = path.resolve(ROUND, '..', '..', '..', '.output', 'chrome-mv3');
const EXT_ID = 'fgmggjhdbgaclcbeaopajghpnhgkmfnf';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9410;

class RawWS {
  constructor(url) { this.url = url; this.buf = Buffer.alloc(0); this.onmessage = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const m = /^ws:\/\/([^:\/]+):(\d+)(\/.*)$/.exec(this.url);
      const host = m[1], port = Number(m[2]), p = m[3];
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(port, host, () => {
        this.sock.write(`GET ${p} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let hs = false;
      this.sock.on('data', (chunk) => {
        if (!hs) {
          this.buf = Buffer.concat([this.buf, chunk]);
          const i = this.buf.indexOf('\r\n\r\n');
          if (i >= 0) { const head = this.buf.slice(0, i).toString(); if (!/101/.test(head)) return reject(new Error(head.split('\r\n')[0])); this.buf = this.buf.slice(i + 4); hs = true; resolve(); this._d(); }
          return;
        }
        this.buf = Buffer.concat([this.buf, chunk]); this._d();
      });
      this.sock.on('error', reject);
    });
  }
  _d() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1]; let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const pl = this.buf.slice(off, off + len); this.buf = this.buf.slice(off + len);
      if ((this.buf.length, (this.buf, 1)) && this.onmessage) this.onmessage(pl.toString('utf8'));
    }
  }
  send(t) {
    const p = Buffer.from(t, 'utf8'), mask = crypto.randomBytes(4);
    let head;
    if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length]);
    else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(p.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xff; head.writeBigUInt64BE(BigInt(p.length), 2); }
    const mk = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) mk[i] = p[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, mk]));
  }
  close() { try { this.sock.destroy(); } catch {} }
}
class CDP {
  constructor() { this.id = 0; this.pending = new Map(); }
  async attach(u) {
    this.ws = new RawWS(u);
    this.ws.onmessage = (txt) => {
      let m; try { m = JSON.parse(txt); } catch { return; }
      if (m.id != null && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
    };
    await this.ws.connect(); return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async ev(expr, awaitP = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP, userGesture: true });
    if (r.exceptionDetails) return { __exc: JSON.stringify(r.exceptionDetails).slice(0, 500) };
    return r.result.value;
  }
  close() { this.ws.close(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hj(u) { const r = await fetch(u); return r.json(); }

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience', `--remote-debugging-port=${PORT}`, `--load-extension=${EXT}`, 'about:blank'];
  console.log('启动独立 Edge…');
  const proc = spawn(EDGE, args, { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { await hj(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
    console.log('CDP 就绪');
    const list = await hj(`http://127.0.0.1:${PORT}/json/list`);
    const tab = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
    console.log('target:', tab.url);
    const c = new CDP(); await c.attach(tab.webSocketDebuggerUrl);
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    console.log('\n--- navigate -> edge://extensions/ ---');
    console.log(JSON.stringify(await c.send('Page.navigate', { url: 'edge://extensions/' })));

    for (const wait of [2000, 3000, 5000]) {
      await sleep(wait);
      console.log(`\n=== 导航后累计 ~${wait}ms 累积等待，检查页面状态 ===`);
      const st = await c.ev(`JSON.stringify({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyTag: document.body ? document.body.firstElementChild && document.body.firstElementChild.tagName : null,
        bodyChildren: document.body ? document.body.children.length : -1,
        hasMgr: !!document.querySelector('extensions-manager'),
        hasMgrDeep: !!(document.querySelector('extensions-manager')),
        topTags: document.body ? Array.from(document.body.querySelectorAll('*')).slice(0,8).map(e=>e.tagName) : [],
        htmlLen: document.documentElement.outerHTML.length
      })`);
      console.log(st);
      const m = await c.ev(`JSON.stringify({ hasMgr: !!document.querySelector('extensions-manager') })`);
      if (m && m.includes('true')) break;
    }

    console.log('\n=== 输出页面完整结构（前 3000 字符）===');
    console.log(await c.ev(`document.documentElement.outerHTML.slice(0,3000)`));

    console.log('\n=== 列所有自定义元素（含 shadow）===');
    console.log(await c.ev(`(() => {
      const out = [];
      const walk = (n, d) => {
        if (!n || d > 6) return;
        if (n.tagName && n.tagName.includes('-')) out.push('  '.repeat(d) + n.tagName + (n.id ? '#'+n.id : ''));
        if (n.children) for (const ch of n.children) walk(ch, d+1);
        if (n.shadowRoot) walk(n.shadowRoot, d+1);
      };
      walk(document.body, 0);
      return out.slice(0, 80).join('\\n');
    })()`));

    console.log('\n=== 尝试 extensions-manager 是否挂在 window 上 ===');
    console.log(await c.ev(`JSON.stringify({
      hasWindowMgr: typeof window.extensionsManager,
      keys: Object.keys(window).filter(k=>/extens/i.test(k))
    })`));
    c.close();
  } catch (e) {
    console.log('❌', e.message);
    console.log(e.stack);
  } finally {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    console.log('\n已关闭实验进程');
  }
})();
