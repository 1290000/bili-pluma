#!/usr/bin/env node
/**
 * Q3: 从本机 Edge 的 msedge.dll / resources.pak 里搜与「Allowed in Incognito」
 * 权限相关的字符串，判断 Chromium 是否把这件事实现成一个纯用户偏好。
 *
 * 只读：只读 Edge 安装目录下的二进制文件，不写、不改、不执行。
 *
 * 为什么要这个脚本：无法联网取 Chromium 源码（沙箱/网络限制），
 * 但二进制里的字符串表是**权威实现的副产品** —— 如果权限是纯 preference，
 * 会出现 `extensions.settings` / `incognito` 这类 key；
 * 如果存在「窗口关闭后撤销」逻辑，通常会伴随专门的审计/错误串。
 *
 * 用法：
 *   node poc/probe/logout-login-round2/scan-edge-strings.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EDGE_DIR = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\157.0.4341.46';
const TARGETS = ['msedge.dll', 'resources.pak'];

/**
 * 从 Buffer 里抽出可打印 ASCII 字符串（长度 >= minLen）。
 * UTF-16LE 片段也抽一遍（Chromium 的 .pak 里两种编码都有）。
 */
function extractStrings(buf, minLen = 8) {
  const ascii = new Set();
  const wide = new Set();

  // ASCII / UTF-8 近似
  let cur = [];
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) cur.push(b);
    else {
      if (cur.length >= minLen) ascii.add(Buffer.from(cur).toString('latin1'));
      cur = [];
    }
  }
  if (cur.length >= minLen) ascii.add(Buffer.from(cur).toString('latin1'));

  // UTF-16LE
  let w = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i];
    const hi = buf[i + 1];
    if (hi === 0 && lo >= 0x20 && lo < 0x7f) w.push(lo);
    else {
      if (w.length >= minLen) wide.add(Buffer.from(w).toString('latin1'));
      w = [];
    }
  }
  if (w.length >= minLen) wide.add(Buffer.from(w).toString('latin1'));

  return { ascii, wide };
}

const NEEDLES = [
  'AllowedIncognito',
  'isAllowedIncognito',
  'incognito_access',
  'extensions.settings',
  'incognito mode',
  'incognito',
];

const report = [];

for (const name of TARGETS) {
  const p = path.join(EDGE_DIR, name);
  if (!fs.existsSync(p)) {
    report.push(`[SKIP] ${p} 不存在`);
    continue;
  }
  const size = fs.statSync(p).size;
  report.push(`\n${'='.repeat(70)}\n扫描 ${name}  (${(size / 1024 / 1024).toFixed(1)} MB)\n${'='.repeat(70)}`);

  const buf = fs.readFileSync(p);
  const { ascii, wide } = extractStrings(buf);
  report.push(`抽出字符串: ASCII=${ascii.size}  UTF16LE=${wide.size}`);

  for (const needle of NEEDLES) {
    const lower = needle.toLowerCase();
    const hitsA = [...ascii].filter((s) => s.toLowerCase().includes(lower));
    const hitsW = [...wide].filter((s) => s.toLowerCase().includes(lower));
    const total = hitsA.length + hitsW.length;
    report.push(`\n--- needle "${needle}"  命中 ${total} 条 (ascii=${hitsA.length} wide=${hitsW.length}) ---`);
    // 只打印前 25 条，避免刷屏；同时去重
    const uniq = [...new Set([...hitsA, ...hitsW])].slice(0, 25);
    for (const s of uniq) report.push(`  ${s.slice(0, 200)}`);
    if (total > 25) report.push(`  ...（共 ${total} 条，已截断显示前 25）`);
  }
}

const out = report.join('\n');
const dst = path.join(__dirname, 'raw', 'repro5', 'edge-strings-incognito.txt');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, out, 'utf8');
console.log(out);
console.log(`\n[写入] ${dst}`);
