#!/usr/bin/env node
/**
 * Q2: 从 diag 并集里抽出每次 `true -> false` 翻转前后各 N 秒的全部记录。
 *
 * 为什么要这个脚本：`parseWindows` / `dump-all-diag.cjs` 只给并集全文，
 * 人工在里面找「翻转前一小时/后一小时到底发生了什么」极易漏行。
 * 这个脚本只做一件事：按翻转时刻切片，把切片原样打印，不做任何解释。
 *
 * 只读：只读 LevelDB 文件，不写浏览器状态。
 *
 * 用法：
 *   node poc/probe/logout-login-round2/flip-context.cjs
 *   node poc/probe/logout-login-round2/flip-context.cjs --window 120
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const EXT_ID = 'fgmggjhdbgaclcbeaopajghpnhgkmfnf';
const DIAG_KEY = 'pluma:diag';

function diagDir() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Microsoft', 'Edge', 'User Data', 'Default', 'Local Extension Settings', EXT_ID,
  );
}

/** 从一段字节缓冲里抠出所有「完整 JSON 数组」候选（key 后面跟的 value）。 */
function extractJsonArrays(buf) {
  const out = [];
  const needle = Buffer.from(DIAG_KEY, 'latin1');
  let idx = buf.indexOf(needle);
  while (idx !== -1) {
    // 从 key 之后开始找第一个 '['
    let i = idx + needle.length;
    while (i < buf.length && buf[i] !== 0x5b) i += 1; // '['
    if (i < buf.length) {
      const arr = scanBalancedArray(buf, i);
      if (arr) out.push(arr);
    }
    idx = buf.indexOf(needle, idx + needle.length);
  }
  return out;
}

/** 字符串感知的括号扫描：从 '[' 开始找到配对的 ']'。 */
function scanBalancedArray(buf, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < buf.length; i += 1) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true; // backslash
      else if (c === 0x22) inStr = false; // "
      continue;
    }
    if (c === 0x22) { inStr = true; continue; }
    if (c === 0x5b) depth += 1;
    else if (c === 0x5d) {
      depth -= 1;
      if (depth === 0) return buf.slice(start, i + 1).toString('utf8');
    }
  }
  return null;
}

function ts(raw) {
  // diag 里的 at 是 Date.now() 毫秒；格式化成本地时间
  const d = new Date(raw);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

function fmt(ms) {
  if (Math.abs(ms) < 1000) return `${ms}ms`;
  if (Math.abs(ms) < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

// ---- 主流程 ----
const winArg = process.argv.indexOf('--window');
const WINDOW_MS = winArg !== -1 ? Number(process.argv[winArg + 1]) * 1000 : 60_000;

const dir = diagDir();
if (!fs.existsSync(dir)) {
  console.error(`diag 目录不存在: ${dir}`);
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ldb') || f.endsWith('.log'));
console.log(`diag 目录: ${dir}`);
console.log(`扫描文件: ${files.join(', ')}`);
console.log('');

// 1) 收集所有快照数组里的条目并集
const seen = new Set();
const all = [];
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  for (const arrText of extractJsonArrays(buf)) {
    let parsed;
    try { parsed = JSON.parse(arrText); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const e of parsed) {
      if (!e || typeof e.at !== 'number') continue;
      const key = `${e.at}|${e.step}|${e.from}|${e.detail ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(e);
    }
  }
}
all.sort((a, b) => a.at - b.at);
console.log(`去重后条目总数: ${all.length}`);
if (all.length === 0) process.exit(0);
console.log(`时间范围: ${ts(all[0].at)} → ${ts(all[all.length - 1].at)}`);
console.log('');

// 2) 抽出所有 isAllowedIncognitoAccess 读数，找 true -> false
const reads = all.filter((e) => e.step === 'isAllowedIncognitoAccess');
console.log(`== isAllowedIncognitoAccess 全部读数（${reads.length} 条） ==`);
for (const r of reads) {
  console.log(`  ${ts(r.at)}  ${String(r.detail).padEnd(6)}  from=${r.from}`);
}
console.log('');

const flips = [];
for (let i = 1; i < reads.length; i += 1) {
  if (reads[i - 1].detail === 'true' && reads[i].detail === 'false') {
    flips.push({ from: reads[i - 1], to: reads[i], gap: reads[i].at - reads[i - 1].at });
  }
}
console.log(`== true -> false 翻转共 ${flips.length} 次 ==`);
flips.forEach((f, i) => {
  console.log(`  #${i + 1}  ${ts(f.from.at)} true  →  ${ts(f.to.at)} false   间隔 ${fmt(f.gap)}`);
});
console.log('');

// 3) 逐次打印前后 WINDOW_MS 的切片
flips.forEach((f, i) => {
  console.log('='.repeat(78));
  console.log(`#${i + 1}  翻转窗口  ${ts(f.to.at)}  (±${fmt(WINDOW_MS)})`);
  console.log('='.repeat(78));
  const lo = f.to.at - WINDOW_MS;
  const hi = f.to.at + WINDOW_MS;
  const slice = all.filter((e) => e.at >= lo && e.at <= hi);
  if (slice.length === 0) {
    console.log('  （窗口内无任何 diag 记录）');
  } else {
    for (const e of slice) {
      const rel = e.at - f.to.at;
      const relText = `${rel >= 0 ? '+' : ''}${(rel / 1000).toFixed(1)}s`.padStart(9);
      const detail = e.detail === undefined ? '' : `  | ${String(e.detail).slice(0, 160)}`;
      console.log(`  ${ts(e.at)}  ${relText}  [${e.step}] from=${e.from}${detail}`);
    }
  }
  console.log('');
});

// 4) 相关性统计：每次翻转前最后一次 login/open 是 assumed 还是别的
console.log('='.repeat(78));
console.log('相关性统计：翻转前 2 小时内最后一次 login/open');
console.log('='.repeat(78));
const LOGIN_WINDOW = 2 * 60 * 60 * 1000;
flips.forEach((f, i) => {
  const before = all.filter((e) => e.step === 'login/open' && e.at < f.to.at && e.at >= f.to.at - LOGIN_WINDOW);
  const last = before[before.length - 1];
  if (!last) {
    console.log(`  #${i + 1}  翻转前 2h 内无 login/open`);
    return;
  }
  const gap = f.to.at - last.at;
  console.log(`  #${i + 1}  最后一次 login/open = ${ts(last.at)}  间隔 ${fmt(gap)}  内容 ${String(last.detail).slice(0, 100)}`);
});
