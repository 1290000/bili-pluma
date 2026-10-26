#!/usr/bin/env node
/**
 * 响应体改写范围检查 —— 防"静默越权"。
 *
 * ## 为什么需要这个脚本
 *
 * `public/main-world.js` 会**改写 B 站接口响应**（把会员字段改成"已开通"），
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
const MAIN_WORLD = 'public/main-world.js';

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

function sameSet(a, b) {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
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

  if (problems.length === 0) {
    console.log(
      `[patch] ✅ 会员字段 ${AUTHORIZED_PATHS.length} 条路径 · 观看进度 ${AUTHORIZED_PROGRESS_PATHS.length} 条路径 · ${AUTHORIZED_HOSTS.length} 个主机`,
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
