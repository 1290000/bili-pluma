import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const SID = process.argv[2];
const TAB = process.argv[3];

/** 通过 stdin 传表达式，绕开 PowerShell 的引号剥离 */
export function evaluate(expr) {
  const out = execFileSync('bsk', ['evaluate', '--session', SID, '--tab-id', TAB, '--stdin'], {
    input: expr,
    encoding: 'utf8',
    env: { ...process.env, BSK_AUTO_START: '0' },
  });
  return out.trim();
}
