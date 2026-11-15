// 只读/只写本脚本参数指定的那个文件；用于 verifier 的反向验证。
// 用法:
//   node poc/probe/verify-report-2026-11-12/tools/mut.mjs apply <file> <oldFile> <newFile>
//   node poc/probe/verify-report-2026-11-12/tools/mut.mjs restore <file> <bakFile>
//
// 设计要点（踩过的坑）：
//   1. 必须用 Buffer 读写 + UTF-8，**不许**用 PowerShell 的 Get-Content/Set-Content
//      —— 中文会被按 ANSI 重编码，文件直接损坏（本脚本作者实测踩过）。
//   2. 只做**字面量**替换，old 必须**恰好出现一次**，否则拒绝执行。
//   3. 每次都打印替换前后的 SHA256，便于 verifier 在报告里留证。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

function sha(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

const [mode, file, a, b] = process.argv.slice(2);
if (!mode || !file) {
  console.error('usage: mut.mjs <apply|restore> <file> <oldFile|bak> [newFile]');
  process.exit(2);
}

if (mode === 'apply') {
  const oldText = readFileSync(a, 'utf8');
  const newText = readFileSync(b, 'utf8');
  const before = sha(file);
  const src = readFileSync(file, 'utf8');
  const hits = src.split(oldText).length - 1;
  if (hits !== 1) {
    console.error(`REFUSED: old snippet occurs ${hits} times in ${file} (need exactly 1)`);
    process.exit(3);
  }
  copyFileSync(file, `${file}.verabak`);
  writeFileSync(file, src.replace(oldText, () => newText), 'utf8');
  console.log(`applied  ${file}`);
  console.log(`  sha_before = ${before}`);
  console.log(`  sha_after  = ${sha(file)}`);
} else if (mode === 'restore') {
  const bak = `${file}.verabak`;
  if (!existsSync(bak)) {
    console.error(`missing backup ${bak}`);
    process.exit(4);
  }
  const want = sha(bak);
  copyFileSync(bak, file);
  const got = sha(file);
  if (want !== got) {
    console.error(`RESTORE MISMATCH want=${want} got=${got}`);
    process.exit(5);
  }
  console.log(`restored ${file}`);
  console.log(`  sha_restored = ${got}  (== backup, verified)`);
} else {
  console.error('unknown mode');
  process.exit(2);
}
