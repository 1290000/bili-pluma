/**
 * 最小复现：`new Function('async function W(){' + body + '}')` 在 `body` 以
 * 「一个不配平的花括号」结尾时，V8 报的是 **`Unexpected token ')'`**，而不是
 * 「不配平」—— 这个报错会把人引去查别的地方。
 *
 * 对 `toJs()` 审计的含义：**逐行边扫边编会得到一串假报错**，必须先把整块切完整，
 * 再整体编译。本文件把这个坑钉成可复跑的样例。
 *
 * 用法：node poc/probe/verify-task37-39/_min.mjs
 */
const body = "      const orphan = typeof chrome === 'undefined' || chrome.runtime?.id == null;";

function compiles(s) {
  try {
    new Function('async function W(){' + s + '\n}');
    return 'OK';
  } catch (e) {
    return e.message;
  }
}

const rows = [
  ['只有一行声明', body],
  ['声明 + 不配平的 if {', body + '\n      if (orphan) {'],
  ['多行前导 + 完整 if 块', '\n'.repeat(30) + body + '\n      if (orphan) {\n      }'],
];

for (const [label, src] of rows) console.log(`${label.padEnd(24)} -> ${compiles(src)}`);

// 正确用法：整体切完整再编
const full = body + '\n      if (orphan) {\n        showOrphanHint();\n        return;\n      }';
console.log(`${'完整 if 块'.padEnd(24)} -> ${compiles(full)}`);
