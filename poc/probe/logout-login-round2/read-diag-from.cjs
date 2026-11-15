// Read-only: dump diag entries with the `from` instance id, to detect
// split-instance overwrite (see src/platform/storage/diag-store.ts:10-19).
const fs = require('node:fs');
const path = require('node:path');

const dir =
  process.env.LOCALAPPDATA +
  '/Microsoft/Edge/User Data/Default/Local Extension Settings/fgmggjhdbgaclcbeaopajghpnhgkmfnf';

// LevelDB stores keys/values with arbitrary bytes; read as latin1 so byte<->char
// is 1:1 and the ASCII JSON we look for stays aligned.
const RE =
  /\{"at":([0-9.e+-]+),"detail":"((?:[^"\\]|\\.)*)","from":"((?:[^"\\]|\\.)*)","step":"((?:[^"\\]|\\.)*)"\}/g;

const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => /\.(ldb|log)$/.test(x))) {
  const s = fs.readFileSync(path.join(dir, f), 'latin1');
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(s)) !== null) {
    rows.push({ at: Number(m[1]), detail: m[2], from: m[3], step: m[4] });
  }
}

const seen = new Set();
const uniq = [];
for (const r of rows) {
  const k = r.at + '|' + r.step + '|' + r.detail + '|' + r.from;
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(r);
}
uniq.sort((a, b) => a.at - b.at);

const lo = process.argv[2]
  ? new Date(process.argv[2]).getTime()
  : new Date('2026-11-12T05:20:00+08:00').getTime();

console.log('total raw=' + rows.length + ' unique=' + uniq.length);
console.log('distinct from = ' + [...new Set(uniq.map((r) => r.from))].join(', '));
console.log('--- entries after ' + new Date(lo).toLocaleString('zh-CN', { hour12: false }) + ' ---');
for (const r of uniq) {
  if (r.at < lo) continue;
  const t = new Date(r.at).toLocaleString('zh-CN', { hour12: false });
  console.log(t + '  [from=' + r.from + ']  [' + r.step + ']  ' + r.detail.slice(0, 110));
}
