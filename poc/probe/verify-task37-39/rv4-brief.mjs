/**
 * RV4 对照：把**修 C 之前**的裸 `.catch()` 链版本喂给测试，确认红的是「同步抛」那条。
 * 与 rv.mjs RV4 同一变异，只是输出更短、便于贴给 Lead。
 *
 * 用法：node poc/probe/verify-task37-39/rv4-brief.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = join(HERE, '..', '..', '..');
const SRC = 'entrypoints/content-panel.content.ts';
const BAK = join(HERE, '.rvbak-rv4');
const FROZEN = 'F152B7B02C53562AC6925257982E6FF6616866C98EA45D96466ADF28A2267AB9';
const abs = (r) => join(ROOT, r);
const sha = () => createHash('sha256').update(readFileSync(abs(SRC))).digest('hex').toUpperCase();

if (sha() !== FROZEN) {
  console.log('🔴 开工 SHA 不是冻结基线，拒绝跑');
  process.exit(3);
}

mkdirSync(BAK, { recursive: true });
const bak = join(BAK, 'cp.ts');
copyFileSync(abs(SRC), bak);

let restoredChecksum = null;
try {
  const src = readFileSync(abs(SRC), 'utf8');
  const from = `      try {
        res = (await chrome.runtime.sendMessage({ type: 'login/open' })) as LoginOpenReply | null;
      } catch (e) {`;
  if (src.split(from).length - 1 !== 1) throw new Error('锚点不唯一');
  const catchOpen = src.indexOf('{', src.indexOf('} catch (e)'));
  let depth = 0;
  let catchEnd = -1;
  for (let i = catchOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        catchEnd = i;
        break;
      }
    }
  }
  const replacement = `      res = (await chrome.runtime
        .sendMessage({ type: 'login/open' })
        .catch((e: unknown) => {
          if (isOrphanError(e)) showOrphanHint();
          return null;
        })) as LoginOpenReply | null;`;
  writeFileSync(abs(SRC), src.slice(0, catchOpen - 4 < 0 ? 0 : src.indexOf(from)) + replacement + src.slice(catchEnd + 1), 'utf8');
  console.log('变异后 SHA =', sha());
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', 'tests/unit/content/panel/orphan-guard.test.ts', '--reporter=verbose'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(out);
  console.log('结果 =', m ? m[0] : '未解析');
  for (const l of out.split('\n')) {
    if (/×/.test(l) || /→ /.test(l)) console.log('  ' + l.trim());
  }
} finally {
  copyFileSync(bak, abs(SRC));
  unlinkSync(bak);
  restoredChecksum = sha();
  console.log('还原 SHA =', restoredChecksum, restoredChecksum === FROZEN ? '✅ 回到冻结基线' : '🔴 不符合');
}
