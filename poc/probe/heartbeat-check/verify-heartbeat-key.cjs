/**
 * 抖音式「键到底写没写」判定器（只读）。
 *
 * 判据（三条同时成立才算「写过」）：
 *   1. 键名在 storage 文件里出现 ≥ 1 次（原始字节，UTF-8 与 UTF-16LE 两种编码都查）
 *   2. 其中 ≥ 1 次后面紧跟一个 JSON 值（`pluma:xxx{...}`），说明是**写入**而不是
 *      仅出现在键索引 / MANIFEST
 *   3. 该 JSON 里的时间戳落在本次取证时间窗内
 *
 * 对照组（必须同时满足，否则脚本本身不可信）：
 *   - 一个**确定写过**的键（`pluma:build-proof3`，SW 每次启动都写）
 *   - 一个**确定没写过**的键（随便编一个）
 *
 * 用法：node poc/probe/heartbeat-check/verify-heartbeat-key.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR =
  'C:/Users/i1290/AppData/Local/Microsoft/Edge/User Data/Default/Local Extension Settings/fgmggjhdbgaclcbeaopajghpnhgkmfnf';

function readShared(file) {
  const fd = fs.openSync(file, 'r');
  const st = fs.fstatSync(fd);
  const buf = Buffer.alloc(st.size);
  fs.readSync(fd, buf, 0, st.size, 0);
  fs.closeSync(fd);
  return buf;
}

const files = fs.readdirSync(DIR).filter((n) => /\.(log|ldb)$/.test(n));
const bufs = files.map((n) => ({ name: n, buf: readShared(path.join(DIR, n)) }));

function countKey(key) {
  let nameHits = 0;
  let valueHits = 0;
  const times = [];
  for (const { buf } of bufs) {
    for (const enc of ['utf8', 'utf16le']) {
      const kb = Buffer.from(key, enc);
      let i = -1;
      while ((i = buf.indexOf(kb, i + 1)) >= 0) {
        nameHits += 1;
        // 紧跟一个 '{' ⇒ 键后面直接是 JSON 值（leveldb 写入形态）。
        // 注意 `login-ready` 的值前面**可能夹一个字节 0x7b 的 noise**，所以要往后
        // 扫几个字节：真的写入形态是 `key{`，键索引/LRU 形态是 `key` + 控制字节。
        if (enc === 'utf8') {
          const after = buf[i + kb.length];
          if (after === 0x7b) {
            valueHits += 1;
            const tail = buf.slice(i + kb.length + 1, i + kb.length + 40).toString('utf8');
            const m = /^"at":([0-9.e+]+)/.exec(tail);
            if (m) times.push(Number(m[1]));
          }
        }
      }
    }
  }
  return { nameHits, valueHits, times };
}

const KEYS = {
  target: 'pluma:login-window-alive',
  controlWritten: 'pluma:build-proof3',
  // 第二个对照组：`pluma:login-ready` 是**另一个分区**（无痕实例）写的键。
  // 它在本文件里出现过 ⇒ 证明「本文件确实记录跨实例的 storage 写入」；
  // 若 target 为 0 而它非 0，「从没写过」就有了对照组支撑。
  controlCrossPartition: 'pluma:login-ready',
  controlNever: 'pluma:__definitely-not-a-real-key__',
};

console.log(`DIR: ${DIR}`);
console.log(`FILES: ${bufs.map((b) => `${b.name}(${b.buf.length}B)`).join(', ')}`);
console.log('');

/**
 * 把「值里带的时刻」抽出来 —— `at` / `swStartedAt` 两种形态。
 * `at` 会被 JSON.stringify 写成科学计数法（`1.794740498248e+12`），不能当整数读。
 */
function valueTimeRange(key) {
  let min = Infinity;
  let max = -Infinity;
  for (const { buf } of bufs) {
    const s = buf.toString('utf8');
    const kb = `${key}{`;
    let i = -1;
    while ((i = s.indexOf(kb, i + 1)) >= 0) {
      const tail = s.slice(i + kb.length, i + kb.length + 80);
      const m = /"(?:at|swStartedAt)":([0-9.e+]+)/.exec(tail);
      if (!m) continue;
      const t = Number(m[1]);
      if (!Number.isFinite(t) || t < 1.7e12 || t > 1.9e12) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  return Number.isFinite(min) ? { min, max } : null;
}

let exitCode = 0;
for (const [role, key] of Object.entries(KEYS)) {
  const r = countKey(key);
  const range = valueTimeRange(key);
  const first = range ? new Date(range.min).toISOString() : '-';
  const last = range ? new Date(range.max).toISOString() : '-';
  console.log(
    `${role.padEnd(22)} ${key.padEnd(30)} nameHits=${String(r.nameHits).padStart(5)} ` +
      `valueHits=${String(r.valueHits).padStart(5)} range=${first} .. ${last}`,
  );
  if (role === 'controlWritten' && r.valueHits === 0) {
    console.log('  ❌ 对照组失败：确定写过的键读不到值 ⇒ 本脚本的判据不可信');
    exitCode = 2;
  }
  if (role === 'controlNever' && r.nameHits !== 0) {
    console.log('  ❌ 对照组失败：编造的键居然命中 ⇒ 本脚本有假阳性');
    exitCode = 2;
  }
}

console.log('');
const target = countKey(KEYS.target);
if (target.valueHits > 0) {
  console.log('判定：写过（键名带 JSON 值出现）');
} else if (target.nameHits > 0) {
  console.log('判定：只出现在键索引/MANIFEST 里，**从未被写入过值**');
} else {
  console.log('判定：从没被写过（storage 里连键名都不存在）');
}
process.exit(exitCode);
