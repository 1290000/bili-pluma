/**
 * 只读：解码 Edge 会话文件，统计 `{}` 里出现过的 URL，找出
 * `chrome-extension://<Pluma>/login-window.html` 有没有被记录成
 * 一个"已提交的导航"，以及有没有 `ERR_BLOCKED` 相关痕迹。
 *
 * ## 已知坑（踩过，写在这里省下一次）
 * - 会话文件被 Edge 独占，必须 `FileShare.ReadWrite` 打开
 * - 文件可能是 0 字节（Edge 正在滚动写新的那个）
 * - URL 是 **UTF-16LE**，不是 UTF-8
 * - 只做字符串统计，不尝试解释二进制结构（那是猜测，不是证据）
 *
 * 用法：node decode-sessions.cjs [最多看几个文件]
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR = 'C:/Users/i1290/AppData/Local/Microsoft/Edge/User Data/Default/Sessions';
const LIMIT = Number(process.argv[2] || 6);

function readShared(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function stats(buf, label) {
  if (buf.length === 0) {
    console.log(`  ${label}: EMPTY FILE`);
    return;
  }
  const u16 = buf.toString('utf16le');
  const u8 = buf.toString('latin1');
  const needles = [
    'login-window',
    'need-incognito',
    'ERR_BLOCKED',
    'about:blank',
    'edge://newtab',
    'fgmggjhdbgaclcbeaopajghpnhgkmfnf',
  ];
  const out = needles.map((n) => {
    const c16 = u16.split(n).length - 1;
    const c8 = u8.split(n).length - 1;
    return `${n}=u16:${c16}/u8:${c8}`;
  });
  console.log(`  ${label}: len=${buf.length}  ${out.join('  ')}`);

  // 把所有 UTF-16 的 http/https/chrome-extension 串掏出来看看
  const urls = new Set();
  const re = /(?:https?|chrome-extension):\/\/[\x20-\x7e]{4,200}/g;
  let m;
  while ((m = re.exec(u16)) !== null) urls.add(m[0]);
  const interesting = [...urls].filter((u) => /login-window|need-incognito|extension:/i.test(u));
  if (interesting.length) {
    console.log('    extension/login URLs found:');
    for (const u of interesting.slice(0, 15)) console.log('      ' + u);
  }
}

function main() {
  const files = fs
    .readdirSync(DIR)
    .filter((n) => /^(Tabs|Session)_\d+$/.test(n))
    .map((n) => {
      const full = path.join(DIR, n);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      return { n, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, LIMIT);

  for (const f of files) {
    const when = new Date(f.mtime).toISOString();
    console.log(`\n${f.n}  mtime=${when}`);
    let buf;
    try {
      buf = readShared(f.full);
    } catch (e) {
      console.log('  READ FAILED: ' + e.message);
      continue;
    }
    stats(buf, 'content');
  }
}

main();
