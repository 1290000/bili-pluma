/**
 * 孤儿态自愈提示 —— **不依赖 controller、不依赖 chrome API 存活**（task-33）
 *
 * ## 为什么必须有这个文件（用户原话）
 *
 * > 「我只要开启或者关闭一次在 InPrivate 中允许，再返回原页面，
 * > 点击扫码登录取流账号就会没有反应」
 *
 * 复现链：切 InPrivate 权限 → 浏览器**重新加载扩展** → 原页面的 content script
 * 变成**孤儿**（任何 `chrome.*` 调用抛 `Error: Extension context invalidated.`）
 * → 面板还挂在页面上、按钮还看得见，但**点下去什么都不发生**。
 *
 * ## 为什么不能靠 `controller.showNotice()`（这是本文件存在的理由）
 *
 * `controller` 是 `paint()` 里建的，扩展重载后它可能已经是 `null`
 * （`paint()` 走 `enabled=false` 分支、或 `ctx.onInvalidated` 已经把它清过）。
 * 而旧写法是 `if (controller) controller.showNotice(...)` ——
 * **controller 为 null 时整句跳过**，于是恰好在这条路径上彻底静默。
 *
 * ⇒ 孤儿提示必须挂在**页面 document 上**（绕过 shadow root 与 controller），
 * 这才是"用户一定看得见"的那条路。
 *
 * ## ⚠️ 为什么不用 `alert()` / 页面级 `innerHTML`
 *
 * - `docs/02-ui-spec.md` §7 禁止 `alert()` / `confirm()`；
 * - 直接改页面 DOM 会被站点样式污染（`AGENTS.md` §5.3 的由来）。
 *
 * 所以自带 shadow root + 内联样式：**不碰站点 DOM 结构**，
 * 只多一个 `position:fixed` 的宿主，和 `host.ts` 里已经踩过的坑同一套解法。
 * 这里**故意不复用 `host.ts`**：那个宿主是面板的状态机（`isPanelMounted()` 等
 * 被入口依赖），在孤儿态往里塞临时节点会污染它的语义。
 */

/** 孤儿提示宿主的 id（幂等与清除都靠它） */
const ORPHAN_HOST_ID = 'pluma-orphan-hint';

/** 提示文案 —— 导出以便测试断言与产物 grep（**不要在两处手抄**） */
export const ORPHAN_HINT_TEXT =
  '扩展已更新，页面里的旧面板已经失效 —— 请刷新页面（F5）后重新打开面板';

/** 按钮文案 */
export const ORPHAN_HINT_ACTION = '刷新页面';

/**
 * 判定一个错误是不是"扩展上下文已失效"。
 *
 * 三个串都来自实测/官方错误文本：
 * - `Extension context invalidated` —— 扩展被 reload/更新后旧 content script 的调用
 * - `Receiving end does not exist` —— 目标上下文已经没了（同一种死法的另一个形状）
 * - `message port closed` —— 端口在等待中关闭（Chrome 的另一种表述）
 *
 * ⚠️ 判据**必须宽**：宁可把一次普通失败误报成"请刷新"（用户刷新后自然恢复），
 * 也不可漏判 —— 漏判的结果就是用户报的"点了没反应"。
 */
export function isOrphanError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e ?? '');
  return /Extension context invalidated|Receiving end does not exist|message port closed/i.test(
    msg,
  );
}

/**
 * 在页面 document 上渲染孤儿提示。
 *
 * 幂等：重复调用只更新已有提示，不会叠出第二个。
 *
 * @returns 建出来的宿主；`document.body` 都拿不到时返回 `null`
 *   （那种情况下没有任何可见路径可走 —— 但 `documentElement` 兜底后基本不会发生）
 */
export function showOrphanHint(): HTMLElement | null {
  const existing = document.getElementById(ORPHAN_HOST_ID);
  if (existing) return existing;

  const mount = document.body ?? document.documentElement;
  if (!mount) return null;

  const host = document.createElement('div');
  host.id = ORPHAN_HOST_ID;
  /** 内联样式 + 最高 z-index：理由同 `host.ts`（页面样式能命中我们的元素） */
  host.style.cssText =
    'position:fixed;left:50%;top:12%;transform:translateX(-50%);' +
    'z-index:2147483647;pointer-events:auto;';

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  /** 不引 tokens.css：孤儿态下 `import …?raw` 是构建期资源，能拿到；但这里只要几个色值，不值得耦合 */
  style.textContent = [
    ':host{all:initial}',
    '.box{display:flex;align-items:center;gap:12px;max-width:520px;',
    'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;',
    'background:#fff5f5;color:#8a1f1f;border:1px solid #e0a0a0;border-radius:10px;',
    'padding:12px 16px;box-shadow:0 8px 28px rgba(0,0,0,.18)}',
    '.txt{flex:1 1 auto}',
    '.btn{flex:0 0 auto;font:inherit;font-weight:600;cursor:pointer;',
    'background:#8a1f1f;color:#fff;border:0;border-radius:6px;padding:6px 12px}',
    '.btn:hover{background:#a82828}',
  ].join('');
  shadow.appendChild(style);

  const box = document.createElement('div');
  box.className = 'box';
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = ORPHAN_HINT_TEXT;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.type = 'button';
  btn.textContent = ORPHAN_HINT_ACTION;
  /**
   * 「刷新页面」—— 这是**技术上唯一可靠**的自愈方式。
   *
   * 为什么不能在页面里重新注入 content script：content script 只能由浏览器
   * 在匹配页面加载时注入，页面脚本无法把自己重新接回扩展上下文；
   * 旧的 `chrome.*` handle 已经绑定在失效的上下文上，**没有任何 API 能换绑**。
   * 所以"重新连接"按钮的真实语义只能是 `location.reload()`。
   */
  btn.addEventListener('click', () => {
    window.location.reload();
  });
  box.appendChild(txt);
  box.appendChild(btn);
  shadow.appendChild(box);

  mount.appendChild(host);
  return host;
}

/** 摘掉孤儿提示（面板恢复正常后调用，避免过期提示常驻） */
export function hideOrphanHint(): void {
  document.getElementById(ORPHAN_HOST_ID)?.remove();
}

/** 当前是否已显示（诊断与单测用） */
export function isOrphanHintShown(): boolean {
  return document.getElementById(ORPHAN_HOST_ID) !== null;
}

/** 宿主 id 的只读导出（单测按 id 找，避免手抄常量） */
export const ORPHAN_HINT_HOST_ID = ORPHAN_HOST_ID;

/**
 * 扩展上下文是否还活着 —— **纯本地判断，不发任何消息**。
 *
 * 判据是 `chrome.runtime.id`：扩展被 reload / 更新 / 权限变更后，旧 content script
 * 身上的 `chrome.runtime.id` 会变成 `undefined`（这就是 "Extension context
 * invalidated" 的底层状态）。读一个属性，**不唤醒 Service Worker**。
 *
 * ⚠️ 这里**不许**改成 `sendMessage` 探活。曾经有过 `setInterval(probeAlive, 20s)`
 * 的版本，被撤掉的原因就是它每个后台标签页都永久每 20 秒唤醒一次 SW。
 */
export function isExtensionContextAlive(): boolean {
  try {
    if (typeof chrome === 'undefined') return false;
    const runtime = chrome.runtime;
    if (!runtime) return false;
    if (typeof runtime.id !== 'string' || runtime.id.length === 0) return false;

    /**
     * 第二道判据：真的调一次 `getURL()`。
     *
     * 为什么不止看 `id`：`id` 是个**属性**，某些版本（或某些失效阶段）它还在，
     * 而调用会抛。`getURL` 是**纯本地**的字符串拼接，不发消息、不唤醒 SW，
     * 但失效上下文里任何 `chrome.*` 调用都会抛 `Extension context invalidated`。
     * 两个判据任一不成立即判死 —— 宁可在极端情况下多提示一次（用户 F5 就恢复），
     * 也不要漏判后留一个点了没反应的面板。
     */
    return typeof runtime.getURL('') === 'string';
  } catch {
    // 访问/调用失效上下文都会抛 —— 那就是"已死"
    return false;
  }
}

/** 存活监听的默认间隔。1 秒足够"立刻看到"，而读属性几乎无成本。 */
export const ORPHAN_POLL_MS = 1000;

export interface OrphanWatchOptions {
  onOrphan: () => void;
  intervalMs?: number;
  isAlive?: () => boolean;
  isHidden?: () => boolean;
}

/**
 * 盯着"扩展还在不在"—— 一旦发现上下文失效，**立刻**出提示，不需要用户点任何东西。
 *
 * ## 为什么需要它（用户原话）
 *
 * > 「这个提示应该在重新加载了扩展，或者打开/关闭了 InPrivate 时出现，
 * > 而不是要回去重新点了扫码登录取流账号才出现」
 *
 * 之前只有两条触发路径：用户点击（capture 阶段探活）、切回前台（`visibilitychange`）。
 * 两条都依赖"用户做了某个动作"。而实际场景里用户可能**就停在那个页面**——
 * 扩展在另一个窗口被 reload，他回来什么都不做，面板就一直是个死壳。
 *
 * ## 为什么这个轮询是允许的（与撤掉的那个 20s 心跳的区别）
 *
 * | | 旧的 `setInterval(probeAlive, 20s)` | 本函数 |
 * | --- | --- | --- |
 * | 动作 | `sendMessage('proxy/status')` | 读 `chrome.runtime.id` |
 * | 唤醒 SW | **每个后台标签页每 20s 一次** | **从不** |
 * | 后台开销 | 高 | 一次属性读 |
 *
 * ## 回收
 *
 * `ctx.onInvalidated` 实测不触发，所以**没有显式回收点**：定时器随页面卸载消失。
 * 这是可接受的（一次属性读 / 秒），而且**发现孤儿后自己就停**，不会长期空转。
 *
 * @returns 停止函数（测试与"面板恢复"时用）
 */
export function startOrphanWatch(options: OrphanWatchOptions): () => void {
  const intervalMs = options.intervalMs ?? ORPHAN_POLL_MS;
  const isAlive = options.isAlive ?? isExtensionContextAlive;
  const isHidden = options.isHidden ?? (() => document.visibilityState === 'hidden');

  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tick = (): void => {
    // 后台标签页不判：省电，也避免"刚切走就误报"。切回来那一瞬间由
    // `visibilitychange` 与下一次 tick 一起兜住。
    if (isHidden()) return;
    if (isAlive()) return;
    stop();
    options.onOrphan();
  };

  timer = setInterval(tick, intervalMs);
  return stop;
}
