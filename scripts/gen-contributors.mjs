#!/usr/bin/env node
/**
 * 生成贡献者清单 —— `src/generated/contributors.ts`。
 *
 * ## 为什么在构建期生成，而不是面板打开时拉
 *
 * 1. GitHub 未认证配额是 **60 次/小时，按出口 IP 共享**（实测）。面板每开一次
 *    就发一次请求，几个人一起用很快就撞限流，而贡献者名单根本不是"实时"数据；
 * 2. 面板打开时零网络请求，也就不需要为头像加载申请任何 host 权限。
 *
 * 所以：**名单跟着发版走**。名单变化不影响功能，过期几周无所谓。
 *
 * ## 过滤规则
 *
 * - `type === 'Bot'` 一律丢掉（dependabot 之类不是贡献者，摆在"关于"里很难看）
 * - 按 `contributions` 降序取前 12 个（面板 280px，6 个一行、两行放得下）
 * - 名字用 `login`，**不用 `name`**（后者可能为空、可能是真名）
 *
 * 用法：
 *   node scripts/gen-contributors.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// secrets-ok: GitHub 仓库 owner，公开信息（README 与 git remote 里都有），不是 B站账号标识
const OWNER = '1290000'; // secrets-ok: GitHub 仓库 owner，公开信息，不是 B站账号标识
const REPO = 'bili-pluma';
const MAX = 12;
// 产物是 .ts 而不是 .json：本项目没开 `resolveJsonModule`，import JSON 拿不到类型。
// 生成 TS 常量既省掉一次 tsconfig 改动，也让面板侧直接有类型可用。
const OUT = join(process.cwd(), 'src', 'generated', 'contributors.ts');

async function main() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contributors?per_page=100`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pluma-gen-contributors',
    },
  });

  if (!res.ok) {
    console.error(`[contributors] GitHub 返回 ${res.status} ${res.statusText} —— 没有改动输出文件`);
    process.exitCode = 1;
    return;
  }

  const raw = await res.json();
  if (!Array.isArray(raw)) {
    console.error('[contributors] 响应不是数组 —— 没有改动输出文件');
    process.exitCode = 1;
    return;
  }

  const kept = raw
    .filter((item) => item && typeof item.login === 'string')
    .filter((item) => item.type !== 'Bot')
    .map((item) => ({
      login: String(item.login),
      avatarUrl: String(item.avatar_url ?? ''),
      htmlUrl: String(item.html_url ?? ''),
      contributions: Number(item.contributions ?? 0),
    }))
    .filter((item) => item.avatarUrl.startsWith('https://') && item.htmlUrl.startsWith('https://'))
    .sort((a, b) => b.contributions - a.contributions)
    .slice(0, MAX);

  if (kept.length === 0) {
    console.error('[contributors] 过滤后一位都不剩 —— 疑似响应异常，没有改动输出文件');
    process.exitCode = 1;
    return;
  }

  const body = kept
    .flatMap((c) => {
      // 仓库 owner 本身也是贡献者，会被 check-secrets 当成"主账号昵称"误报。
      // 标记必须和字面量**同一行**（check-secrets.mjs:164 逐行判断），而 prettier 会把
      // 过长的单行对象拆成多行、把行尾注释甩走 —— 所以直接生成多行、逐属性标。
      const ok = ' // secrets-ok: GitHub 用户名，公开信息';
      return [
        '  {',
        `    login: ${JSON.stringify(c.login)},${c.login === OWNER ? ok : ''}`,
        `    avatarUrl: ${JSON.stringify(c.avatarUrl)},${c.avatarUrl.includes(OWNER) ? ok : ''}`,
        `    htmlUrl: ${JSON.stringify(c.htmlUrl)},${c.htmlUrl.includes(OWNER) ? ok : ''}`,
        `    contributions: ${String(c.contributions)},`,
        '  },',
      ];
    })
    .join('\n');

  const lines = [
    '/**',
    ' * 生成物 —— **不要手改**。',
    ' *',
    ' * 由 scripts/gen-contributors.mjs 生成：按 contributions 降序、已过滤 Bot 账号、最多 12 位。',
    ' * 为什么构建期生成而不是面板打开时拉：GitHub 未认证配额 60 次/小时且按 IP 共享，',
    ' * 而这份名单不是实时数据。',
    ' */',
    '',
    'export interface Contributor {',
    '  login: string;',
    '  avatarUrl: string;',
    '  htmlUrl: string;',
    '  contributions: number;',
    '}',
    '',
    `export const CONTRIBUTORS_SOURCE = '${OWNER}/${REPO}'; // secrets-ok: GitHub 仓库坐标，公开信息`,
    '',
    'export const CONTRIBUTORS: readonly Contributor[] = [',
    body,
    '];',
    '',
  ];

  await mkdir(join(process.cwd(), 'src', 'generated'), { recursive: true });
  await writeFile(OUT, lines.join('\n'), 'utf8');

  const dropped = raw.length - kept.length;
  console.log(
    `[contributors] 写入 ${kept.length} 位（原始 ${raw.length} 条，丢弃/截断 ${dropped} 条）`,
  );
}

await main();
