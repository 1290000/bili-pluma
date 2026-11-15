/**
 * 「需要开启 InPrivate 权限」说明页。
 *
 * ## 这个页面为什么会自己关掉（2026-11-12 重写）
 *
 * split 模式下普通/无痕 background 是两个互不通信的实例，都会收到图标点击。
 * 通常的情况是：**无痕实例成功开出了二维码窗口，普通实例没开成**，
 * 于是这个说明页被误弹。
 *
 * 旧实现靠 `watchForLoginReady()` 的一次性 `chrome.storage.onChanged` 监听器自关，
 * 但那个监听器 **8 秒后就永久摘掉**（`src/background/login-handshake.ts`），
 * 而用户开权限的实测耗时远超 8 秒 → 说明页**再也关不掉**，只能刷新页面。
 * 用户原话：「必须重新刷新整个界面之后再次点击扫码登录取流账号」。
 *
 * 现在改成**自己轮询**（`incognito-watch.ts`，判据与时间常数都在那儿）：
 *   每 1.5s 同时查 `isAllowedIncognitoAccess()` 与 `readLoginReady()`，
 *   两个都为真 → 切成"已完成"状态 → 再尝试 `window.close()`。
 *
 * ⚠️ **轮询不能删。** 它是"误弹"场景下唯一能让说明页自己消失的东西；
 * 删了之后正常用户可以成功登录，却会永远看到一个说"你没权限"的页面。
 *
 * ⚠️ **`window.close()` 不能当成必成功。** 这个页面是 `chrome.windows.create()`
 * 开的，不是脚本 `window.open()` 开的，浏览器**允许直接忽略** close 且不报错，
 * 而且关没关**无法在页面内确认**（DOM 还活着）。所以顺序是：
 * **先把页面切成显式完成态，再尝试 close** —— 关不掉时用户看到的是
 * "可以关掉这个窗口"，而不是一个还在说"去开权限"的页面。
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

import { readLoginReady } from '@/src/background/login-handshake';

import '@/src/design/tokens.css';
import './style.css';

import { startIncognitoWatch, type WatchState } from './incognito-watch';

const stateEl = document.getElementById('page-state');
const openBtn = document.getElementById('open-ext-page') as HTMLButtonElement | null;
const copyBtn = document.getElementById('copy-ext-url') as HTMLButtonElement | null;
const codeEl = document.getElementById('ext-url-code');
const hintEl = document.getElementById('open-hint');

/**
 * 三种状态的文案。**只有这三个** —— 任何一个都不许是"正在检查"这种占位：
 * 用户进来时权限就没开，显示"正在检查"等于先骗他一句。
 *
 * `done` 是 `window.close()` 关不掉时的**兜底**（见文件头），所以它必须自成一句
 * 能让人照做的指引，而不是"已完成"这种只描述内部状态的话。
 */
const STATE_TEXT: Record<Exclude<WatchState, 'waiting'>, string> = {
  done: '✅ 权限已开启 —— 回到 B站 页面点「扫码登录取流账号」，本窗口可以直接关掉。',
  timeout: '还没检测到权限开启 —— 回到 B站 页面点「扫码登录取流账号」时可以再试一次。',
};

/** 本扩展的详情页地址。`?id=` 让浏览器直接展开它，省掉在列表里找。 */
function extDetailUrl(): string {
  const id = chrome.runtime?.id;
  // 拿不到 id 就退化成列表页（理论上不会发生：这是在扩展页里跑的）
  return id ? `chrome://extensions/?id=${id}` : 'chrome://extensions/';
}

/** 摊开降级路径（把地址显示出来），并把显示用的地址写进去。 */
function showFallbackHint(text: string, url: string): void {
  if (hintEl) hintEl.hidden = false;
  if (codeEl) {
    codeEl.textContent = url;
    codeEl.classList.add('emph');
  }
  if (hintEl) hintEl.setAttribute('data-reason', text);
}

/** 兜底（理论保险，实测未触发）：把地址显示出来并选中，用户 Ctrl+C 粘贴即可。 */
async function fallbackCopy(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    showFallbackHint('已复制', url);
  } catch {
    showFallbackHint('手动复制', url);
  }
  try {
    const range = document.createRange();
    range.selectNodeContents(codeEl as Node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {
    /* 选区失败不影响主流程 */
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

/** 把状态写进页面。**先于** `window.close()` 调用（见文件头顺序说明）。 */
function renderState(state: WatchState): void {
  if (!stateEl) return;
  if (state === 'waiting') {
    // 首轮"还在等"不作任何显示：用户此时刚打开页面，页面本身已经说明该做什么。
    stateEl.textContent = '';
    stateEl.className = 'page-state';
    return;
  }
  stateEl.textContent = STATE_TEXT[state];
  stateEl.className = `page-state show ${state}`;
}

/**
 * 完成态：**先渲染，再尝试关闭**。
 *
 * 顺序不能反 —— 关成功了页面没了，兜底文案也就无所谓；关不掉时用户必须已经
 * 看到 `done` 那句，否则就是"页面还在，但已经不再轮询"，和旧 bug 一模一样。
 */
function finish(): void {
  // 走到这里时状态已经渲染过了（`renderState('done')` 由 onState 先调用），
  // 这里只负责"尝试关自己"。关不掉**不做任何事**：兜底文案已经在屏幕上。
  window.close();
}

function startWatch(): void {
  startIncognitoWatch({
    // `readLoginReady()` 返回标记对象或 null，这里只关心"在不在"
    readReady: async () => (await readLoginReady()) !== null,
    readAllowed: () => chrome.extension.isAllowedIncognitoAccess(),
    onState: (state) => {
      renderState(state);
      if (state === 'done') finish();
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
  });
}

function wireButtons(): void {
  openBtn?.addEventListener('click', () => {
    void openExtensionsPage();
  });

  copyBtn?.addEventListener('click', () => {
    void fallbackCopy(extDetailUrl());
  });
}

wireButtons();
startWatch();
