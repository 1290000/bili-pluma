#!/usr/bin/env node
/**
 * 只读取证：确认「用户最后一份诊断导出（19:44:23）」之后，Pluma 的 diag 里还有没有新记录。
 *
 * 前置事实（实测，别改）：
 *   1. LevelDB .log 里字符串是**双重转义的 JSON**（`{"at":1.7944e+12,...}` 被当普通字符串再序列化一次），
 *      所以直接 grep `"at":1794...` 命中 0 —— 必须按 JSON.parse 逐层剥。
 *   2. `at` 值被 JSON.stringify 写成**科学计数法** `1.794427985345e+12`，不是整数。
 *   3. `pluma:diag` 是 30 条环形缓冲，**单次快照必丢历史**；.log 是 append-only，
 *      所以把整份 .log 里所有快照的所有记录抓出来做并集 = 历史全量。
 *
 * 本脚本只读（fs.openSync 'r'），不写不删用户任何文件。
 */
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR =
  process.argv[2] ||
  'C:\\Users\\i1290\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Local Extension Settings\\fgmggjhdbgaclcbeaopajghpnhgkmfnf';

const TZ = 8 * 3600 * 1000;
function fmt(ms) {
  const d = new Date(ms + TZ);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

function readAll(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = fs.readSync(fd, buf, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 递归剥：任何字符串值，若它自身解析出来是数组/对象且含 `step`，就继续往里走。
 */
function harvest(value, out, depth = 0) {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) harvest(v, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    const step = value.step;
    const at = value.at ?? value.ts ?? value.time;
    if (typeof step === 'string' && at != null && Number.isFinite(Number(at))) {
      out.push({
        at: Math.round(Number(at)),
        from: String(value.from ?? value.instanceId ?? '?'),
        step,
        detail: String(value.detail ?? ''),
      });
      // 单条记录自己也可能是被转义的，不再往下钻
      return;
    }
    for (const k of Object.keys(value)) harvest(value[k], out, depth + 1);
    return;
  }
  if (typeof value !== 'string') return;
  const t = value.trim();
  if (t.length < 2) return;
  if (!(t.startsWith('{') || t.startsWith('['))) return;
  let parsed;
  try {
    parsed = JSON.parse(t);
  } catch {
    return;
  }
  harvest(parsed, out, depth + 1);
}

const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log') || f.endsWith('.ldb'));
const uniq = new Map();

for (const name of files) {
  const full = path.join(LOG_DIR, name);
  const u8 = readAll(full);
  const u16 = (() => {
    const fd = fs.openSync(full, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const n = fs.readSync(fd, buf, read, size - read, read);
        if (n <= 0) break;
        read += n;
      }
      return buf.subarray(0, read).toString('utf16le');
    } finally {
      fs.closeSync(fd);
    }
  })();

  const found = [];
  for (const text of [u8, u16]) {
    // LevelDB 记录里会混着 \x00 \x01 之类的块头，按这些不可打印字节切段再逐段 parse
    const chunks = text.split(/[\x00-\x08\x0b\x0c\x0e-\x1f]+/);
    for (const ch of chunks) {
      const t = ch.trim();
      if (t.length < 4) continue;
      let parsed;
      try {
        parsed = JSON.parse(t);
      } catch {
        continue;
      }
      harvest(parsed, found);
    }
    // 兜底：整段直接试一次（有些块没被切碎）
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        harvest(JSON.parse(t), found);
      } catch {
        /* ignore */
      }
    }
  }

  console.log(`[${name}] 抓出记录 ${found.length} 条`);
  for (const r of found) {
    const key = `${r.at}|${r.from}|${r.step}|${r.detail}`;
    if (!uniq.has(key)) uniq.set(key, r);
  }
}

const all = [...uniq.values()].sort((a, b) => a.at - b.at);
console.log(`\n并集去重后 ${all.length} 条`);

const EXPORT_AT = Date.UTC(2026, 10, 12, 11, 44, 23, 686); // 用户最后一份导出的 exportedAt
console.log(`分界线（用户最后一份导出 exportedAt） = ${fmt(EXPORT_AT)}`);

const before = all.filter((r) => r.at <= EXPORT_AT);
const after = all.filter((r) => r.at > EXPORT_AT);
console.log(`导出之前 ${before.length} 条 / 导出之后 ${after.length} 条`);

if (before.length) {
  const last = before[before.length - 1];
  console.log(`导出前最后一条: [${fmt(last.at)}] ${last.step} | ${last.detail.slice(0, 180)}`);
}

console.log('\n=== 导出之后（19:44:23 之后）的全部记录 ===');
if (!after.length) console.log('（无 —— 一条都没有）');
for (const r of after) console.log(`[${fmt(r.at)}] ${r.step.padEnd(30)} | ${r.detail.slice(0, 240)}`);

console.log('\n=== 全历史 need-incognito 相关 ===');
const ni = all.filter((r) => /need-incognito|incognito-disabled|权限未开启/.test(r.step + r.detail));
if (!ni.length) console.log('（无）');
for (const r of ni) console.log(`[${fmt(r.at)}] ${r.step} | ${r.detail.slice(0, 200)}`);

console.log('\n=== 最后 25 条（看存储写到哪） ===');
for (const r of all.slice(-25)) console.log(`[${fmt(r.at)}] ${r.step.padEnd(30)} | ${r.detail.slice(0, 170)}`);

console.log('\n=== 文件 mtime ===');
for (const name of files) {
  const s = fs.statSync(path.join(LOG_DIR, name));
  console.log(`${name.padEnd(14)} ${String(s.size).padStart(9)} B  ${fmt(s.mtimeMs)}`);
}
