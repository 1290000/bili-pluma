/**
 * task-42 · RV（反向验证）。
 *
 * ## 铁律
 * - **禁** `git checkout` / `git stash` / `git reset`（项目里有人因此丢过 51 个文件）
 * - 改前文件复制备份，改后**逐字节还原 + SHA256 比对**
 * - 每步之后核 SHA 必须回到 `FROZEN`，回不去就停手报 Lead
 * - 开工前核一遍 SHA，**不是冻结值就拒绝跑**
 *
 * ## 用法
 * ```
 * node poc/probe/verify-task37-39/rv.mjs RV1
 * node poc/probe/verify-task37-39/rv.mjs RV2
 * node poc/probe/verify-task37-39/rv.mjs RV4
 * node poc/probe/verify-task37-39/rv.mjs RV4-old   // 对照：把"修 C 之前"的 .catch 链形态喂给测试
 * node poc/probe/verify-task37-39/rv.mjs clean
 * ```
 */
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = join(HERE, '..', '..', '..');
const BAK = join(HERE, '.rvbak');
const SRC = 'entrypoints/content-panel.content.ts';
const TEST = 'tests/unit/content/panel/orphan-guard.test.ts';
const FROZEN = 'F152B7B02C53562AC6925257982E6FF6616866C98EA45D96466ADF28A2267AB9';

const abs = (rel) => join(ROOT, rel);
const sha = (rel) => createHash('sha256').update(readFileSync(abs(rel))).digest('hex').toUpperCase();

function parentDirs(rels) {
  // 备份时保留相对路径，还原时用 copyFileSync 直接写回
  mkdirSync(BAK, { recursive: true });
  for (const r of rels) copyFileSync(abs(r), join(BAK, r.replace(/[\\/]/g, '__')));
}
function restore(rels) {
  for (const r of rels) copyFileSync(join(BAK, r.replace(/[\\/]/g, '__')), abs(r));
  const after = Object.fromEntries(rels.map((r) => [r, sha(r)]));
  for (const f of readdirSync(BAK)) unlinkSync(join(BAK, f));
  return { after, restoredTo: after[SRC] };
}
function mutate(rel, from, to) {
  const p = abs(rel);
  const src = readFileSync(p, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`变异锚点出现 ${n} 次（必须恰好 1 次）：${from.slice(0, 50)}`);
  writeFileSync(p, src.replace(from, to), 'utf8');
}
function runTests() {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', TEST, '--reporter=verbose'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
    code = e.status ?? 1;
  }
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \((\d+)\))?/.exec(out);
  const failed = m ? Number(m[1] ?? 0) : null;
  const passed = m ? Number(m[2]) : null;
  const redLines = out
    .split('\n')
    .filter((l) => /FAIL |AssertionError|expected |SyntaxError|→/.test(l))
    .map((l) => l.trim())
    .slice(0, 10);
  return { failed, passed, redLines, exit: code };
}
function gitStatus() {
  return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
}

const MUTANTS = {
  RV1: {
    label: 'orphan 判断整体恒 false',
    from: "const orphan = typeof chrome === 'undefined' || chrome.runtime?.id == null;",
    to: 'const orphan = false;',
  },
  RV2: {
    label: "`typeof chrome === 'undefined'` 那半恒 false",
    from: "const orphan = typeof chrome === 'undefined' || chrome.runtime?.id == null;",
    to: 'const orphan = false || chrome.runtime?.id == null;',
  },
  RV3: {
    label: '`chrome.runtime?.id == null` 那半恒 false',
    from: "const orphan = typeof chrome === 'undefined' || chrome.runtime?.id == null;",
    to: "const orphan = typeof chrome === 'undefined' || false;",
  },
};

/**
 * RV4：把 `try { await sendMessage } catch { showOrphanHint }` 改回**修 C 之前**的
 * 裸 `.catch()` 链 —— 同步抛发生在 `.catch()` 挂上之前，提示一次都不会出。
 */
function rv4Mutate() {
  const p = abs(SRC);
  const src = readFileSync(p, 'utf8');
  const from = `      try {
        res = (await chrome.runtime.sendMessage({ type: 'login/open' })) as LoginOpenReply | null;
      } catch (e) {`;
  const idx = src.indexOf(from);
  if (idx < 0) throw new Error('RV4 锚点找不到（源码形态变了？）');
  if (src.split(from).length - 1 !== 1) throw new Error('RV4 锚点不唯一');
  // 找到 catch 块结束
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
  if (catchEnd < 0) throw new Error('RV4 catch 块不配平');
  const replacement = `      res = (await chrome.runtime
        .sendMessage({ type: 'login/open' })
        .catch((e: unknown) => {
          if (isOrphanError(e)) showOrphanHint();
          return null;
        })) as LoginOpenReply | null;`;
  writeFileSync(p, src.slice(0, idx) + replacement + src.slice(catchEnd + 1), 'utf8');
  return replacement.includes('.catch(');
}

const which = process.argv[2];
if (which === 'clean') {
  const n = existsSync(BAK) ? readdirSync(BAK).length : 0;
  console.log('rvbak 残留 =', n);
  process.exit(0);
}

const startSha = sha(SRC);
console.log(`开工 SHA = ${startSha}`);
if (startSha !== FROZEN) {
  console.log(`🔴 与冻结基线 ${FROZEN} 不符 —— 拒绝跑 RV，报 Lead。`);
  process.exit(3);
}
const statusBefore = gitStatus();

let result = null;
if (which === 'RV4-old' || which === 'RV4' || which === 'RV1' || which === 'RV2' || which === 'RV3') {
  parentDirs([SRC]);
  try {
    if (which === 'RV4' || which === 'RV4-old') {
      rv4Mutate();
      console.log(`[${which}] try/catch → 裸 .catch() 链（修 C 之前）`);
    } else {
      const m = MUTANTS[which];
      mutate(SRC, m.from, m.to);
      console.log(`[${which}] ${m.label}`);
    }
    console.log(`   变异后 SHA = ${sha(SRC)}`);
    result = runTests();
    console.log(`   Tests: failed=${result.failed} passed=${result.passed} exit=${result.exit}`);
    for (const l of result.redLines) console.log('     ' + l);
  } catch (e) {
    console.log(`[${which}] 🔴 变异失败：${e.message}`);
  } finally {
    const r = restore([SRC]);
    const back = r.after[SRC] === FROZEN;
    console.log(`   还原 SHA = ${r.after[SRC]} → ${back ? '✅ 回到冻结基线' : '🔴 回不到基线，停手报 Lead'}`);
    const statusAfter = gitStatus();
    console.log(`   git status 前后一致 = ${statusBefore === statusAfter}`);
    if (!back) process.exit(4);
  }
} else {
  console.log('用法：RV1|RV2|RV3|RV4|RV4-old|clean');
  process.exit(2);
}
process.exit(result && result.failed > 0 ? 0 : 1);
