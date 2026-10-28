#!/usr/bin/env node
/**
 * 响应体改写范围检查 —— 防"静默越权"。
 *
 * ## 为什么需要这个脚本
 *
 * `src/content/main-world.js` 会**改写 B 站接口响应**（把会员字段改成"已开通"），
 * 好让播放器不弹充值页。这是 [ADR 0013] 明确授权的唯一例外 —— 而
 * `AGENTS.md` §3 决策 5 写的是「**不做伪装的会员标识，连开关都不放**」，
 * 例外范围必须精确。
 *
 * 风险在于：谁往 `PATCH_PATHS` 里**加一条路径**，都不会报任何错。
 * `tsc` 看不见（这是裸 JS），单测也测不到（要真实响应）。
 * 而这个动作的性质是**扩大越权范围**，属于本项目最敏感的一类改动。
 *
 * ## 检查什么
 *
 * 1. 代码里的 `PATCH_PATHS` 必须与 ADR 0013 授权集**完全一致**（会员字段伪装）
 * 2. 代码里的 `PROGRESS_PATCH_PATHS` 必须与 ADR 0017 授权集**完全一致**（观看进度还原）
 * 3. `PATCH_HOSTS` 必须是 `api.bilibili.com`（只有一条）
 * 4. 两份 ADR 里的授权路径文本必须能被找到（ADR 被改坏了要能发现）
 *
 * ## 为什么是两份清单而不是一份
 *
 * 响应体改写有两类，性质不同，**合并检查就失去意义**：
 *   - 会员字段（ADR 0013）：改的是"权益外观"，边界要卡死在 vip.*
 *   - 观看进度（ADR 0017）：改的是"用户本来就有的数据"，边界是 last_play_*
 * 合成一个数组后，"这条路径是为了什么被授权"就查不出来了。
 *
 * 比对方式刻意选成"**两份清单在代码里对比**"，不做跨文件的模糊正则匹配：
 * 代码清单代表"实际在改什么"，ADR 清单代表"被授权改什么"，
 * 两者相等才算合规。加接口时**必须同时改 ADR**，否则这里会红。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-patch-scope.mjs
 * ```
 *
 * 有违规时退出码 1。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

/** 实际执行改写的文件（裸 JS，main world） */
const MAIN_WORLD = 'src/content/main-world.js';

/** 授权的唯一来源（会员字段伪装） */
const ADR_0013 = 'docs/decisions/0013-patch-player-info-response.md';

/** 授权的唯一来源（观看进度还原） */
const ADR_0017 = 'docs/decisions/0017-restore-primary-progress-in-playurl.md';

/**
 * ADR 0013 授权的路径，**硬编码在此并在注释里标明出处**。
 *
 * ⚠️ 为什么硬编码而不是从 ADR 文本里解析：
 *  - ADR 是给人读的散文，正则解析必然脆弱（列表格式一变就漏，且漏了不报错）
 *  - 硬编码后，ADR 改了但这里没改 → 检查会红 → 强迫人去核对
 *  - **改这个数组之前必须先改 ADR 0013**，否则就是绕过决策流程
 *
 * 出处：ADR 0013 「允许改写的接口」一行 + 「补充授权」一节（nav 于 2026-10-26 追加）。
 */
const AUTHORIZED_PATHS = ['/x/web-interface/nav', '/x/player/wbi/v2', '/x/player/v2'];

/**
 * ADR 0017 授权可改写**观看进度字段**的路径，同样硬编码。
 *
 * ⚠️ 这两份清单**不许合并**。它们授权的是两类完全不同的改写：
 *   - AUTHORIZED_PATHS        → 把会员字段伪装成已开通（扩大的是"权益外观"）
 *   - AUTHORIZED_PROGRESS_PATHS → 把 `last_play_time` / `last_play_cid` 还原成主账号的
 *                                （改的是"用户本来就有的数据"）
 * 合并成一个清单，将来就分不清哪条路径是为了什么被授权的。
 *
 * 出处：ADR 0017 「决策」一节的代码块。
 */
const AUTHORIZED_PROGRESS_PATHS = ['/x/player/wbi/playurl', '/x/player/playurl'];

/** 授权的唯一来源（PGC 试看标记，2026-10-28 新增） */
const ADR_0021 = 'docs/decisions/0021-patch-pgc-preview-flags.md';

/**
 * ADR 0021 授权可改写的**字段**（不是路径），同样硬编码。
 *
 * ⚠️ 这一份和上面两份**必须分开**：前两份按**路径**授权（哪些接口的响应能碰），
 * 这一份按**字段**授权（PGC 的播放数据里哪几个标记能改）。
 * 合并成一个结构，将来就分不清"这条是为了什么被授权的"。
 *
 * 边界：只改"这份数据是不是试看"，不碰 `user_status.has_paid` / `vip_info` / `supplement`。
 *
 * 出处：ADR 0021「决策」一节的表格。
 */
const AUTHORIZED_PGC_FLAGS = ['play_video_type', 'play_check.play_detail', 'video_info.is_preview'];

/** 授权的唯一来源（PGC 试看提示条，2026-10-28 新增） */
const ADR_0022 = 'docs/decisions/0022-hide-pgc-preview-toast.md';

/**
 * ADR 0022 授权可隐藏的 DOM 选择器。
 *
 * ⚠️ 这一份授权的是**渲染层**（藏掉一条本地提示），不是数据层。
 * 前三份都是"改数据"，这一份是"不改数据、只是不显示已经过时的那句话"。
 * 合并进任何一份都会让"这条是为了什么被授权的"查不出来。
 *
 * 边界：只允许 `.bpx-player-toast-text` 这一个容器；
 * 扩大到 `.bpx-player-*` 会连带吃掉网络/解码等真实错误提示。
 */
const AUTHORIZED_PGC_TOAST = ['.bpx-player-toast-item'];

/**
 * 判定"这条 item 是试看提示"的标记。**与上面那行必须同源**。
 *
 * ⚠️ 两个常量不能合并成一个：
 *   - `AUTHORIZED_PGC_TOAST`：**在哪个容器上动手**（`.bpx-player-toast-item`）
 *   - 这个：**怎么认出是试看那条**（内部含 `PromptBar`）
 * 合并就查不出"藏了容器的哪些内容"这件事。
 */
const AUTHORIZED_PGC_TOAST_MARK = '[class*="PromptBar"]';

/** 授权的主机。扩展只改 B 站主站 API，别的域一律不许。 */
const AUTHORIZED_HOSTS = ['api.bilibili.com'];

/**
 * 从源码里抽出一个 `var NAME = [...]` 形式的字符串数组字面量。
 *
 * @param {string} src
 * @param {string} name
 * @returns {string[] | null} null 表示没找到
 */
function extractStringArray(src, name) {
  const re = new RegExp(`var\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(src);
  if (!m) return null;

  const out = [];
  for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) out.push(s[1]);
  return out;
}

/**
 * 从源码里抽出一个 `var NAME = ['...']` 的选择器数组。
 *
 * ⚠️ **不能用 `extractStringArray`**（2026-10-28 踩到）：那个正则
 * `/\[([^\]]*)\]/` 会在选择器内部的 `]` 上提前收尾 ——
 * `['[class*="PromptBar_container"]']` 会被截成 `[class*="`，
 * 于是检查器对着一个错误的值做比对，**永远报不一致**（假红），
 * 而人一旦习惯了假红，真问题就漏了。
 *
 * 这里直接按整行取值，只认 `var NAME = [` 开头到行尾 `]` 之间的内容。
 */
function extractSelectorArray(src, name) {
  const line = src.split('\n').find((l) => l.trim().startsWith(`var ${name} = [`));
  if (!line) return null;
  const out = [];
  for (const m of line.matchAll(/'([^']*)'|"([^"]*)"/g)) out.push(m[1] ?? m[2]);
  return out;
}

/** 从源码里抽出一个 `var NAME = '...';` 的字符串字面量 */
function extractStringValue(src, name) {
  const line = src.split('\n').find((l) => l.trim().startsWith(`var ${name} = `));
  if (!line) return null;
  const m = /=\s*(?:'([^']*)'|"([^"]*)")/.exec(line);
  return m ? (m[1] ?? m[2]) : null;
}

function sameSet(a, b) {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

/**
 * 从源码里抽出一个 `var NAME = { ... }` 形式的**对象键**列表。
 *
 * 只认一级键（`a: v` 或 `'a.b': v`），不递归 —— 常量本身是扁平结构。
 *
 * @param {string} src
 * @param {string} name
 * @returns {string[] | null} null 表示没找到
 */
function extractObjectKeys(src, name) {
  const start = src.indexOf(`var ${name} = {`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;

  const body = src.slice(open + 1, end);
  const keys = [];
  // 匹配 `key:` 或 `'key':` 或 `"key":`
  for (const m of body.matchAll(/(?:^|[,{\n])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)) {
    keys.push(m[1] ?? m[2] ?? m[3]);
  }
  return keys;
}

async function main() {
  const src = await readFile(join(ROOT, MAIN_WORLD), 'utf8');

  const actualPaths = extractStringArray(src, 'PATCH_PATHS');
  const actualHosts = extractStringArray(src, 'PATCH_HOSTS');

  const problems = [];

  if (actualPaths === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PATCH_PATHS = [...]\``,
      why: '脚本的比对基准丢失了。要么变量被改名，要么改写逻辑被整体移除 —— 两种情况都要人工确认。',
    });
  } else if (!sameSet(actualPaths, AUTHORIZED_PATHS)) {
    const extra = actualPaths.filter((p) => !AUTHORIZED_PATHS.includes(p));
    const missing = AUTHORIZED_PATHS.filter((p) => !actualPaths.includes(p));
    problems.push({
      what: `${MAIN_WORLD} 的 PATCH_PATHS 与 ADR 0013 授权集不一致`,
      why: [
        extra.length > 0
          ? `多出未授权路径：${extra.join(', ')} —— 这是**扩大越权范围**，必须先在 ADR 0013 里授权`
          : '',
        missing.length > 0
          ? `缺少已授权路径：${missing.join(', ')} —— 可能是有意收紧，请同步改 ADR`
          : '',
        `实际：${JSON.stringify(actualPaths)}`,
        `授权：${JSON.stringify(AUTHORIZED_PATHS)}`,
      ]
        .filter(Boolean)
        .join('\n    '),
    });
  }

  if (actualHosts === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PATCH_HOSTS = [...]\``,
      why: '主机白名单缺失，改写范围就无法界定。',
    });
  } else if (!sameSet(actualHosts, AUTHORIZED_HOSTS)) {
    problems.push({
      what: `${MAIN_WORLD} 的 PATCH_HOSTS 与授权主机不一致`,
      why: `实际：${JSON.stringify(actualHosts)}｜授权：${JSON.stringify(AUTHORIZED_HOSTS)}\n    → 加新主机等于扩大改写范围，必须先改 ADR 0013`,
    });
  }

  // ── 第二类：观看进度还原（ADR 0017） ──
  //
  // 这条路径**不在** ADR 0013 的授权集里，却同样在改响应体。
  // 只看 PATCH_PATHS 的话，往 playurl 上加改写不会报任何错 —— 正是这个脚本要防的事。
  const actualProgressPaths = extractStringArray(src, 'PROGRESS_PATCH_PATHS');

  if (actualProgressPaths === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PROGRESS_PATCH_PATHS = [...]\``,
      why: '续播修复的路径清单丢失了。要么被改名，要么修复被整体移除 —— 两种情况都要人工确认（用户会重新报"不记住进度"）。',
    });
  } else if (!sameSet(actualProgressPaths, AUTHORIZED_PROGRESS_PATHS)) {
    const extra = actualProgressPaths.filter((p) => !AUTHORIZED_PROGRESS_PATHS.includes(p));
    const missing = AUTHORIZED_PROGRESS_PATHS.filter((p) => !actualProgressPaths.includes(p));
    problems.push({
      what: `${MAIN_WORLD} 的 PROGRESS_PATCH_PATHS 与 ADR 0017 授权集不一致`,
      why: [
        extra.length > 0
          ? `多出未授权路径：${extra.join(', ')} —— 这是**扩大响应体改写范围**，必须先在 ADR 0017 里授权`
          : '',
        missing.length > 0
          ? `缺少已授权路径：${missing.join(', ')} —— 续播会失效，请同步改 ADR`
          : '',
        `实际：${JSON.stringify(actualProgressPaths)}`,
        `授权：${JSON.stringify(AUTHORIZED_PROGRESS_PATHS)}`,
      ]
        .filter(Boolean)
        .join('\n    '),
    });
  }

  let adr0017Text = '';
  try {
    adr0017Text = await readFile(join(ROOT, ADR_0017), 'utf8');
  } catch {
    problems.push({
      what: `找不到 ${ADR_0017}`,
      why: '授权来源缺失。改写 playurl 响应体这件事必须有 ADR 兜着，不能只剩代码。',
    });
  }
  if (adr0017Text) {
    const missingInAdr = AUTHORIZED_PROGRESS_PATHS.filter((p) => !adr0017Text.includes(p));
    if (missingInAdr.length > 0) {
      problems.push({
        what: `ADR 0017 里没有提到这些被授权的路径：${missingInAdr.join(', ')}`,
        why: 'ADR 被改动过。若是有意收紧授权，请同步本脚本的 AUTHORIZED_PROGRESS_PATHS；否则请恢复 ADR。',
      });
    }
  }

  // ── 第三类：PGC 试看标记（ADR 0021） ──
  //
  // 这一类改的是 `__playinfo__` 里的字段（不是网络响应），但性质与上面两类相同：
  // **改的是播放器看到的"权益外观"**。只看上面两份清单的话，
  // 往 `PGC_PREVIEW_FLAGS` 里加一个 `user_status.has_paid` 不会报任何错 —— 而那是最严重的一种越权。
  const actualPgcFlags = extractObjectKeys(src, 'PGC_PREVIEW_FLAGS');

  if (actualPgcFlags === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PGC_PREVIEW_FLAGS = {...}\``,
      why: 'PGC 试看标记清单丢失了。要么被改名，要么注入逻辑被整体移除 —— 两种情况都要人工确认（用户会重新报"播到 6 分钟就停"）。',
    });
  } else if (!sameSet(actualPgcFlags, AUTHORIZED_PGC_FLAGS)) {
    const extra = actualPgcFlags.filter((f) => !AUTHORIZED_PGC_FLAGS.includes(f));
    const missing = AUTHORIZED_PGC_FLAGS.filter((f) => !actualPgcFlags.includes(f));
    problems.push({
      what: `${MAIN_WORLD} 的 PGC_PREVIEW_FLAGS 与 ADR 0021 授权集不一致`,
      why: [
        extra.length > 0
          ? `多出未授权字段：${extra.join(', ')} —— 这是**扩大越权范围**，必须先在 ADR 0021 里授权`
          : '',
        missing.length > 0
          ? `缺少已授权字段：${missing.join(', ')} —— 播放会在试看结束点被拦，请同步改 ADR`
          : '',
        `实际：${JSON.stringify(actualPgcFlags)}`,
        `授权：${JSON.stringify(AUTHORIZED_PGC_FLAGS)}`,
      ]
        .filter(Boolean)
        .join('\n    '),
    });
  }

  let adr0021Text = '';
  try {
    adr0021Text = await readFile(join(ROOT, ADR_0021), 'utf8');
  } catch {
    problems.push({
      what: `找不到 ${ADR_0021}`,
      why: '授权来源缺失。改写 PGC 试看标记这件事必须有 ADR 兜着，不能只剩代码。',
    });
  }
  if (adr0021Text) {
    const missingInAdr = AUTHORIZED_PGC_FLAGS.filter((f) => !adr0021Text.includes(f));
    if (missingInAdr.length > 0) {
      problems.push({
        what: `ADR 0021 里没有提到这些被授权的字段：${missingInAdr.join(', ')}`,
        why: 'ADR 被改动过。若是有意收紧授权，请同步本脚本的 AUTHORIZED_PGC_FLAGS；否则请恢复 ADR。',
      });
    }
  }

  // ── 第四类：PGC 试看提示条（ADR 0022） ──
  //
  // 这一类改的是**页面渲染**（藏掉播放器左下角那条「试看中」），
  // 前三类改的是数据。同样属于"让界面看起来有权益"，必须卡死范围。
  const actualToast = extractSelectorArray(src, 'PGC_TOAST_ITEM');
  const actualToastMark = extractStringValue(src, 'PGC_TOAST_MARK');

  /**
   * 校验"筛选标记"本身。
   *
   * ⚠️ 这个必须单独查：只查容器（`.bpx-player-toast-item`）是不够的 ——
   * 那个容器里同时装着"跳过片头""续播""从头播放"等消息。
   * 真正保证不误伤的是**这条 `PromptBar` 筛选条件**，
   * 把它删掉就等于"藏掉整个 toast 层"，而那正是我们踩过的坑。
   */
  if (actualToastMark === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PGC_TOAST_MARK = '...'\``,
      why: '筛选标记缺失。没有它就无法区分"试看提示"和其它 toast 消息（跳过片头/续播/从头播放）。',
    });
  } else if (actualToastMark !== AUTHORIZED_PGC_TOAST_MARK) {
    problems.push({
      what: `${MAIN_WORLD} 的 PGC_TOAST_MARK 与 ADR 0022 授权集不一致`,
      why: [
        `实际：${JSON.stringify(actualToastMark)}`,
        `授权：${JSON.stringify(AUTHORIZED_PGC_TOAST_MARK)}`,
        '→ 改这个标记等于改"哪些消息会被藏"，必须先改 ADR 0022',
      ].join('\n    '),
    });
  }

  if (actualToast === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PGC_TOAST_SELECTOR = [...]\``,
      why: 'PGC 试看提示条选择器丢失了。要么被改名，要么隐藏逻辑被移除 —— 都要人工确认（用户会重新报"角标挡画面"）。',
    });
  } else if (!sameSet(actualToast, AUTHORIZED_PGC_TOAST)) {
    const extra = actualToast.filter((x) => !AUTHORIZED_PGC_TOAST.includes(x));
    const missing = AUTHORIZED_PGC_TOAST.filter((x) => !actualToast.includes(x));
    problems.push({
      what: `${MAIN_WORLD} 的 PGC_TOAST_SELECTOR 与 ADR 0022 授权集不一致`,
      why: [
        extra.length > 0
          ? `多出未授权选择器：${extra.join(', ')} —— 隐藏范围扩大，必须先在 ADR 0022 里授权`
          : '',
        missing.length > 0
          ? `缺少已授权选择器：${missing.join(', ')} —— 提示条会重新出现，请同步改 ADR`
          : '',
        `实际：${JSON.stringify(actualToast)}`,
        `授权：${JSON.stringify(AUTHORIZED_PGC_TOAST)}`,
      ]
        .filter(Boolean)
        .join('\n    '),
    });
  }

  let adr0022Text = '';
  try {
    adr0022Text = await readFile(join(ROOT, ADR_0022), 'utf8');
  } catch {
    problems.push({
      what: `找不到 ${ADR_0022}`,
      why: '授权来源缺失。隐藏播放器提示条这件事必须有 ADR 兜着，不能只剩代码。',
    });
  }
  if (adr0022Text) {
    const missingInAdr = AUTHORIZED_PGC_TOAST.filter((x) => !adr0022Text.includes(x));
    if (missingInAdr.length > 0) {
      problems.push({
        what: `ADR 0022 里没有提到这些被授权的选择器：${missingInAdr.join(', ')}`,
        why: 'ADR 被改动过。若是有意收紧授权，请同步本脚本的 AUTHORIZED_PGC_TOAST；否则请恢复 ADR。',
      });
    }
  }

  // ADR 本身必须还在，且仍在讨论这几个路径（防止 ADR 被误删/大改）
  let adrText = '';
  try {
    adrText = await readFile(join(ROOT, ADR_0013), 'utf8');
  } catch {
    problems.push({
      what: `找不到 ${ADR_0013}`,
      why: '授权来源缺失。改写响应体这件事必须有 ADR 兜着，不能只剩代码。',
    });
  }
  if (adrText) {
    const missingInAdr = AUTHORIZED_PATHS.filter((p) => !adrText.includes(p));
    if (missingInAdr.length > 0) {
      problems.push({
        what: `ADR 0013 里没有提到这些被授权的路径：${missingInAdr.join(', ')}`,
        why: 'ADR 被改动过。若是有意收紧授权，请同步本脚本的 AUTHORIZED_PATHS；否则请恢复 ADR。',
      });
    }
  }

  console.log(`[patch] 检查 ${MAIN_WORLD} 的响应体改写范围`);
  console.log(`[patch] 授权来源：${ADR_0013}（会员字段）`);
  console.log(`[patch] 授权来源：${ADR_0017}（观看进度）`);
  console.log(`[patch] 授权来源：${ADR_0021}（PGC 试看标记）`);
  console.log(`[patch] 授权来源：${ADR_0022}（PGC 试看提示条）`);

  if (problems.length === 0) {
    console.log(
      `[patch] ✅ 会员字段 ${AUTHORIZED_PATHS.length} 条路径 · 观看进度 ${AUTHORIZED_PROGRESS_PATHS.length} 条路径 · PGC 试看标记 ${AUTHORIZED_PGC_FLAGS.length} 个字段 · PGC 提示条 ${AUTHORIZED_PGC_TOAST.length} 个选择器 · ${AUTHORIZED_HOSTS.length} 个主机`,
    );
    return;
  }

  console.error(`\n[patch] ❌ 发现 ${problems.length} 处问题\n`);
  for (const p of problems) {
    console.error(`  ${p.what}`);
    console.error(`    ${p.why}\n`);
  }

  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[patch] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
