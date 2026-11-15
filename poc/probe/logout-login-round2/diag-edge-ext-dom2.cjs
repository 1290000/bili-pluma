#!/usr/bin/env node
/**
 * 诊断 2：Edge 157 新版扩展页（<root-app> WebUI）里，
 * 怎么找到 Pluma 那张卡片、以及「在 InPrivate 中允许」开关。
 *
 * 只读：只枚举 DOM，不点击。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROUND = path.resolve(__dirname);
const TMP = path.resolve(ROUND, '..', '..', '..', '.tmp', 'investigator-q4diag2');
const PROFILE = path.join(TMP, 'profile');
const EXT = path.resolve(ROUND, '..', '..', '..', '.output', 'chrome-mv3');
const EXT_ID = 'fgmggjhdbgaclcbeaopajghpnhgkmfnf';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9411;

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
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('to ' + method)); } }, 20000); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async ev(e, a = false) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: a, userGesture: true });
    if (r.exceptionDetails) return { __exc: JSON.stringify(r.exceptionDetails).slice(0, 500) };
    return r.result.value;
  }
  close() { this.ws.close(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hj(u) { const r = await fetch(u); return r.json(); }

// 深度遍历整个 shadow 树
const DEEP_WALK = `
function deepWalk(root, out, depth) {
  if (!root || depth > 12) return;
  const kids = root.children ? Array.from(root.children) : [];
  for (const c of kids) {
    out.push({ d: depth, tag: c.tagName ? c.tagName.toLowerCase() : '?', id: c.id || '', cls: (c.className && typeof c.className === 'string') ? c.className : '' });
    deepWalk(c, out, depth + 1);
    if (c.shadowRoot) deepWalk(c.shadowRoot, out, depth + 1);
  }
}
`;

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience', `--remote-debugging-port=${PORT}`, `--load-extension=${EXT}`, 'about:blank'];
  console.log('启动独立 Edge…');
  const proc = spawn(EDGE, args, { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { await hj(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
    const list = await hj(`http://127.0.0.1:${PORT}/json/list`);
    const tab = list.find((t) => t.type === 'page');
    const c = new CDP(); await c.attach(tab.webSocketDebuggerUrl);
    await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Page.navigate', { url: 'edge://extensions/' });
    console.log('已导航，等 12 秒让扩展列表完全加载…');
    await sleep(12000);

    console.log('\n=== 1) 全 DOM 树（含 shadow）===');
    const tree = await c.ev(`(() => { ${DEEP_WALK} const out=[]; deepWalk(document.body,out,0); return out.map(x=>'  '.repeat(x.d)+x.tag+(x.id?'#'+x.id:'')+(x.cls?' .'+x.cls.split(' ')[0]:'')).join('\\n'); })()`);
    console.log(tree);

    console.log('\n=== 2) 页面文本里有没有 Pluma / InPrivate ===');
    console.log(await c.ev(`(() => {
      function allText(root, acc) { if(!root) return acc;
        const kids = root.children ? Array.from(root.children) : [];
        for (const c of kids) { allText(c, acc); if (c.shadowRoot) allText(c.shadowRoot, acc); }
        if (root.textContent && root.children && root.children.length === 0) acc.push(root.textContent);
        return acc; }
      const t = allText(document.body, []).join(' ').replace(/\\s+/g,' ');
      return JSON.stringify({ len: t.length, hasPluma: /Pluma/.test(t), hasInPrivate: /InPrivate|无痕/.test(t), sample: t.slice(0,600) });
    })()`));

    console.log('\n=== 3) 找所有 cr-toggle / toggle / switch 元素 ===');
    console.log(await c.ev(`(() => {
      const out = [];
      const walk = (n, d) => { if(!n||d>14) return;
        if (n.tagName && /toggle|switch/i.test(n.tagName)) {
          const lbl = (n.parentElement && n.parentElement.textContent || '').replace(/\\s+/g,' ').trim().slice(0,60);
          out.push({ tag: n.tagName.toLowerCase(), id: n.id||'', checked: n.hasAttribute('checked')||n.checked===true, disabled: n.hasAttribute('disabled')||n.disabled===true, near: lbl });
        }
        if (n.children) for (const ch of n.children) walk(ch, d+1);
        if (n.shadowRoot) walk(n.shadowRoot, d+1);
      };
      walk(document.body, 0);
      return JSON.stringify(out, null, 1);
    })()`));

    console.log('\n=== 4) 有没有 my-extension-page 内部的列表容器 ===');
    console.log(await c.ev(`(() => {
      const out = [];
      const walk = (n,d) => { if(!n||d>14) return;
        if (n.tagName && /^MY-EXTENSION/.test(n.tagName)) {
          out.push({ tag: n.tagName, id: n.id||'', kids: n.children?n.children.length:-1, htmlLen: (n.innerHTML||'').length, hasShadow: !!n.shadowRoot });
        }
        if (n.children) for (const ch of n.children) walk(ch, d+1);
        if (n.shadowRoot) walk(n.shadowRoot, d+1);
      };
      walk(document.body, 0);
      return JSON.stringify(out, null, 1);
    })()`));

    console.log('\n=== 5) 全局有没有可直接用的扩展 API（WebUI 私有）===');
    console.log(await c.ev(`JSON.stringify({ chromeKeys: Object.keys(window.chrome||{}), hasDeveloperPrivate: !!(window.chrome&&window.chrome.developerPrivate), hasMgmt: !!(window.chrome&&window.chrome.management) })`));

    console.log('\n=== 6) 直接问 chrome.developerPrivate 拿扩展信息（最权威）===');
    console.log(await c.ev(`(async () => {
      try {
        if (!(window.chrome && chrome.developerPrivate)) return 'no developerPrivate';
        const infos = await chrome.developerPrivate.getExtensionsInfo({includeDisabled:true, includeTerminated:true});
        const me = infos.find(e => e.id === '${EXT_ID}');
        if (!me) return 'Pluma not in list; ids=' + infos.map(e=>e.id).join(',');
        return JSON.stringify({ id: me.id, name: me.name, state: me.state, incognitoAccess: me.incognitoAccess, location: me.location, version: me.version }, null, 1);
      } catch (e) { return 'ERR ' + String(e); }
    })()`, true));
    c.close();
  } catch (e) { console.log('❌', e.message); console.log(e.stack); }
  finally { try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {} console.log('\n已关闭实验进程'); }
})();
