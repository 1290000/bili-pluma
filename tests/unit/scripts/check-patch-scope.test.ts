// @vitest-environment node

/**
 * `scripts/check-patch-scope.mjs` 的**判据自检**（2026-11-17）。
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
  // 候选过滤的授权字段名从这份实现派生（判据 ⑤ 读它）
  'src/core/cdn/filter.ts',
  'docs/decisions/0013-patch-player-info-response.md',
  'docs/decisions/0017-restore-primary-progress-in-playurl.md',
  'docs/decisions/0021-patch-pgc-preview-flags.md',
  'docs/decisions/0022-hide-pgc-preview-toast.md',
  'docs/decisions/0023-intercept-playview-durl-swap.md',
  // 候选过滤（ADR 0038）的授权来源
  'docs/decisions/0038-filter-pcdn-candidates.md',
  // ADR 0039：换 authority 的授权（脚本会检查它还在）
  'docs/decisions/0039-rewrite-pcdn-authority.md',
  // ADR 0041：PGC 回调接管（第 4 个候选过滤调用点 pgcFetch 的授权来源，脚本会检查它还在）
  'docs/decisions/0041-pgc-callback-takeover.md',
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

describe('check-patch-scope：PGC 换流与注入的写集判据（2026-11-17 补）', () => {
  it('★ 现状：绿，且两条新判据在输出里**看得见**', () => {
    const { status, out } = runIn(sandbox());

    expect(status).toBe(0);
    // 判据必须自己说出来，否则下一个人不知道它在守什么
    expect(out).toContain('✅ PGC 切集换流：pgcSwapPlayviewBody 写集 ⊆ ADR 0023 授权');
    expect(out).toContain('✅ PGC 整页注入：pgcPatchPlayinfo 只写 result.video_info');
    // 还没被守住的第五类也要明说（否则"全绿"会被读成"七行都守住了"）
    expect(out).toContain('✅ 候选过滤（ADR 0038）：写集 ⊆ 4 个候选字段');
    expect(out).toContain('✅ 候选改写（ADR 0039）：只换 authority、条数不变');
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

/**
 * 第七类：**候选过滤（ADR 0038）**的七条判据。
 *
 * ## 为什么这一组必须单独存在
 *
 * 前六类**一个字节都不许碰 URL**，这一类**只**动 URL —— 它的失败方向是新的：
 * 多删一条官方候选只在真出故障那天才被发现，而"写死一份域名表"的表现是
 * **开关开着却在走 PCDN**（静默失败，界面上一切正常）。所以每条判据都要
 * 证明"它真的会红"，而不是"它看起来在检查"。
 *
 * ## 三条最关键的反例（对应 ADR 0038 边界 2/3 与工程约束 6/7）
 *
 * | 变异 | 该红在哪 |
 * | --- | --- |
 * | 写集里多一个 `quality` | 边界 1/3：那不是"选线路"，是改画质档位 |
 * | 删掉 `pgcSwapPlayviewBody` 里的调用 | 约束 6：番剧切集整类漏过去 |
 * | 判据里写死 `mcdn` | 约束 7：两处真相源必然漂移 |
 */
describe('check-patch-scope：候选过滤（ADR 0038）的七条判据', () => {
  it('★ 现状：第七类的 ✅ 行在输出里，且写明"四处调用点全接 / 判据无写死域名"', () => {
    const { status, out } = runIn(sandbox());

    expect(status).toBe(0);
    expect(out).toContain('✅ 候选过滤（ADR 0038）：写集 ⊆ 4 个候选字段');
    expect(out).toContain('✅ 候选改写（ADR 0039）：只换 authority、条数不变');
    expect(out).toContain('四处调用点全接');
    expect(out).toContain('判据无写死域名');
  });

  it('⛔ 写集里多一个 `quality` → 红，并点名"那是改画质档位不是选线路"', () => {
    /**
     * 反例形状很真实：有人为了"顺手把画质档位改对"在过滤函数里写一行。
     * 前六类的判据**看不见它** —— 它们不查 `filterOneTrack`。
     */
    const dir = sandbox((src) =>
      src.replace(
        '      out.backup_url = rewritten.slice(1);',
        '      out.backup_url = rewritten.slice(1);\n      out.quality = 120;',
      ),
    );
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('filterOneTrack() 写了越权字段');
    expect(out).toContain('多写：quality');
    expect(out).toContain('写了 ADR 0038 明令禁止的字段：quality');
  });

  it('⛔ 删掉 `pgcSwapPlayviewBody` 里的过滤调用 → 红，并点名"番剧切集那条路"', () => {
    /**
     * 本类里**最容易漏**的一条（ADR 0038 背景 §二的核心事实）：
     * 只接一处的话普通视频能过滤、番剧切集照旧走 PCDN，而界面上一切正常。
     */
    const PLAYVIEW_CALL = [
      '          if (pcdnFilterReady()) {',
      '            var playviewFilterStats = filterDashOf(full);',
      '            if (playviewFilterStats.changed || playviewFilterStats.fallbackKept > 0) {',
      "              reportPcdnFilter(playviewFilterStats, 'playview');",
      '            }',
      '          }',
    ].join('\n');

    const dir = sandbox((src) => {
      if (!src.includes(PLAYVIEW_CALL)) {
        throw new Error('夹具失效：main-world.js 里找不到 playview 的过滤调用块（判据会假绿）');
      }
      return src.replace(PLAYVIEW_CALL, '          // 变异：整段删掉（"只接了两处"）');
    });
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('有取流点没接候选过滤');
    expect(out).toContain('PGC 切集换流（pgcSwapPlayviewBody 没接）');
  });

  it('⛔ 删掉 playurl 那一处的过滤闸门 → 红（"只接了两处"同样漏）', () => {
    /**
     * 三处里 playurl 是最容易被接上的那一处，所以它反而最该有一条反例：
     * 少了 `pcdnFilterReady()`，普通视频的响应体就不过滤 ——
     * 而**其它两处照旧工作**，测试看起来"功能正常"。
     */
    const dir = sandbox((src) => {
      if (!src.includes('    var wantFilter = pcdnFilterReady();')) {
        throw new Error('夹具失效：patchPlayurlXhrProgress 里找不到过滤闸门（判据会假绿）');
      }
      return src.replace('    var wantFilter = pcdnFilterReady();', '    var wantFilter = false;');
    });
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('有取流点没接候选过滤');
    expect(out).toContain('普通视频 playurl（patchPlayurlXhrProgress 没接）');
  });

  it('⛔ 删掉 `pgcPatchPlayinfo` 里的过滤调用 → 红（另一处也不能少）', () => {
    const PLAYINFO_CALL = [
      '    if (pcdnFilterReady()) {',
      '      var playinfoFilterStats = filterDashOf(next);',
      '      if (playinfoFilterStats.changed || playinfoFilterStats.fallbackKept > 0) {',
      "        reportPcdnFilter(playinfoFilterStats, 'playinfo');",
      '      }',
      '    }',
    ].join('\n');

    const dir = sandbox((src) => {
      if (!src.includes(PLAYINFO_CALL)) {
        throw new Error('夹具失效：main-world.js 里找不到 playinfo 的过滤调用块（判据会假绿）');
      }
      return src.replace(PLAYINFO_CALL, '    // 变异：整段删掉（"只接了两处"）');
    });
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('有取流点没接候选过滤');
    expect(out).toContain('PGC 整页注入（pgcPatchPlayinfo 没接）');
  });

  it('⛔ 判据里写死 `mcdn` → 红，并说清"两处真相源必然漂移"', () => {
    /**
     * 约束 7 是本类**唯一一条"今天绿、明天坏"的判据**：写死域名表的代码
     * 能跑、能过滤、看起来完全正常，只有在 `classify.ts` 加新域时才静默失效。
     */
    const dir = sandbox((src) => {
      if (!src.includes('    var rules = pcdnRules;')) {
        throw new Error('夹具失效：isPcdnUrl() 里找不到 `var rules = pcdnRules;`（判据会假绿）');
      }
      return src.replace(
        '    var rules = pcdnRules;',
        "    if (urlText.indexOf('mcdn') >= 0) return true;\n    var rules = pcdnRules;",
      );
    });
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('候选改写里写死了域名/标签字面量');
    expect(out).toContain('mcdn');
  });

  it('⛔ 造 URL 的痕迹（拼接 `https://`）→ 红（边界 2：不许新增候选）', () => {
    const dir = sandbox((src) =>
      src.replace(
        '      out.backup_url = rewritten.slice(1);',
        "      out.backup_url = rewritten.slice(1).concat('https://evil/' + rewritten[0]);",
      ),
    );
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('非授权的造 URL 痕迹');
  });

  it('⛔ 碰权益字段（`user_status`）→ 红（边界 4：不伪造任何权益）', () => {
    const dir = sandbox((src) =>
      src.replace(
        '    var rewritten = [];',
        '    if (typeof track.user_status === "object") return track; // 变异\n    var rewritten = [];',
      ),
    );
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('候选过滤碰了权益字段');
    expect(out).toContain('user_status');
  });

  it('⛔ 授权字段集不许手抄第二份：`filter.ts` 缺失 → 红（不是静默跳过）', () => {
    /**
     * 判据 ⑤ 的口径是"从 `filter.ts` **派生**"。派生失败的退化方向是
     * `authorizedFilterFields === null`，那时若宽容地跳过检查，
     * "写集里多一个 `duration`"就变得合法 —— 所以必须红。
     */
    const dir = sandbox();
    rmSync(join(dir, 'src/core/cdn/filter.ts'), { force: true });
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('解析不出 CandidateTrack 的四个候选字段');
  });

  it('判据自身不许退化成恒真：过滤函数改名 → 红（不是静默跳过）', () => {
    const dir = sandbox((src) => src.replace('function filterOneTrack(', 'function renamed('));
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('找不到候选过滤的实现函数');
    expect(out).toContain('filterOneTrack');
  });

  it('⛔ ADR 0039 升级后：`rewriteCandidateUrl()` 里写死镜像前缀 → 红（边界 6）', () => {
    /**
     * 镜像清单必须来自 `cfg`。写死 `upos-sz-` 这样的前缀同样是第二处真相源 ——
     * 域名漂移时主世界不会跟着变，表现为"开关开着仍走 PCDN / 换到过期镜像"。
     */
    const dir = sandbox((src) => {
      if (!src.includes('    var rules = pcdnRewriteRules;')) {
        throw new Error('夹具失效：rewriteCandidateUrl 里找不到规则读取（判据会假绿）');
      }
      return src.replace(
        '    var rules = pcdnRewriteRules;',
        "    if (urlText.indexOf('upos-sz-') >= 0) return urlText;\n    var rules = pcdnRewriteRules;",
      );
    });
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('候选改写里写死了域名/标签字面量');
    expect(out).toContain('upos-sz-');
  });

  it('⛔ proxy 模板白名单是**按函数**的：在 filterOneTrack 写 https:// 仍红', () => {
    const dir = sandbox((src) =>
      src.replace(
        '      out.backup_url = rewritten.slice(1);',
        "      out.backup_url = rewritten.slice(1).concat('https://');",
      ),
    );
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('非授权的造 URL 痕迹');
    expect(out).toContain('filterOneTrack');
  });

  it('判据自身不许退化：改写函数被改名 → 红（它的字面量就没人查了）', () => {
    const dir = sandbox((src) => src.replace('function rewriteCandidateUrl(', 'function renamed('));
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('找不到候选过滤的实现函数');
    expect(out).toContain('rewriteCandidateUrl');
  });

  it('⛔ 删掉 ADR 0039 → 红（换 authority 的授权不能只剩代码）', () => {
    const dir = sandbox();
    rmSync(join(dir, 'docs/decisions/0039-rewrite-pcdn-authority.md'), { force: true });
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('找不到 docs/decisions/0039-rewrite-pcdn-authority.md');
  });
});
