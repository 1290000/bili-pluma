import { backup, restore } from './rv-lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const CHAIN = 'tests/unit/content/panel-logsmeta-chain.test.ts';
const snap = backup([CHAIN]);
let s = readFileSync(CHAIN, 'utf8');
const marker = "      `禁止 logsMeta 的链式二次访问 —— 必须先收敛成 meta 变量：\\n${violations.join('\\n')}`,\n    ).toEqual([]);";
s = s.replace(marker, "      `禁止 logsMeta 的链式二次访问 —— 必须先收敛成 meta 变量：\\n${violations.join('\\n')}`,\n    ).toEqual(['__forced_self_explode__']);");
writeFileSync(CHAIN, s, 'utf8');
console.log('MUTATED-KEPT');
