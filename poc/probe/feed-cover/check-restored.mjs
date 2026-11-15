// 最终状态确认：代理开关 + 取流身份是否已恢复原值
import { execFileSync } from 'node:child_process';

const SI = process.env.SID || 'bbsz';
const TAB = process.env.TID || '1673238372';
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const b = (a) => execFileSync('bsk', a, { env: ENV, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });

const BRIDGE = `(async () => {
  const r = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
    const h = (e) => {
      if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply') {
        clearTimeout(t); window.removeEventListener('message', h);
        resolve({ ok: true, snapshot: e.data.snapshot });
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
  });
  return JSON.stringify(r);
})()`;

const out = b(['evaluate', '--session', SI, '--tab-id', TAB, BRIDGE]);
const j = JSON.parse(out.slice(out.search(/[{[]/)));
console.log('桥应答:', j.ok);
if (j.ok) {
  console.log('proxy:', JSON.stringify(j.snapshot && j.snapshot.proxy));
  console.log('view :', JSON.stringify(j.snapshot && j.snapshot.view));
  console.log('page :', JSON.stringify(j.snapshot && j.snapshot.page));
} else {
  console.log('原始:', JSON.stringify(j).slice(0, 300));
}
