/**
 * 读扫码窗口心跳键 `pluma:login-window-alive` 的**全部历史值**（只读，不改任何状态）。
 *
 * 目的（task-45 ①）：证明「跨分区心跳到底有没有写进去」——
 *  - 键从来没出现过 ⇒ 扫码窗里的 `main.tsx` 心跳代码没跑
 *  - 出现过但当前读不到 ⇒ 写过但跨分区/被覆盖/过期
 *
 * 三个坑与 `poc/probe/tail-diag.cjs` 相同（LevelDB 共享读 / 双重转义 JSON /
 * `at` 可能被写成科学计数法），另外本脚本**还要抓 storage.local 的键索引**
 * （LevelDB 里键名本身也会以 `META:` / 分隔块出现），所以不能用 tail-diag 的
 * 「只收 diag 记录」过滤，改为按子串定位。
 *
 * 用法：node poc/probe/heartbeat-check/read-heartbeat.cjs [profileDir]
 *   profileDir 默认是用户日常 Edge 的 Default（与 tail-diag.cjs 一致）
 */
const fs = require('node:fs');
const path = require('node:path');

const KEY = 'pluma:login-window-alive';

const DIR =
  process.argv[2] ??
  'C:/Users/i1290/AppData/Local/Microsoft/Edge/User Data/Default/Local Extension Settings/fgmggjhdbgaclcbeaopajghpnhgkmfnf';

/** 从字符串里把所有「花括号配平」的 JSON 块抓出来（处理转义/嵌套） */
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

/** 收集所有「像心跳」的对象：必须带 at 数字，且 instance 或键名相关 */
function harvest(node, acc) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) harvest(x, acc);
    return;
  }
  // 心跳对象 = { at:number, instance:string }；`at` 也可能被写成科学计数法时仍是 number
  if (typeof node.at === 'number' && typeof node.instance === 'string') {
    acc.push(node);
  }
  for (const v of Object.values(node)) harvest(v, acc);
}

/** 把 leveldb 的原始字节按「可打印片段」切出来，找 KEY 出现的每一处上下文 */
function contextsOf(raw, needle) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = raw.indexOf(needle, from);
    if (i < 0) break;
    out.push(raw.slice(Math.max(0, i - 160), Math.min(raw.length, i + 320)));
    from = i + needle.length;
  }
  return out;
}

function readAll() {
  const files = fs.readdirSync(DIR).filter((n) => /\.(log|ldb)$/.test(n));
  const rows = [];
  const hits = [];
  for (const name of files) {
    const file = path.join(DIR, name);
    let raw;
    try {
      const fd = fs.openSync(file, 'r');
      const stat = fs.fstatSync(fd);
      const buf = Buffer.alloc(stat.size);
      fs.readSync(fd, buf, 0, stat.size, 0);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
    } catch (e) {
      console.log(`SKIP ${name}  ${e.message}`);
      continue;
    }
    if (raw.includes(KEY)) {
      for (const ctx of contextsOf(raw, KEY)) hits.push({ file: name, ctx });
    }
    const acc = [];
    for (const chunk of extractObjects(raw)) {
      let cur = chunk;
      for (let depth = 0; depth < 3; depth += 1) {
        try {
          harvest(JSON.parse(cur), acc);
          break;
        } catch {
          cur = cur.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
      }
    }
    for (const r of acc) rows.push({ file: name, row: r });
  }
  return { files, rows, hits };
}

const { files, rows, hits } = readAll();

console.log(`DIR   ${DIR}`);
console.log(`FILES ${files.length}  [${files.join(', ')}]`);
console.log('');
console.log(`=== A. 键名 "${KEY}" 在 leveldb 原始字节里出现 ${hits.length} 处 ===`);
if (hits.length === 0) {
  console.log('NONE —— 该键名从未在 storage 文件里出现过');
} else {
  const seen = new Set();
  for (const h of hits) {
    const shown = h.ctx.replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '·');
    if (seen.has(shown)) continue;
    seen.add(shown);
    console.log(`[${h.file}] …${shown}…`);
  }
}

console.log('');
console.log(`=== B. 可解析的心跳对象（带 at + instance）共 ${rows.length} 条 ===`);
const uniq = new Map();
for (const { row } of rows) {
  const k = `${row.at}|${row.instance}`;
  uniq.set(k, row);
}
const sorted = [...uniq.values()].sort((a, b) => a.at - b.at);
if (sorted.length === 0) {
  console.log('NONE —— 没有任何可解析的心跳对象');
}
for (const r of sorted) {
  const iso = new Date(r.at).toISOString();
  const ageS = ((Date.now() - r.at) / 1000).toFixed(1);
  console.log(`at=${r.at} (${iso}, age=${ageS}s) instance=${r.instance}`);
}

console.log('');
console.log('=== C. 当前时刻 ===');
console.log(`now=${Date.now()}  TTL(hint)=90s`);
