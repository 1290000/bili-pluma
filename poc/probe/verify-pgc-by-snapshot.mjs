// 真机验证：用 `bsk snapshot` 读播放器状态。
//
// ## 这个脚本的由来（一段失败的升级尝试）
//
// 2026-10-30 曾把 bsk 升到 0.4.0 验证，结果发现它的协作上下文模型
// （`cooperate sync` 给单次 `context_id`，`evaluate` 与所有 browser mutations 都要它）
// 在 **B站这种持续更新的页面**上根本用不了：
//
//   error: shared action failed
//   details: The action's observed content changed; synchronize and replan
//
// 实测连续 10 轮重试全部失败；同法在 example.com（静态页）一次通过 —— 方法对、是页面问题。
// **最终回退到 0.3.3**（详见 docs/guides/browser-skill-setup.md §1 与 §4a）。
//
// 但那次折腾留下一个有价值的副产品：**播放器状态本来就渲染在 DOM 文本里**，
// 用 `snapshot` 读比 `evaluate` 拿 `window.__PLUMA_PGC__` 更稳、更贴近用户可见事实。
//
// ## 为什么仍然用 snapshot 而不是 evaluate
//
// 1. 0.3.3 的 `evaluate` 虽然可用，但 `snapshot` 是 **passive read**：
//    不执行脚本、没有副作用、也不受将来版本协作上下文的约束（见上面那段教训）。
// 2. 判据是**用户能看见的东西**（进度条上的总时长），而不是内部变量 —— 更有说服力。
// 3. `snapshot` 在 0.3.3 和 0.4.0 都存在，脚本**跨版本可用**。
//
// ## 判据
//
// Pluma 的作用是让主账号（非会员，1080P 上限）能播完整集。
//   - 试看流 ≈ 360 秒（6 分钟）；完整集 = 片长（本样本 24:01）
//   - 所以「总时长 >> 360 秒」就是注入生效的证据
//
// ## ⚠️ 2026-10-30 重要更正：这个脚本**可能给出假阳性**
//
// 实测（1.0.1 冒烟）：
//   snapshot 读到「进度 00:16 / 24:01」→ 脚本判「✅ 播的是完整集」
//   但同一时刻 `document.querySelector('video').duration === 360.109`  ← 实际是试看
//
// 原因：B站的**进度条 UI 显示的是整集片长**（页面元数据），**不是播放器实际能播的长度**。
// 扩展没接管时两者就会劈开 —— 而本脚本只看得到 UI 文本。
//
// **正确判据是 `video.duration`**（播放器真实时长），不是 UI 总时长。
// 本脚本保留是因为它在"快速看一眼"时仍有用（能区分明显未注入），
// 但**不得单凭它的 ✅ 就判定冒烟通过** —— 必须再用 `evaluate` 读 `video.duration` 复核。
//
// 复核片段（bsk 0.3.3，`--tab-id` 是选项、表达式是位置参数）：
//
//   (() => { const v = document.querySelector('video');
//            return JSON.stringify({ duration: v ? v.duration : null }); })()
//
// 用法：
//   node poc/probe/verify-pgc-by-snapshot.mjs <session-id>
//   node poc/probe/verify-pgc-by-snapshot.mjs <session-id> --json

import { spawnSync } from 'node:child_process';

const BSK = process.env.BSK_BIN || 'bsk';
const SID = process.argv[2];
const AS_JSON = process.argv.includes('--json');

if (!SID) {
  console.error('用法: node poc/probe/verify-pgc-by-snapshot.mjs <session-id> [--json]');
  process.exit(2);
}

/**
 * ⚠️ `shell: false`（默认值，**不要改成 true**）。
 *
 * 与 `reload-extension.mjs` 的坑 4 同源：`shell: true` 时表达式会被 cmd/bash 再解析一遍，
 * `!` 触发历史展开、`"` 被剥掉。
 */
const r = spawnSync(BSK, ['snapshot', '--session', SID, '--json'], {
  env: { ...process.env, BSK_AUTO_START: '0' },
  encoding: 'utf8',
  shell: false,
  maxBuffer: 64 * 1024 * 1024,
});

if (r.status !== 0) {
  console.error('[snapshot] 失败：', (r.stderr || r.stdout || '').slice(0, 400));
  process.exit(1);
}

let snap;
try {
  snap = JSON.parse(r.stdout);
} catch (e) {
  console.error('[snapshot] 输出不是合法 JSON：', String(e.message));
  process.exit(1);
}

const text = snap.text ?? '';

/** 进度显示形如 `13:38 / 24:01` */
const progress = /\b(\d{1,2}:\d{2})\s*\/\s*(\d{1,2}:\d{2})\b/.exec(text);

/** 画质按钮文案（`2160P` / `1080P` / …） */
const quality = [...text.matchAll(/button "((?:2160|1440|1080|720|480|360)P)"/g)].map((m) => m[1]);

/** 页面上是否仍挂着「试看」相关元素（**不代表当前流是试看**） */
const previewMarkers = {
  previewing: text.includes('试看中'),
  vipOnly: text.includes('大会员专享'),
  becomeVip: text.includes('成为大会员'),
};

function toSeconds(hms) {
  if (!hms) return null;
  const [m, s] = hms.split(':').map(Number);
  return m * 60 + s;
}

const totalSec = progress ? toSeconds(progress[2]) : null;

/**
 * 结论：总时长 > 180 秒 = 播的不是试看流。
 *
 * 180 是 B站试看流的标准长度（`poc/probe` 多个脚本里都用这个数）。
 * 留 30 秒余量，避免刚好卡在边界的噪声。
 */
const TRIAL_SEC = 180;
const verdict =
  totalSec === null
    ? { ok: false, reason: '读不到播放进度（页面可能没在播放）' }
    : totalSec > TRIAL_SEC + 30
      ? { ok: true, reason: `总时长 ${progress[2]} > ${String(TRIAL_SEC)}s，播的是完整集` }
      : { ok: false, reason: `总时长 ${progress[2]} ≈ 试看长度（${String(TRIAL_SEC)}s）` };

const result = {
  tab_id: snap.tab_id ?? null,
  ref_count: snap.ref_count ?? null,
  truncated: snap.truncated ?? null,
  progress: progress ? progress[0] : null,
  total_seconds: totalSec,
  qualities: [...new Set(quality)],
  preview_markers_on_page: previewMarkers,
  verdict,
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('=== PGC 播放状态（bsk snapshot，零协作上下文）===');
  console.log('  播放进度      :', result.progress ?? '(未找到)');
  console.log('  总时长(秒)    :', result.total_seconds ?? '(未知)');
  console.log('  画质按钮      :', result.qualities.join(', ') || '(未找到)');
  console.log(
    '  页面试看标记  :',
    [
      previewMarkers.previewing && '试看中',
      previewMarkers.vipOnly && '大会员专享',
      previewMarkers.becomeVip && '成为大会员',
    ]
      .filter(Boolean)
      .join(' / ') || '(无)',
  );
  console.log('');
  console.log(verdict.ok ? '✅ ' : '❌ ', verdict.reason);
  console.log('');
  console.log(
    '注：页面上的「试看中」元素不代表当前流是试看 —— 那是 B站常驻的会员引导条，' +
      '判据看的是**实际播放总时长**。',
  );
}

process.exit(verdict.ok ? 0 : 1);
