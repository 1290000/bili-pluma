#!/usr/bin/env node
/** 只读：看 Pluma diag LevelDB .log 的原始形态（字段名、编码、记录分隔） */
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR =
  process.argv[2] ||
  'C:\\Users\\i1290\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Local Extension Settings\\fgmggjhdbgaclcbeaopajghpnhgkmfnf';

const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log') || f.endsWith('.ldb'));

for (const name of files) {
  const full = path.join(LOG_DIR, name);
  const fd = fs.openSync(full, 'r');
  let buf;
  try {
    const size = fs.fstatSync(fd).size;
    buf = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = fs.readSync(fd, buf, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    buf = buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }

  console.log(`\n########## ${name} (${buf.length} B) ##########`);
  const u8 = buf.toString('utf8');
  const u16 = buf.toString('utf16le');
  console.log(`utf8 len=${u8.length}  utf16le len=${u16.length}`);
  for (const kw of ['pluma:diag', 'step', '"at"', 'login/open', 'need-incognito', 'panel/page-state', 'isAllowedIncognitoAccess']) {
    const c8 = u8.split(kw).length - 1;
    const c16 = u16.split(kw).length - 1;
    console.log(`  ${kw.padEnd(28)} utf8=${c8}  utf16=${c16}`);
  }

  const i = u8.indexOf('login/open');
  if (i >= 0) {
    console.log(`\n  --- utf8 中 'login/open' @${i} 前后 700 字符 ---`);
    console.log(JSON.stringify(u8.slice(Math.max(0, i - 700), i + 300)));
  }
  const j = u16.indexOf('login/open');
  if (j >= 0) {
    console.log(`\n  --- utf16 中 'login/open' @${j} 前后 400 字符 ---`);
    console.log(JSON.stringify(u16.slice(Math.max(0, j - 400), j + 200)));
  }
}
