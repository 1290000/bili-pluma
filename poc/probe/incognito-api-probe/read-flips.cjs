/**
 * 只读取证：把 diag LevelDB 里所有 isAllowedIncognitoAccess 记录按时间排序，
 * 输出「值 + 时间 + 实例 id」，用来判断权限值是否真的在翻转。
 *
 * 只读：以 FileShare.ReadWrite 打开（Edge 正锁着这个文件），不写入、不修改。
 *
 * 用法：node poc/probe/incognito-api-probe/read-flips.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const LOG = process.argv[2] ||
  'C:\\Users\\i1290\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Local Extension Settings\\fgmggjhdbgaclcbeaopajghpnhgkmfnf\\000061.log';

function readShared(file) {
  const fd = fs.openSync(file, 'r');
  const chunks = [];
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } finally {
    fs.closeSync(fd);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const raw = readShared(LOG);

// 每条 diag 记录形如 {"at":1.79e+12,"detail":"...","from":"xxxxx","step":"..."}
// LevelDB 里记录可能被切片，用宽松正则只抓同时含 step 与 at 的片段。
const re = /\{"at":(\d+(?:\.\d+)?(?:e\+\d+)?)[^{}]*?"from":"([a-z0-9]+)"[^{}]*?"step":"([^"]+)"\}/gi;
const rows = [];
let m;
while ((m = re.exec(raw)) !== null) {
  rows.push({ at: Number(m[1]), from: m[2], step: m[3], text: m[0] });
}

// 只保留权限读取
const perm = rows
  .filter((r) => r.step === 'isAllowedIncognitoAccess')
  .map((r) => {
    const dm = /"detail":"([^"]*)"/.exec(r.text);
    return { at: r.at, from: r.from, value: dm ? dm[1] : '?' };
  })
  .sort((a, b) => a.at - b.at);

console.log(`[total diag records parsed] ${rows.length}`);
console.log(`[isAllowedIncognitoAccess reads] ${perm.length}`);

// 去重：同一时间戳 + 同一实例只留一条
const seen = new Set();
const uniq = perm.filter((p) => {
  const k = `${p.at}|${p.from}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

console.log(`[unique reads] ${uniq.length}`);
console.log('--- last 40 reads (time / value / instance) ---');
for (const p of uniq.slice(-40)) {
  const t = new Date(p.at).toISOString().replace('T', ' ').slice(0, 23);
  console.log(`${t}  ${p.value.padEnd(6)}  from=${p.from}`);
}

// 翻转统计：按时间序列看连续值变化
let flips = 0;
for (let i = 1; i < uniq.length; i += 1) {
  if (uniq[i].value !== uniq[i - 1].value) flips += 1;
}
console.log(`--- flips (value changes in time order) = ${flips} ---`);

const trueCount = uniq.filter((p) => p.value === 'true').length;
const falseCount = uniq.filter((p) => p.value === 'false').length;
console.log(`[true]=${trueCount} [false]=${falseCount}`);

// 实例分布
const byInstance = new Map();
for (const p of uniq) {
  if (!byInstance.has(p.from)) byInstance.set(p.from, []);
  byInstance.get(p.from).push(p.value);
}
console.log(`[instances that read this API] ${byInstance.size}`);
