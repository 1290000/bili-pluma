#!/usr/bin/env node
/**
 * 敏感信息检查 —— 防止测试账号的 mid / 昵称、真实凭据混进仓库。
 *
 * ## 为什么需要它
 *
 * 2026-10-27 准备发布 0.9.0 时才发现：测试用的**主账号 mid、播放账号 mid、
 * 两个昵称**散落在 11 个文件里（docs 的验证记录、tests 的夹具、poc 的脚本）。
 * 而且已经推到了公开仓库。
 *
 * 更麻烦的是：**凭据检查（`.env`、`SESSDATA`）我当时做了，mid 没想到要查。**
 * mid 不是密钥，但它能直接定位到一个人的 B 站主页 ——
 * 对"这个项目的作者是谁"这件事，等于自报身份。
 *
 * 所以把它做成**机器检查**，而不是"下次记得查"。
 *
 * ## 检查什么
 *
 * 1. **禁用的字面量**：真实账号的 mid / 昵称（含历史值）
 * 2. **凭据形态**：SESSDATA / bili_jct / access_key 的**赋值**（不是变量名）
 * 3. **本机路径**：`C:\Users\<真实用户名>\` 这类绝对路径
 *
 * ## 不检查什么
 *
 * - 测试夹具里的**假 mid**（`1000001` 这种）—— 那是正常的测试数据
 * - 变量名、注释里提到的 `SESSDATA` 字段名 —— 那是协议的一部分
 * - `bilibili.com` 的公开视频 BV 号 / aid —— 公开信息
 *
 * 判据：**这段信息能不能把人和账号对应起来？** 能，就是敏感。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * 禁止出现的字面量。
 *
 * ⚠️ 这张表**只增不减**。曾经泄露过的值必须永远留在这里 ——
 * 否则哪天有人从旧分支/旧备份里把它们带回来，检查形同虚设。
 */
const BANNED_LITERALS = [
  // 主账号
  { pattern: /\b{{primary_mid}}\b/, what: '主账号 mid' },
  { pattern: /\b{{primary_name}}\b/, what: '主账号昵称' },
  // 播放账号
  { pattern: /\b{{playback_mid}}\b/, what: '播放账号 mid' },
  { pattern: /\b{{playback_name}}\b/, what: '播放账号昵称' },
];

/**
 * 凭据形态。**只匹配"赋值"**，不匹配字段名 ——
 * `qrcode_key?: string` 这样的类型声明是协议的一部分，不该报。
 *
 * ⚠️ 假值判定：样例值里带 `fake` / `deadbeef` / `example` / `test` / `xxx`
 * 这类标记的，视为构造值，不报。测试夹具需要真结构（SESSDATA 含逗号、
 * 三段式），完全随机化的假值反而测不出问题。
 */
const FAKE_MARKER = /fake|deadbeef|example|placeholder|dummy|xxx/i;

const CREDENTIAL_PATTERNS = [
  {
    // sessdata=abc123...（长度 ≥ 20 的疑似真实值）
    pattern: /\bsessdata\s*[=:]\s*['"]?[A-Za-z0-9%_,]{20,}/i,
    what: 'SESSDATA 真实值',
  },
  {
    pattern: /\bbili_jct\s*[=:]\s*['"]?[0-9a-f]{32}/i,
    what: 'bili_jct 真实值',
  },
  {
    pattern: /\baccess_key\s*[=:]\s*['"]?[0-9a-f]{32}/i,
    what: 'access_key 真实值',
  },
  {
    // 各类私钥
    pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    what: '私钥',
  },
];

/** 本机绝对路径里带真实用户名的 */
const LOCAL_PATH_PATTERNS = [
  {
    pattern: /[A-Za-z]:\\Users\\(?!<)[^\\\s"'`]+\\/,
    what: '本机绝对路径（含 Windows 用户名）',
    /** 占位符写法不算 */
    allow: /<你的用户名>|<username>|<user>/,
  },
];

/** 不检查这些（构建产物、依赖、被忽略的抓包数据） */
const SKIP_PATH = [
  /^node_modules\//,
  /^\.output\//,
  /^dist\//,
  /^\.output\//,
  /^\.tmp\//,
  /^\.workbuddy-ai\//,
  /^poc\/verify\/bg-ssr\.json$/,
  /^poc\/verify\/bg\.html$/,
  /^scripts\/check-secrets\.mjs$/, // 本文件自己就含这些模式
];

/** 行内豁免标记：`// secrets-ok: 说明理由` */
const ALLOW_MARKER = /secrets-ok/;

function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

const findings = [];

for (const file of listTrackedFiles()) {
  if (SKIP_PATH.some((re) => re.test(file))) continue;

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // 二进制或读不了，跳过
  }

  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ALLOW_MARKER.test(line)) continue;

    for (const { pattern, what } of BANNED_LITERALS) {
      if (pattern.test(line)) {
        findings.push({ file, line: i + 1, what, text: line.trim().slice(0, 100) });
      }
    }

    for (const { pattern, what } of CREDENTIAL_PATTERNS) {
      if (pattern.test(line) && !FAKE_MARKER.test(line)) {
        findings.push({ file, line: i + 1, what, text: line.trim().slice(0, 100) });
      }
    }

    for (const { pattern, what, allow } of LOCAL_PATH_PATTERNS) {
      if (pattern.test(line) && !(allow && allow.test(line))) {
        findings.push({ file, line: i + 1, what, text: line.trim().slice(0, 100) });
      }
    }
  }
}

if (findings.length === 0) {
  console.log('[secrets] ✅ 未发现测试账号标识或凭据');
  process.exit(0);
}

console.error(`[secrets] ❌ 发现 ${String(findings.length)} 处敏感信息\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${String(f.line)}  [${f.what}]`);
  console.error(`    ${f.text}\n`);
}
console.error('处理方式：');
console.error('  · 账号标识 → 换成 {{主账号mid}} / {{播放账号mid}} 这类占位符');
console.error('  · 确属误报 → 在该行加注释 `secrets-ok: 理由`');
console.error('  · 已提交过的 → 仅改文件不够，历史里仍能搜到，需重写历史');
process.exit(1);
