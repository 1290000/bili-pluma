// @vitest-environment node

/**
 * `scripts/check-patch-scope.mjs` 的**判据自检**（2026-11-20）。
 *
 * ## 为什么这个文件必须存在
 *
 * 本轮给那个脚本补了第六、七行改写（`pgcSwapPlayviewBody` 换流 / `pgcPatchPlayinfo`
 * 注入）。补之前它只守前四行 —— 也就是说"机器拦住了越权"这句话**当时是假的**：
 * 往 `data` 上多写一个键，脚本一句话都不说。
 *
 * 现在它开始守了。但"开始守"和"一直在守"是两件事：
 * 判据本身会退化（正则写歪、函数改名、有人把 `AUTHORIZED_*` 放宽），而**退化的表现是静默**——
 * 脚本照样打 ✅。所以把"它真的会红"变成断言。
 *
 * ## 做法：整仓快照搬到临时目录，跑**真脚本**
 *
 * 脚本的根是 `process.cwd()`，所以 `cwd` 指向一个沙盒目录即可：
 * 把 `main-world.js` / `routes.ts` / 五份 ADR 复制进去，**按需改一行**，
 * 然后 `node <脚本绝对路径>`。这样测的是真正的 CLI 行为（退出码 + 输出原文），
 * 不是把逻辑抄一份到测试里（抄一份的测试只能证明抄得像）。
 *
 * ⚠️ 沙盒用完即删（`afterEach`）。测试**不碰**仓库里的 `src/**`。
 *
 * ## 四个用例对应四件事
 *
 * | 用例 | 守的是 |
 * | --- | --- |
 * | 现状绿 + 两条新 ✅ 行 + ADR 0038 的 ⚠️ 行 | 判据在输出里**可见**（下一个人知道它守了什么） |
 * | 往 `data` 多写一个键 | 换流的**越权写**会红并点名 |
 * | 往 `result` 多写一个同级键 | 注入的**同级键**会红并点名 |
 * | 删掉一处 `vi.type` 同步（两处都删） | **少同步**也会红（ADR 0023 说它会灰屏/锁 720P） |
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const SCRIPT = join(REPO, 'scripts/check-patch-scope.mjs');

/** 沙盒里需要的那几个文件（脚本会读它们） */
const NEEDED = [
  'src/content/main-world.js',
  'src/shared/constants/routes.ts',
  'docs/decisions/0013-patch-player-info-response.md',
  'docs/decisions/0017-restore-primary-progress-in-playurl.md',
  'docs/decisions/0021-patch-pgc-preview-flags.md',
  'docs/decisions/0022-hide-pgc-preview-toast.md',
  'docs/decisions/0023-intercept-playview-durl-swap.md',
];

let box = '';

afterEach(() => {
  if (box !== '') rmSync(box, { recursive: true, force: true });
  box = '';
});

/**
 * 建沙盒。
 *
 * @param mutate 对 `main-world.js` 文本的改动（返回新文本）
 */
function sandbox(mutate: (src: string) => string = (s) => s): string {
  box = mkdtempSync(join(tmpdir(), 'pluma-scope-'));
  for (const rel of NEEDED) {
    const dst = join(box, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(REPO, rel), dst);
  }
  const mw = join(box, 'src/content/main-world.js');
  writeFileSync(mw, mutate(readFileSync(mw, 'utf8')), 'utf8');
  return box;
}

interface RunResult {
  status: number;
  out: string;
}

/** 在沙盒里跑真脚本（`cwd` = 沙盒，所以脚本的 ROOT 就是沙盒） */
function runIn(dir: string): RunResult {
  try {
    const out = execFileSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('check-patch-scope：PGC 换流与注入的写集判据（2026-11-20 补）', () => {
  it('★ 现状：绿，且两条新判据在输出里**看得见**', () => {
    const { status, out } = runIn(sandbox());

    expect(status).toBe(0);
    // 判据必须自己说出来，否则下一个人不知道它在守什么
    expect(out).toContain('✅ PGC 切集换流：pgcSwapPlayviewBody 写集 ⊆ ADR 0023 授权');
    expect(out).toContain('✅ PGC 整页注入：pgcPatchPlayinfo 只写 result.video_info');
    // 还没被守住的第五类也要明说（否则"全绿"会被读成"七行都守住了"）
    expect(out).toContain('候选过滤（ADR 0038）**尚未纳入校验**');
  });

  it('⛔ 换流函数往 `data` 上多写一个键 → 红，并点名那个键', () => {
    /**
     * 反例（补丁前的真实状态）：这条写入在旧脚本下**完全静默** ——
     * 它只校验前四行，`pgcSwapPlayviewBody` 根本不在校验集里。
     */
    const dir = sandbox((src) =>
      src.replace(
        '          vi.is_preview = 0;',
        '          vi.is_preview = 0;\n          data.user_status = { vip: 1 };',
      ),
    );
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('pgcSwapPlayviewBody() 写了 ADR 0023 未授权的字段');
    expect(out).toContain('多写 data 上的：user_status');
  });

  it('⛔ 注入函数碰了 `result` 的同级键 → 红，并点名那个键', () => {
    const dir = sandbox((src) =>
      src.replace(
        '    r.video_info = next;',
        '    r.video_info = next;\n    r.user_status = { vip: 1 };',
      ),
    );
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('pgcPatchPlayinfo() 写的 result 键与 ADR 0020 授权不一致');
    expect(out).toContain('多写同级键：user_status');
  });

  it('⛔ 少同步 ADR 0023 点名的字段（`type`）→ 红，并说清后果', () => {
    /**
     * `type` 在两种响应里**连类型都不同**（`"DASH"` vs `3`），不同步等于把
     * dash 管道整条关掉 —— 所以"少写"和"多写"一样是缺陷，必须也有判据。
     */
    const dir = sandbox((src) =>
      src.split('if (full.type !== undefined) vi.type = full.type;').join(''),
    );
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('少同步了 ADR 0023 / ADR 0021 点名的字段');
    expect(out).toContain('少写 data.video_info 上的：type');
  });

  it('判据自身不许退化成恒真：删掉函数 → 红（不是静默跳过）', () => {
    /**
     * 反例：把 `extractFunctionBody()` 改成"找不到就返回空串"，写集恒为空，
     * 于是"越权"永远查不出来 —— 而 ✅ 照打。这条把那种退化堵死。
     */
    const dir = sandbox((src) => src.replace('function pgcSwapPlayviewBody(', 'function renamed('));
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('找不到 `function pgcSwapPlayviewBody(...)`');
  });
});
