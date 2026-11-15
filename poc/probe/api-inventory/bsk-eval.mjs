/**
 * bsk evaluate 的安全包装 —— 把 stderr 也带回来，避免"静默空输出"。
 *
 * 背景：直接 `bsk evaluate ... | Select-Object` 时，失败的 evaluate 只在 stderr 留一行，
 * stdout 为空，看起来像"表达式没返回"。这个包一层就能看到真实错误。
 *
 * ⚠️ 表达式里**不能用双引号**（PowerShell / bsk 参数解析都会剥掉），统一用单引号。
 */
import { execFileSync } from 'node:child_process';

export function evaluate(session, tab, expr) {
  try {
    const out = execFileSync('bsk', ['evaluate', '--session', session, '--tab-id', String(tab), expr], {
      encoding: 'utf8',
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || '').trim(),
      err: (e.stderr || '').trim(),
      code: e.status,
    };
  }
}

export function navigate(session, url) {
  try {
    const out = execFileSync('bsk', ['navigate', '--session', session, url], {
      encoding: 'utf8',
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').trim(), err: (e.stderr || '').trim() };
  }
}
