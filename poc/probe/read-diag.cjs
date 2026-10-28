// 一次性诊断：从 Edge 的扩展 storage.local（LevelDB 明文）里读 Pluma 的诊断日志。
//
// 用途：真机验证时确认 content script 走了哪条分支（`page/quality` 的 note）。
// 只读，不写、不清理。
//
// ## 为什么直接扫 LevelDB 而不是走扩展 API
//
// options 页能显示这份日志，但 `bsk` 的沙箱禁止在 `chrome-extension://` 上执行
// 任何脚本（evaluate / screenshot 都拒）。而这个 LevelDB 是**明文**的
// （正是 ADR 0025 里"不加密没用"的依据），直接读最省事。
//
// ## 为什么按 UTF-8 解码后找 JSON 片段
//
// LevelDB 的 .ldb/.log 是跨条目的二进制拼接，按 \0 切会串行。
// 但这些条目的 value 本身是 UTF-8 JSON 数组，所以"解码后找 `"step":"` 开头的片段"
// 能稳定捞出**写进去过的每一条**（可能重复，用 Set 去重）。
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

const steps = new Set();

for (const f of fs.readdirSync(dir).filter((x) => /\.(ldb|log)$/.test(x))) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  /**
   * 诊断条目的实际形状（LevelDB 里 `at` 会存成科学计数法，别用 `\d+`）：
   * ```
   * {"at":1.793181921689e+12,"detail":"[PGC] …","from":"dvavdz","step":"page/quality"}
   * ```
   * 只捞 `[PGC]` 开头的 detail —— 真机验证关心的就是这几条分支走向。
   */
  const re = /\{"at":[0-9.e+]+,"detail":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const detail = raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\"/g, '"');
    steps.add(detail);
  }
}

const list = [...steps];
console.log('共', list.length, '条去重后的 note：');
for (const l of list) console.log(' -', l);
