#!/usr/bin/env node
/**
 * `AGENTS.md` §4.1 的「四个必读文件」检查 —— **把"靠人确认"变成机器确认**（2026-10-30）
 *
 * ## 这条规则原文
 *
 * > 动手前确认这四个文件：
 * > - [ ] `src/shared/constants/routes.ts` —— 路径白名单
 * > - [ ] `src/shared/types/messages.ts` —— 消息类型（⚠️ 漏处理不会编译报错）
 * > - [ ] `src/design/tokens.css` —— 视觉令牌
 * > - [ ] `src/platform/http/dnr.ts` —— 风险最高，且无法用 Vitest 测
 *
 * ## 为什么需要脚本
 *
 * 这是个**带 `[ ]` 复选框的清单**，但没有任何东西在勾它。
 * 更糟的是：**文件"存在"不代表"内容还对"** ——
 * 例如 `dnr.ts` 的 `updateSessionRules` 被删了、`routes.ts` 的白名单常量改名了，
 * 文件都还在，但那些"动手前必须知道"的事实已经不成立了。
 *
 * 所以本脚本查**两级**：
 *   1. 文件存在
 *   2. **关键符号/结构仍在**（这才是"内容还对"的证据）
 *
 * ## 为什么要在这里查而不是靠 tsc
 *
 * `tsc` 能保证引用它的代码编译通过，但**保不住"它该有哪些东西"**——
 * 例如 `dnr.ts` 少了 `rebuildRulesIfEnabled`，只要没人 import 它，
 * tsc 一声不吭，而 SW 启动自愈就静默失效了（这是真实的历史事故）。
 *
 * ## 反例验证
 *
 * 删掉 `routes.ts` 的 `BILI_API_HOSTS` 导出 → 本脚本 exit 1。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-required-files.mjs
 * ```
 *
 * @see AGENTS.md §4.1
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * 四个必读文件 + 它们各自"必须还在的东西"。
 *
 * `must` 里的每一项都是**有具体后果**的：
 * 缺了它不是"少个函数"，而是某条保证静默失效（注释里写清是哪个）。
 */
const REQUIRED = [
  {
    file: 'src/shared/constants/routes.ts',
    why: '路径白名单 —— DNR 规则按它的下标分配 ID，改顺序/删项会导致规则失效',
    must: [
      {
        re: /export\s+const\s+ENABLED_ROUTE_PATHS/,
        what: '路径白名单常量（DNR 按它的下标分配规则 ID）',
      },
      {
        re: /export\s+const\s+BILI_API_HOSTS/,
        what: 'API 主机白名单（与 main-world.js 的 PATCH_HOSTS 手写两份，需一致）',
      },
    ],
  },
  {
    file: 'src/shared/types/messages.ts',
    why: '消息类型 —— 漏处理不会编译报错，靠 check-messages 兜',
    must: [
      { re: /page\/activate/, what: 'page/activate 消息（播放页激活判据的核心）' },
      { re: /export\s+type\s+RequestMsg|export\s+type\s+ResponseMsg/, what: '请求/响应消息类型' },
    ],
  },
  {
    file: 'src/design/tokens.css',
    why: '视觉令牌 —— core/shared 不许引用 @design/*，但 entrypoints 必须能用',
    must: [{ re: /--[a-z][a-z0-9-]*\s*:/, what: '至少一个 CSS 自定义属性（视觉令牌本体）' }],
  },
  {
    file: 'src/platform/http/dnr.ts',
    why: '风险最高，无法用 Vitest 测，只能靠 poc/verify/',
    must: [
      {
        re: /export\s+async\s+function\s+rebuildRulesIfEnabled/,
        what: 'SW 启动自愈（缺了它凭据失效后所有 playurl 一起变未登录）',
      },
      {
        re: /export\s+async\s+function\s+isProxyEnabled/,
        what: '总开关状态读取（page/activate 的唯一真相源）',
      },
      { re: /updateSessionRules/, what: 'DNR 规则写入调用' },
    ],
  },
];

const problems = [];

for (const item of REQUIRED) {
  const abs = join(ROOT, item.file);

  if (!existsSync(abs)) {
    problems.push({ file: item.file, kind: '文件不存在', detail: item.why });
    continue;
  }

  const src = readFileSync(abs, 'utf8');
  for (const m of item.must) {
    if (!m.re.test(src)) {
      problems.push({ file: item.file, kind: '缺少关键内容', detail: m.what });
    }
  }
}

if (problems.length > 0) {
  console.error(
    `\n[required-files] ❌ AGENTS.md §4.1 的「四个必读文件」有 ${String(problems.length)} 处问题\n`,
  );
  for (const p of problems) {
    console.error(`  ${p.file}`);
    console.error(`    ${p.kind}：${p.detail}\n`);
  }
  console.error('  这四项不是"随便四个文件"，是动手前必须成立的**事实**。');
  console.error('  文件还在但内容变了，比文件被删更危险 —— 因为没有任何编译错误。');
  console.error('  详见 AGENTS.md §4.1。\n');
  process.exit(1);
}

const totalChecks = REQUIRED.reduce((n, r) => n + r.must.length, 0);
console.log(
  `[required-files] ✅ ${String(REQUIRED.length)} 个必读文件齐全，${String(totalChecks)} 项关键内容仍在`,
);
