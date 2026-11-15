/**
 * 读 Pluma 诊断日志（Lead 自用，只读）。
 *
 * 三个坑（前人踩过，别再踩）：
 * 1. LevelDB 的 .log 被 Edge 独占打开 —— 必须带 FileShare.ReadWrite。
 * 2. `pluma:diag` 是 30 条环形缓冲，单个快照必丢历史 —— 必须把目录下所有
 *    .log/.ldb 的条目取并集去重。
 * 3. 条目里层是**双重转义 JSON**（`{\"at\":…}`），且 `at` 会被 JSON.stringify
 *    写成科学计数法 `1.794489412773e+12` —— 不能假设整数。
 *
 * 用法：node poc/probe/tail-diag.cjs [条数]
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR =
  'C:/Users/i1290/AppData/Local/Microsoft/Edge/User Data/Default/Local Extension Settings/fgmggjhdbgaclcbeaopajghpnhgkmfnf';

const LIMIT = Number(process.argv[2] ?? 20);

/** 从字符串里把所有「花括号配平」的 JSON 对象抓出来（处理转义/嵌套） */
function extractObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/** 递归剥双层转义，收集所有像 diag 记录的对象 */
function harvest(node, acc) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) harvest(x, acc);
    return;
  }
  if (typeof node.at === 'number' && (node.step !== undefined || node.detail !== undefined)) {
    acc.push(node);
  }
  for (const v of Object.values(node)) harvest(v, acc);
}

function parseChunk(raw) {
  const acc = [];
  // 一层：直接 JSON.parse 每个花括号块
  for (const chunk of extractObjects(raw)) {
    let cur = chunk;
    for (let depth = 0; depth < 3; depth += 1) {
      try {
        harvest(JSON.parse(cur), acc);
        break;
      } catch {
        // 里层是转义过的字符串：先反解一层再试
        cur = cur.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
  }
  return acc;
}

function readAll() {
  const acc = [];
  for (const name of fs.readdirSync(DIR)) {
    if (!/\.(log|ldb)$/.test(name)) continue;
    const file = path.join(DIR, name);
    let raw;
    try {
      const fd = fs.openSync(file, 'r');
      const stat = fs.fstatSync(fd);
      const buf = Buffer.alloc(stat.size);
      fs.readSync(fd, buf, 0, stat.size, 0);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
    } catch {
      continue;
    }
    acc.push(...parseChunk(raw));
  }
  return acc;
}

const rows = readAll();
const uniq = new Map();
for (const r of rows) {
  const ms = r.at < 1e12 ? r.at * 1000 : r.at;
  const key = `${ms}|${r.step ?? ''}|${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`;
  uniq.set(key, { ms, step: r.step, detail: r.detail, from: r.from, live: r.live });
}
const sorted = [...uniq.values()].sort((a, b) => a.ms - b.ms);

console.log(`TOTAL ${sorted.length}`);
for (const r of sorted.slice(-LIMIT)) {
  const t = new Date(r.ms + 8 * 3600e3).toISOString().slice(11, 23);
  const d = typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail);
  console.log(`${t}  ${r.step}  ${d}${r.from ? `  (from=${r.from})` : ''}`);
}
