// Read-only: test whether the Service Worker restarts (new INSTANCE_ID) correlate
// with the user toggling the InPrivate permission, or with something else.
//
// Approach: for every consecutive pair of login-chain entries, report the gap in
// seconds and whether `from` changed. If toggling the permission reloaded the
// extension, the INSTANCE_ID would change exactly across a true->false flip that
// the user caused by editing the extension details page.
const fs = require('node:fs');
const path = require('node:path');

const dir =
  process.env.LOCALAPPDATA +
  '/Microsoft/Edge/User Data/Default/Local Extension Settings/fgmggjhdbgaclcbeaopajghpnhgkmfnf';

const key = 'pluma:diag';
const seen = new Set();
const union = [];

for (const f of fs.readdirSync(dir).filter((x) => /\.(ldb|log)$/.test(x))) {
  const buf = fs.readFileSync(path.join(dir, f));
  const s = buf.toString('utf8');
  let idx = 0;
  while ((idx = s.indexOf(key, idx)) !== -1) {
    const tail = s.slice(idx, idx + 200000);
    const start = tail.indexOf('[{');
    if (start === -1) {
      idx += key.length;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < tail.length; i++) {
      const ch = tail[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) {
      try {
        for (const e of JSON.parse(tail.slice(start, end + 1))) {
          const k = e.at + '|' + e.step + '|' + (e.detail || '') + '|' + (e.from || '');
          if (seen.has(k)) continue;
          seen.add(k);
          union.push(e);
        }
      } catch {
        /* torn */
      }
    }
    idx += key.length;
  }
}

union.sort((a, b) => Number(a.at) - Number(b.at));
const fmt = (at) =>
  new Date(Number(at)).toLocaleString('zh-CN', { hour12: false });

// Focus on the two "user toggled the switch" episodes we know about:
//   14:25:13 ok -> 14:25:34 disabled   (21 s)
//   14:41:46 ok -> 14:42:04 disabled   (18 s)
// and the long-gap episodes for contrast.
const chain = union.filter((e) =>
  /login\/open|isAllowedIncognitoAccess|windows\.create|说明页|create 返回/.test(e.step),
);

console.log('=== consecutive login-chain entries: gap + instance change ===');
console.log('');
let prev = null;
for (const e of chain) {
  const gap = prev ? (Number(e.at) - Number(prev.at)) / 1000 : NaN;
  const changed = prev && prev.from !== e.from ? '  <<< INSTANCE CHANGED' : '';
  const g = Number.isFinite(gap) ? gap.toFixed(1) + 's' : '-';
  console.log(
    fmt(e.at).padEnd(22) +
      g.padStart(8) +
      '  from=' +
      String(e.from || '?').padEnd(8) +
      e.step +
      (e.detail ? ' | ' + String(e.detail).slice(0, 60) : '') +
      changed,
  );
  prev = e;
}

console.log('');
console.log('=== 关键判断 ===');
console.log('若 INSTANCE_CHANGED 恰好出现在 true -> false 的翻转处，则');
console.log('  说明【权限变更同时伴随 SW 重启】—— 但注意先后顺序：');
console.log('  若先有 from 变化再有 false，重启可能是原因；');
console.log('  若 false 与 from 变化同一次调用内发生，则无法区分。');
