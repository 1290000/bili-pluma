// 只读：从 Edge 扩展的 storage.local（LevelDB 明文）里捞出全部诊断条目。
//
// 与 poc/probe/read-diag.cjs 的区别：那个只捞 `[PGC]` 前缀的 detail，
// 这里要的是 login 链路（`login/open` / `windows.create returned` /
// `isAllowedIncognitoAccess` / `focus-existing`），所以不按前缀过滤。
//
// 只读：open/read 打开，不写、不 lock、不清理。
const fs = require('node:fs');
const path = require('node:path');

const EXT_ID = process.env.PLUMA_EXT_ID ?? 'fgmggjhdbgaclcbeaopajghpnhgkmfnf';
const dir = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Microsoft/Edge/User Data/Default/Local Extension Settings',
  EXT_ID,
);

if (!fs.existsSync(dir)) {
  console.log('NO-DIR', dir);
  process.exit(0);
}

/**
 * 诊断条目的形状（LevelDB 里 `at` 是科学计数法，`step` 在 `detail` 之后）：
 * `{"at":1.793181921689e+12,"detail":"...","from":"...","step":"login/open"}`
 * 用 `step` 做锚，把 `at`/`detail`/`step` 一起捞出来。
 */
const RE =
  /\{"at":([0-9.e+-]+),"detail":"((?:[^"\\]|\\.)*)","from":"((?:[^"\\]|\\.)*)","step":"((?:[^"\\]|\\.)*)"\}/g;

function unesc(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\"/g, '"');
}

const rows = [];
const files = fs.readdirSync(dir).filter((x) => /\.(ldb|log)$/.test(x));
for (const f of files) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  let m;
  while ((m = RE.exec(s)) !== null) {
    rows.push({
      at: Number(m[1]),
      detail: unesc(m[2]),
      from: unesc(m[3]),
      step: unesc(m[4]),
      file: f,
    });
  }
}

// 去重：同一 (at, step, detail) 可能在 .log 与 .ldb 里各出现一次
const seen = new Set();
const uniq = [];
for (const r of rows) {
  const k = `${r.at}|${r.step}|${r.detail}`;
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(r);
}
uniq.sort((a, b) => a.at - b.at);

console.log(`目录: ${dir}`);
console.log(`扫描文件: ${files.join(', ')}`);
console.log(`原始条目: ${rows.length}，去重后: ${uniq.length}`);
console.log('');
for (const r of uniq) {
  const t = new Date(r.at);
  const ts = Number.isNaN(t.getTime()) ? String(r.at) : t.toLocaleString('zh-CN', { hour12: false });
  console.log(`${ts}\t[${r.step}]\t${r.detail}`);
}
