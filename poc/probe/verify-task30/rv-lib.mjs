/**
 * task-31 RV 框架（verifier 自用，只读产品代码，不改产品代码的"意图"）。
 *
 * 三条纪律（本轮写进卡里的）：
 *   1. 变异前先断言**变异点出现次数 === 1**，不是 1 次直接抛 ——
 *      防止"变异错了地方，却在别处巧合变红"。
 *   2. "真红"必须同时满足：有用例失败 + 失败原因带预期断言措辞。
 *      只看"有失败"会把语法错 / `no tests` 当成红（task-23 踩过）。
 *   3. 还原走**备份文件复制 + SHA256 逐字节核对**。
 *      禁用 `git stash` / `checkout` / `reset`（项目里有人因此丢过 51 个文件的改动）。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const ROOT = resolve(HERE, '../../..');
const BAK = join(HERE, '.rvbak');

export function sha(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex').toUpperCase();
}

export function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** 备份（每次变异前都要重新调 —— 并发窗口内 restore 会覆盖别人在途改动） */
export function backup(rels) {
  mkdirSync(BAK, { recursive: true });
  const snap = {};
  for (const rel of rels) {
    const name = rel.replace(/[\\/]/g, '__');
    copyFileSync(join(ROOT, rel), join(BAK, name));
    snap[rel] = sha(join(ROOT, rel));
  }
  return snap;
}

export function restore(rels) {
  const out = {};
  for (const rel of rels) {
    const name = rel.replace(/[\\/]/g, '__');
    copyFileSync(join(BAK, name), join(ROOT, rel));
    out[rel] = sha(join(ROOT, rel));
  }
  return out;
}

export function bakCount() {
  if (!existsSync(BAK)) return 0;
  return readdirSync(BAK).filter((f) => !f.startsWith('.')).length;
}

export function cleanBak() {
  if (existsSync(BAK)) rmSync(BAK, { recursive: true, force: true });
}

const EX = '已把服务端登录态退掉了，不会再自动恢复。';

/**
 * 单点变异：`from` 在文件里必须**恰好出现 1 次**，否则抛（不跑测试）。
 */
export function mutate(rel, from, to) {
  const src = read(rel);
  const n = src.split(from).length - 1;
  if (n !== 1) {
    throw new Error(`变异点出现 ${String(n)} 次（要求恰好 1 次）：${rel} :: ${from.slice(0, 80)}`);
  }
  writeFileSync(join(ROOT, rel), src.replace(from, to), 'utf8');
  return { rel, occurrences: n };
}

/** 追加 / 删除（用于"插一行"类变异） */
export function appendAt(rel, anchor, insert) {
  const src = read(rel);
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error(`锚点出现 ${String(n)} 次（要求恰好 1 次）：${rel}`);
  writeFileSync(join(ROOT, rel), src.replace(anchor, anchor + insert), 'utf8');
  return { rel, occurrences: n };
}

/**
 * 跑 vitest。返回 { failed, passed, raw, failures: [{ name, msg }] }
 *
 * ⚠️ 本机没有 `npx`；必须 `node node_modules/vitest/vitest.mjs run`。
 * ⚠️ Vite 的 CJS 弃用警告会打到 stderr 并让退出码变 1 —— 那是噪声，
 *    以 stdout 的 `Tests N failed | M passed` 为准（下面对这个做了显式区分）。
 */
export function runTests(files) {
  let raw = '';
  try {
    raw = execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    raw = `${String(e.stdout ?? '')}\n${String(e.stderr ?? '')}`;
  }
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \((\d+)\))?/.exec(raw);
  const failed = m?.[1] ? Number(m[1]) : 0;
  const passed = m?.[2] ? Number(m[2]) : 0;
  const failures = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*×|^\s*✗|FAIL /.test(line)) {
      const name = line.replace(/^\s*[×✗]\s*/, '').trim();
      let msg = '';
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
        const cand = (lines[j] ?? '').trim();
        if (cand.startsWith('→') || cand.startsWith('AssertionError') || cand.includes('expected')) {
          msg = cand;
          break;
        }
      }
      failures.push({ name, msg });
    }
  }
  const noTests = /No test files found|no tests/i.test(raw);
  return { failed, passed, raw, failures, noTests };
}

/**
 * 判定"真红"。
 * @param {string} label
 * @param {{failed:number,passed:number,noTests:boolean,failures:{name:string,msg:string}[]}} r
 * @param {{expectWord?:RegExp, expectTest?:RegExp}} want
 */
export function isReallyRed(r, want = {}) {
  const reasons = [];
  if (r.noTests) reasons.push('noTests');
  if (r.failed === 0) reasons.push('零失败');
  if (r.passed === 0 && r.failed > 0) reasons.push('有失败但零通过(可能是整文件语法错)');
  if (want.expectWord) {
    const hit = r.failures.some((f) => want.expectWord.test(f.msg) || want.expectWord.test(f.name));
    if (!hit) reasons.push(`失败消息里没有预期措辞 ${String(want.expectWord)}`);
  }
  if (want.expectTest) {
    const hit = r.failures.some((f) => want.expectTest.test(f.name));
    if (!hit) reasons.push(`预期用例名 ${String(want.expectTest)} 没有出现在失败列表`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function writeJson(name, obj) {
  writeFileSync(join(HERE, name), JSON.stringify(obj, null, 2), 'utf8');
}

export function writeText(name, text) {
  writeFileSync(join(HERE, name), text, 'utf8');
}

/** `git status --porcelain` 行数（只读） */
export function statusCount() {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).length;
}

export { HERE };
