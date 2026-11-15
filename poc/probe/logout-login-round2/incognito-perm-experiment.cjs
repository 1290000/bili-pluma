#!/usr/bin/env node
/**
 * Q4 受控实验：InPrivate 权限值会不会自己从 true 变 false？
 *
 * ⛔ 绝不碰用户的浏览器：
 *   - 全程只用独立的 --user-data-dir（临时目录），不读不写 User Data
 *   - 不 reload 扩展、不杀 msedge 主进程、不借用户 tab、不点用户页面
 *   - 只用自己启动的那个实例，结束时只关自己启动的 pid
 *
 * 三个实验（对应任务卡 Q4.1 / Q4.2 / Q4.3）：
 *   E1  开权限 → 静置 5 分钟            → 权限掉不掉？
 *   E2  开权限 → 开 incognito 窗口 → 关掉 → 权限掉不掉？
 *   E3  开权限 → 开 incognito 窗口 → 不关 → 权限掉不掉？
 *
 * 怎么读权限值：扩展自己的 background SW 调 chrome.extension.isAllowedIncognitoAccess()。
 * 但独立 profile 里扩展的 SW 可能不被拉起，所以这里用**两步**：
 *   1) 用一个探测扩展（本脚本生成），它在 chrome://extensions 外部无法直接被读；
 *   2) 更稳的办法：直接读 profile 的 Secure Preferences 里
 *      extensions.settings.<id>.incognito —— 这正是 Q3 查到的存储位置。
 * 读文件是只读的，且读的是**我们自己 profile 的副本**，与用户 profile 无关。
 *
 * 用法：
 *   node poc/probe/logout-login-round2/incognito-perm-experiment.cjs --exp e1
 *   node poc/probe/logout-login-round2/incognito-perm-experiment.cjs --exp e2
 *   node poc/probe/logout-login-round2/incognito-perm-experiment.cjs --exp e3
 *   node poc/probe/logout-login-round2/incognito-perm-experiment.cjs --all
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_ID = 'fgmggjhdbgaclcbeaopajghpnhgkmfnf';
const EXT_SRC = path.resolve(__dirname, '..', '..', '..', '.output', 'chrome-mv3');
const WORK = path.join(__dirname, 'raw', 'repro6');
const LOG = path.join(WORK, 'experiment-log.txt');

fs.mkdirSync(WORK, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, `${line}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从指定 profile 的 Secure Preferences 读 incognito 值 */
function readIncognito(profileDir) {
  const candidates = [
    path.join(profileDir, 'Default', 'Secure Preferences'),
    path.join(profileDir, 'Secure Preferences'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const s = j?.extensions?.settings?.[EXT_ID];
      if (!s) return { found: false, file: f, value: null };
      return { found: true, file: f, value: s.incognito, state: s.state, path: s.path };
    } catch (e) {
      return { found: false, file: f, value: null, error: String(e.message) };
    }
  }
  return { found: false, file: null, value: null };
}

/** 启一个独立 profile 的 Edge 实例 */
function launch(profileDir, extraArgs = []) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience',
    `--load-extension=${EXT_SRC}`,
    '--remote-debugging-port=0',
    ...extraArgs,
    'about:blank',
  ];
  log(`启动 Edge: ${EDGE} ${args.join(' ')}`);
  const child = spawn(EDGE, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
  });
  log(`  子进程 pid=${child.pid}`);
  return child;
}

/** 只关我们自己启动的那棵进程树 */
function killTree(pid) {
  log(`  关闭自己的实例 pid=${pid}`);
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
}

async function ensureExtensionLoaded(profileDir, waitMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const r = readIncognito(profileDir);
    if (r.found) return r;
    await sleep(500);
  }
  return readIncognito(profileDir);
}

// ---------- 实验 ----------

async function experiment(name, profileTag, steps) {
  log('');
  log('='.repeat(70));
  log(`实验 ${name}`);
  log('='.repeat(70));

  const profileDir = path.join(WORK, profileTag);
  if (fs.existsSync(profileDir)) {
    log(`清空旧 profile: ${profileDir}`);
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
  fs.mkdirSync(profileDir, { recursive: true });

  const child = launch(profileDir);
  await sleep(4000);

  const loaded = await ensureExtensionLoaded(profileDir);
  log(`扩展是否已载入 profile: ${loaded.found}  (${loaded.file ?? 'no file'})`);
  if (!loaded.found) {
    log('⚠️ 扩展未被写入 Secure Preferences —— 独立 profile 可能拒绝了 --load-extension。本实验作废。');
    killTree(child.pid);
    return { name, ok: false, reason: 'extension-not-loaded' };
  }

  const result = await steps(profileDir, child);

  killTree(child.pid);
  await sleep(1500);
  const final = readIncognito(profileDir);
  log(`实验结束，final incognito = ${final.value}`);
  return { name, ok: true, ...result, finalIncognito: final.value };
}

/** 手动设置 profile 里的 incognito 值（模拟用户打开开关） */
function setIncognitoPref(profileDir, value) {
  const file = path.join(profileDir, 'Default', 'Secure Preferences');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.extensions.settings[EXT_ID].incognito = value;
  fs.writeFileSync(file, JSON.stringify(j), 'utf8');
  log(`  已把 profile 里 incognito 写成 ${value}`);
}

(async () => {
  const argv = process.argv.slice(2);
  const which = argv.includes('--all') ? 'all' : (argv[argv.indexOf('--exp') + 1] || '');
  log(`=== 实验开始  which=${which} ===`);
  log(`用户主浏览器 pid=2600 绝对不碰；本脚本只操作 ${WORK} 下的独立 profile`);

  const results = [];

  if (which === 'e1' || which === 'all') {
    results.push(await experiment('E1 开权限后静置 5 分钟', 'p-e1', async (dir) => {
      setIncognitoPref(dir, true);
      log('  【已开权限】开始静置 5 分钟，每 30 秒读一次');
      const samples = [];
      for (let i = 0; i <= 10; i += 1) {
        const r = readIncognito(dir);
        samples.push({ t: i * 30, value: r.value });
        log(`    +${i * 30}s  incognito=${r.value}`);
        if (i < 10) await sleep(30000);
      }
      const dropped = samples.some((s) => s.value === false);
      log(`  => E1 结论: ${dropped ? '掉了' : '5 分钟内没掉'}`);
      return { samples, dropped };
    }));
  }

  if (which === 'e2' || which === 'all') {
    results.push(await experiment('E2 开权限 → 开 incognito 窗口 → 关掉', 'p-e2', async (dir, child) => {
      setIncognitoPref(dir, true);
      log('  【已开权限】');
      await sleep(2000);
      const before = readIncognito(dir).value;
      log(`  开窗前 incognito=${before}`);

      // 用同一个 --user-data-dir 再起一个 incognito 窗口（同 profile，复用实例）
      log('  开 incognito 窗口…');
      const inc = spawn(EDGE, [
        `--user-data-dir=${dir}`,
        '--incognito',
        'about:blank',
      ], { detached: false, stdio: 'ignore' });
      log(`    incognito 进程 pid=${inc.pid}`);
      await sleep(6000);

      const during = readIncognito(dir).value;
      log(`  开窗后 incognito=${during}`);

      log('  关掉 incognito 窗口…');
      killTree(inc.pid);
      await sleep(5000);

      const after = readIncognito(dir).value;
      log(`  关窗后 incognito=${after}`);
      const dropped = after === false;
      log(`  => E2 结论: ${dropped ? '掉了' : '没掉'}`);
      return { before, during, after, dropped };
    }));
  }

  if (which === 'e3' || which === 'all') {
    results.push(await experiment('E3 开权限 → 开 incognito 窗口 → 不关', 'p-e3', async (dir) => {
      setIncognitoPref(dir, true);
      log('  【已开权限】');
      await sleep(2000);
      const before = readIncognito(dir).value;
      log(`  开窗前 incognito=${before}`);

      log('  开 incognito 窗口（之后不关，观察 60 秒）…');
      const inc = spawn(EDGE, [
        `--user-data-dir=${dir}`,
        '--incognito',
        'about:blank',
      ], { detached: false, stdio: 'ignore' });
      log(`    incognito 进程 pid=${inc.pid}`);

      const samples = [];
      for (let i = 0; i <= 6; i += 1) {
        await sleep(10000);
        const v = readIncognito(dir).value;
        samples.push({ t: (i + 1) * 10, value: v });
        log(`    +${(i + 1) * 10}s  incognito=${v}`);
      }
      killTree(inc.pid);
      const dropped = samples.some((s) => s.value === false);
      log(`  => E3 结论: ${dropped ? '掉了' : '没掉'}`);
      return { before, samples, dropped };
    }));
  }

  log('');
  log('='.repeat(70));
  log('实验汇总');
  log('='.repeat(70));
  for (const r of results) {
    log(`${r.name}: ${r.ok ? (r.dropped ? '权限掉了' : '权限没掉') : '作废(' + r.reason + ')'}`);
  }
  fs.writeFileSync(path.join(WORK, 'experiment-results.json'), JSON.stringify(results, null, 2), 'utf8');
  log(`结果写入 ${path.join(WORK, 'experiment-results.json')}`);
})();
