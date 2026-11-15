/**
 * 走查：判据 5 的"红"到底来自几处？
 *
 * 现象：`diagnosticsPane()` 在 `data.logsMeta` 缺失时会抛，且**两处**都直接解引用：
 * - `src/content/panel/diagnostics.ts:341` `if (!data.logsMeta.ok) {`
 * - `src/content/panel/diagnostics.ts:357` `if (data.logsMeta.err !== null) {`
 *
 * 只补第一处时，探针仍红，但抛错点后移到 `reading 'err'`（probe-seq1.txt）；
 * 两处都补时才变绿（probe-seq2.txt）。这证明：
 * 1. vitest 确实读到了新代码（不是缓存假红）；
 * 2. 判据 5 的红是真实的，且需要**两处**一起修才算修完。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { step1, step2 } from './seq-steps.mjs';

const TARGET = 'src/content/panel/diagnostics.ts';
const BAK = 'poc/probe/verify-task26/.rv-manual/diagnostics.ts';
const sha = () => createHash('sha256').update(readFileSync(TARGET)).digest('hex').toUpperCase();

function probe() {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'poc/probe/verify-task26/vitest.probe.config.ts'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
  const verified = /\[VERIFIER\] stage=(caught:[^\n]+|called)/.exec(out)?.[1] ?? 'n/a';
  const summary = /Tests\s+(\d+ passed[^\n]*)/.exec(out)?.[1] ?? 'n/a';
  return { verified, summary };
}

mkdirSync('poc/probe/verify-task26/.rv-manual', { recursive: true });
copyFileSync(TARGET, BAK);
const original = sha();

try {
  step1();
  console.log('SEQ1（只补 .ok）      ', JSON.stringify(probe()));
  step2();
  console.log('SEQ1+2（两处都补）    ', JSON.stringify(probe()));
} finally {
  copyFileSync(BAK, TARGET);
  rmSync('poc/probe/verify-task26/.rv-manual', { recursive: true, force: true });
}
console.log('restored', sha(), sha() === original ? 'OK' : 'MISMATCH');
