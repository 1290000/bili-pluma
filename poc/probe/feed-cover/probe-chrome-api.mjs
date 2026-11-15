// 探测：页面主世界能不能拿到 chrome.* API
import { execFileSync } from 'node:child_process';

const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const EXPR = `(() => {
  const r = {
    chromeExists: typeof chrome !== 'undefined',
    storageExists: typeof chrome !== 'undefined' && !!chrome.storage,
    runtimeExists: typeof chrome !== 'undefined' && !!chrome.runtime,
    runtimeId: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || null,
    storageLocal: (typeof chrome !== 'undefined' && chrome.storage && !!chrome.storage.local),
  };
  return JSON.stringify(r);
})()`;

const out = execFileSync('bsk', ['evaluate', '--session', 'khya', '--tab-id', '1673235541', EXPR], {
  env: ENV, encoding: 'utf8', shell: false, maxBuffer: 8 * 1024 * 1024,
});
console.log(out.trim());
