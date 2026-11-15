#!/usr/bin/env node
/**
 * Q4 受控实验（方案 B）：用自带 incognito 声明的探测扩展，绕开「必须点 UI」的限制。
 *
 * 背景：
 *   方案 A（直接改 Secure Preferences 的 incognito 字段）已作废 ——
 *   Edge 有 preference MAC 校验，手改会被判为篡改并整条删掉字段（实测见实验日志 e2）。
 *   真 UI（edge://extensions 里的开关）无法自动化（bsk 拒绝 edge:// 页面）。
 *
 * 方案 B：
 *   我们自己生成一个**探测扩展**，manifest 里直接写 `"incognito": "spanning"`。
 *   这样扩展一装上就带 InPrivate 权限，不需要用户点任何开关。
 *   然后在这个扩展的 background SW 里调 `chrome.extension.isAllowedIncognitoAccess()`，
 *   就能观测权限值随时间/窗口开关的变化。
 *
 *   ⚠️ 关键限制（必须写进报告）：
 *   这与「用户手动打开 Pluma 的开关」不是完全同一条代码路径。
 *   它的结论只能证明「Edge 是否会在开/关 InPrivate 窗口时撤销 spanning 扩展的权限」，
 *   不能直接等同于「手动开的权限会不会被撤销」。
 *
 * 只读用户浏览器：全程独立 --user-data-dir，不碰 User Data。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const WORK = path.join(__dirname, 'raw', 'repro6');
const EXT_DIR = path.join(WORK, 'probe-ext');
const PROFILE = path.join(WORK, 'p-probe');
const LOG = path.join(WORK, 'experiment-b-log.txt');
const RESULT = path.join(WORK, 'experiment-b-result.json');

fs.mkdirSync(WORK, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, `${line}\n`, 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 生成本地探测扩展：manifest 直接声明 incognito:spanning */
function buildProbeExtension() {
  fs.rmSync(EXT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EXT_DIR, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 3,
        name: 'Pluma Q4 Probe',
        version: '0.0.1',
        // 关键：自带 InPrivate 权限，不依赖用户点开关
        incognito: 'spanning',
        permissions: ['storage'],
        background: { service_worker: 'sw.js' },
      },
      null,
      2,
    ),
    'utf8',
  );
  // SW：把每次 isAllowedIncognitoAccess() 的读数写进 storage，
  // 同时响应一条消息便于外部查询（外部用 CDP 读也没问题，这里用 storage 落盘更简单）。
  fs.writeFileSync(
    path.join(EXT_DIR, 'sw.js'),
    `
      const KEY = 'probe:reads';
      async function record(tag) {
        let v = null;
        try { v = await chrome.extension.isAllowedIncognitoAccess(); } catch (e) { v = 'ERR:' + e.message; }
        const { [KEY]: prev = [] } = await chrome.storage.local.get(KEY);
        prev.push({ at: Date.now(), tag, value: v });
        await chrome.storage.local.set({ [KEY]: prev.slice(-200) });
        return v;
      }
      // 启动时读一次，并每 2 秒读一次，持续 10 分钟
      record('startup');
      let n = 0;
      const timer = setInterval(async () => {
        n += 1;
        await record('tick' + n);
        if (n >= 300) clearInterval(timer);
      }, 2000);
      chrome.runtime.onMessage.addListener(() => { record('onMessage'); return false; });
    `,
    'utf8',
  );
  log(`已生成探测扩展: ${EXT_DIR}  (incognito: "spanning")`);
}

function launch(extraArgs = []) {
  const args = [
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience',
    `--load-extension=${EXT_DIR}`,
    ...extraArgs,
    'about:blank',
  ];
  log(`启动: ${EDGE} ${args.join(' ')}`);
  const p = spawn(EDGE, args, { stdio: 'ignore' });
  log(`  pid=${p.pid}`);
  return p;
}

function readProbeReads() {
  // 探测扩展把读数写在 storage.local 的 leveldb 里。
  // 直接扫它的 Local Extension Settings 目录，找 probe:reads 的 JSON。
  const dir = path.join(PROFILE, 'Default', 'Local Extension Settings');
  if (!fs.existsSync(dir)) return { ok: false, reason: 'no-ext-settings-dir' };
  const out = [];
  for (const extId of fs.readdirSync(dir)) {
    const d = path.join(dir, extId);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      const fp = path.join(d, f);
      let buf;
      try { buf = fs.readFileSync(fp); } catch { continue; }
      const txt = buf.toString('latin1');
      const key = 'probe:reads';
      let idx = txt.indexOf(key);
      while (idx !== -1) {
        const arrStart = txt.indexOf('[', idx);
        if (arrStart !== -1) {
          // 粗略取到匹配的 ]
          let depth = 0; let end = -1;
          for (let i = arrStart; i < txt.length; i += 1) {
            const c = txt[i];
            if (c === '[') depth += 1;
            else if (c === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
          }
          if (end !== -1) {
            try {
              const arr = JSON.parse(txt.slice(arrStart, end + 1));
              if (Array.isArray(arr) && arr.length && arr[0].tag) out.push({ extId, arr });
            } catch { /* ignore */ }
          }
        }
        idx = txt.indexOf(key, idx + key.length);
      }
    }
  }
  if (!out.length) return { ok: false, reason: 'no-reads-found' };
  // 取最长的那份
  out.sort((a, b) => b.arr.length - a.arr.length);
  return { ok: true, extId: out[0].extId, reads: out[0].arr };
}

(async () => {
  log('=== Q4 方案B：自带 incognito:spanning 的探测扩展 ===');
  fs.rmSync(LOG, { force: true });
  log('用户主浏览器与本实验完全隔离（独立 --user-data-dir）');

  fs.rmSync(PROFILE, { recursive: true, force: true });
  buildProbeExtension();

  const main = launch();
  log('等待扩展启动并开始轮询…');
  await sleep(15000);

  const r0 = readProbeReads();
  log(`首次读数检查: ok=${r0.ok} ${r0.ok ? `extId=${r0.extId} count=${r0.reads.length}` : `reason=${r0.reason}`}`);
  if (!r0.ok) {
    log('⚠️ 读不到探测扩展的 storage —— 方案B 也失败，Q4 将如实标记未完成。');
    killTree(main.pid);
    return;
  }

  const vals = [...new Set(r0.reads.map((x) => String(x.value)))];
  log(`静置期读数去重: ${vals.join(', ')}`);

  // ---- E2: 开 incognito 窗口然后关掉 ----
  log('');
  log('--- E2: 开 incognito 窗口 → 关掉 → 看读数有没有变 false ---');
  const beforeE2 = readProbeReads();
  const beforeVals = [...new Set(beforeE2.reads.map((x) => String(x.value)))];
  log(`  开窗前: ${beforeVals.join(', ')}`);

  const inc = spawn(EDGE, [`--user-data-dir=${PROFILE}`, '--incognito', 'about:blank'], { stdio: 'ignore' });
  log(`  incognito 窗口 pid=${inc.pid}，等 20 秒让探测扩展轮询`);
  await sleep(20000);

  const duringE2 = readProbeReads();
  log(`  开窗期间读数: ${[...new Set(duringE2.reads.map((x) => String(x.value)))].join(', ')}`);

  log('  关闭 incognito 窗口');
  killTree(inc.pid);
  await sleep(15000);

  const afterE2 = readProbeReads();
  const afterVals = [...new Set(afterE2.reads.map((x) => String(x.value)))];
  log(`  关窗后读数: ${afterVals.join(', ')}`);

  const dropped = afterVals.includes('false');
  log(`  => E2 结论: ${dropped ? '权限掉了' : '权限没掉'}`);

  // ---- E3: 开 incognito 窗口不关 ----
  log('');
  log('--- E3: 开 incognito 窗口 → 不关 → 观察 60 秒 ---');
  const inc2 = spawn(EDGE, [`--user-data-dir=${PROFILE}`, '--incognito', 'about:blank'], { stdio: 'ignore' });
  log(`  incognito 窗口 pid=${inc2.pid}`);
  await sleep(60000);
  const duringE3 = readProbeReads();
  const e3vals = [...new Set(duringE3.reads.map((x) => String(x.value)))];
  log(`  开窗 60 秒后读数: ${e3vals.join(', ')}`);
  log(`  => E3 结论: ${e3vals.includes('false') ? '权限掉了' : '权限没掉'}`);
  killTree(inc2.pid);

  killTree(main.pid);
  await sleep(1500);

  // 最后从磁盘再读一次（Edge 退出后 Secure Preferences 才是最终态）
  const spFile = path.join(PROFILE, 'Default', 'Secure Preferences');
  let finalPref = null;
  if (fs.existsSync(spFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(spFile, 'utf8'));
      for (const [id, s] of Object.entries(j.extensions.settings)) {
        if (s.path && String(s.path).includes('probe-ext')) finalPref = { id, incognito: s.incognito };
      }
    } catch { /* ignore */ }
  }
  log(`最终 Secure Preferences 里探测扩展: ${JSON.stringify(finalPref)}`);

  const result = {
    method: 'B: manifest incognito:spanning',
    sitValues: vals,
    e2: { before: beforeVals, after: afterVals, dropped },
    e3: { after60s: e3vals, dropped: e3vals.includes('false') },
    finalPref,
    note:
      'incognito:spanning 是 manifest 声明，不是用户点 UI 开的开关。' +
      '结论只能说明 Edge 对 spanning 扩展的态度，不能直接等同于手动开关的权限。',
  };
  fs.writeFileSync(RESULT, JSON.stringify(result, null, 2), 'utf8');
  log(`结果写入 ${RESULT}`);
  log('=== 结束 ===');
})();

function killTree(pid) {
  if (!pid) return;
  log(`  关闭自己的实例 pid=${pid}`);
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
}
