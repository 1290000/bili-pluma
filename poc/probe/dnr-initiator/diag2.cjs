// 诊断②：为什么 service worker 不出现
// - 打印 chrome://version 的启动命令行（确认 --load-extension 是否被吃掉了）
// - 直接访问 chrome-extension://<从 profile 里读到的 id>，看是否可加载
// - 检查 profile 里的 Extensions 目录
const { chromium } = require('playwright-core');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EXT = path.resolve(__dirname);
const UD = path.join(os.tmpdir(), 'pluma-diag2-' + Date.now());

(async () => {
  const channel = (process.argv.find((a) => a.startsWith('--browser=')) || '--browser=chrome').split('=')[1] === 'edge' ? 'msedge' : 'chrome';
  const ctx = await chromium.launchPersistentContext(UD, {
    channel,
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  await new Promise((r) => setTimeout(r, 4000));
  console.log('SWs:', ctx.serviceWorkers().map((s) => s.url()));

  const p = await ctx.newPage();
  await p.goto('chrome://version');
  const txt = await p.evaluate(() => document.body.innerText);
  const lines = txt.split('\n');
  console.log('--- chrome://version (filtered) ---');
  for (const l of lines) {
    if (/Command Line|命令行|Profile Path|个人资料路径|Executable|可执行/.test(l)) console.log(l.slice(0, 2000));
  }

  // 扫 profile 里是否登记了我们的扩展
  const extDir = path.join(UD, 'Default', 'Extensions');
  console.log('--- profile Extensions dir ---');
  try {
    console.log(fs.readdirSync(extDir).join(', '));
  } catch (e) {
    console.log('no Extensions dir:', e.message);
  }
  const prefsPath = path.join(UD, 'Default', 'Preferences');
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    const settings = prefs.extensions?.settings ?? {};
    console.log('--- extension settings ids ---');
    console.log(Object.keys(settings).join(', '));
    for (const [id, v] of Object.entries(settings)) {
      console.log(id, '->', JSON.stringify({ path: v.path, state: v.state, manifestName: v.manifest?.name, location: v.location }));
    }
  } catch (e) {
    console.log('prefs read fail:', e.message);
  }

  await ctx.close();
})();
