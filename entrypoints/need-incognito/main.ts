/**
 * 「需要开启 InPrivate 权限」说明页。
 *
 * ## 为什么它可能会自己关掉
 *
 * split 模式下普通/无痕 background 是两个互不通信的实例，都会收到图标点击。
 * 通常的情况是：**无痕实例成功开出了二维码窗口，普通实例没开成**，
 * 于是这个说明页被误弹。
 *
 * 所以这里做两件事：
 *   1. 监听 `pluma:login-ready` —— 一旦二维码窗口就绪，**自动关闭自己**
 *   2. 超过 8 秒仍未就绪 → 保留在屏幕上，此时说明确实没有权限
 *
 * 用户看到的效果：说明页闪一下 → 二维码窗口出现 → 说明页消失。
 *
 * ⚠️ **第 1 条的自动关闭不能删。** 它是处理"误弹"的关键 —— 删了之后
 * 正常用户可以成功登录，却会永远看到一个说"你没权限"的页面。
 *
 * ## 一键直达：主路径 + 一层理论保险（2026-11-10）
 *
 * **主路径**：`chrome.tabs.create({ url: 'chrome://extensions/?id=<扩展ID>' })`
 *
 * 实测（Edge 157，2026-11-10）：**可用，且不用判浏览器。** Edge 会把 `chrome://`
 * 自动重写成 `edge://`，`?id=` 参数逐字符保留，用户被直接定位到 Pluma，不用在列表里找。
 * ```
 * requestedUrl: chrome://extensions/?id=<id>
 * landedUrl   : edge://extensions/?id=<id>     ← 自动重写，参数保住
 * threw: false   status: complete   title: 扩展
 * ```
 *
 * ⚠️ **不要按浏览器分支**（`navigator.userAgent.includes('Edg/')` 那套）。
 * 既然 `chrome://` 两边都通，多加一条分支只会多一个出错点。
 *
 * ⚠️ **Chrome 侧未实测**（验证环境只有 Edge）。「`chrome://` 在 Chrome 下可用」是
 * 按原生 scheme 的推断。所以保留 `catch` 作**理论保险**（实测从未触发）：万一将来某个
 * 版本真拒绝了，就把地址显示出来让用户手动粘贴，而不是"点了没反应"。
 */

import { readLoginReady, watchForLoginReady } from '@/src/background/login-handshake';

import '@/src/design/tokens.css';
import './style.css';

const tipEl = document.getElementById('auto-tip');
const openBtn = document.getElementById('open-ext-page') as HTMLButtonElement | null;
const copyBtn = document.getElementById('copy-ext-url') as HTMLButtonElement | null;
const codeEl = document.getElementById('ext-url-code');
const hintEl = document.getElementById('open-hint');

/** 本扩展的详情页地址。`?id=` 让浏览器直接展开它，省掉在列表里找。 */
function extDetailUrl(): string {
  const id = chrome.runtime?.id;
  // 拿不到 id 就退化成列表页（理论上不会发生：这是在扩展页里跑的）
  return id ? `chrome://extensions/?id=${id}` : 'chrome://extensions/';
}

function setHint(text: string): void {
  if (hintEl) hintEl.textContent = text;
}

/** 兜底（理论保险，实测未触发）：把地址显示出来并选中，用户 Ctrl+C 粘贴即可。 */
async function fallbackCopy(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    setHint('已复制扩展地址 —— 粘贴到地址栏回车即可。');
  } catch {
    setHint('请手动复制下面的地址，粘贴到地址栏回车。');
  }
  if (codeEl) {
    codeEl.textContent = url;
    codeEl.classList.add('emph');
    try {
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      /* 选区失败不影响主流程 */
    }
  }
}

/**
 * 点击「打开扩展详情页」。
 *
 * 主路径就一条，不分浏览器；`catch` 只是保险，从未在实测中触发过。
 */
async function openExtensionsPage(): Promise<void> {
  const url = extDetailUrl();
  try {
    await chrome.tabs.create({ url, active: true });
  } catch {
    await fallbackCopy(url);
  }
}

/**
 * 轮询检测权限是否已经开启（优化 3，2026-11-10）。
 *
 * 原来是「8 秒后如果还没就绪就提示没开」——**只检测失败，不检测成功**。
 * 用户勾选之后页面没有任何反应，不知道到底成没成。
 *
 * 现在改成每秒查一次 `isAllowedIncognitoAccess()`，最多 60 秒：
 * 一旦变 true 就把提示改成绿色「已开启」，并停下轮询。
 *
 * ⚠️ 只改文案，**不自动开窗口**（2026-11-10 决定）：
 * split 模式下普通/无痕是两个实例，从说明页发消息再开无痕窗口链路更长、时序更脆；
 * 而「重新点一次工具栏图标」本来就是正常操作流。
 */
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60_000;

function watchIncognitoAccess(): void {
  const startedAt = Date.now();
  /** 先声明再赋值：`tick()` 会在下面被**立即调用一次**，那时必须已经能访问到 timer */
  let timer: number | undefined;

  const stop = (): void => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };

  const tick = (): void => {
    void chrome.extension
      .isAllowedIncognitoAccess()
      .then((allowed) => {
        if (allowed) {
          if (tipEl) {
            tipEl.textContent = '✅ 已开启，请重新点一次工具栏图标即可开始登录。';
            tipEl.classList.add('show', 'ok');
          }
          // 权限已开 → 不需要继续盯着了
          stop();
          return;
        }
        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) stop();
      })
      .catch(() => {
        // 读不到就当没开，继续等到超时
        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) stop();
      });
  };

  timer = window.setInterval(tick, POLL_INTERVAL_MS);
  tick(); // 进页面先查一次，避免要等满 1 秒才有初始反馈
}

/** 已经在别的实例里成功了 → 关掉自己 */
function closeIfReadyElsewhere(): void {
  if (!tipEl) return;

  watchForLoginReady(() => {
    // 二维码窗口出现了，说明这个说明页是误弹的
    window.close();
  });

  // 如果进页面时就已经就绪（时序错开），直接关
  void readLoginReady().then((m) => {
    if (m) window.close();
  });

  // 8 秒后还没就绪 → 说明权限确实没开，把提示高亮出来
  window.setTimeout(() => {
    void readLoginReady().then((m) => {
      if (m) return;
      // 已经因为权限开启而变绿的话，不要用这句覆盖掉
      if (tipEl.classList.contains('ok')) return;
      // 只说"还没开成"，不再复述步骤 —— 上面就是步骤列表
      tipEl.textContent = '登录窗口还没打开 —— 上面的权限应该没生效，开完记得重新点图标。';
      tipEl.classList.add('show');
    });
  }, 8000);
}

function wireButtons(): void {
  // 页面上显示的地址就是实际会打开的那个，不带 `?id=` 的部分给用户看更干净
  if (codeEl) codeEl.textContent = 'chrome://extensions/';

  openBtn?.addEventListener('click', () => {
    void openExtensionsPage();
  });

  copyBtn?.addEventListener('click', () => {
    void fallbackCopy(extDetailUrl());
  });
}

wireButtons();
watchIncognitoAccess();
closeIfReadyElsewhere();
