/**
 * 面板的 DOM 小工具 —— **纯 DOM，不用 Preact**（`AGENTS.md` §5.3）。
 *
 * ## 为什么不用框架
 *
 * 面板是**注入到别人页面里**的 UI。上框架的代价：
 *   - 多一个渲染器与 B站 页面抢同一个主线程
 *   - Preact 的 diff 会在页面样式突变时产生难以复现的重排
 *
 * 而面板的 DOM 规模是几十个节点、结构固定（三个 Tab），手写完全可控。
 * 规范（`docs/02-ui-spec.md` §5）明确要求页内注入走原生 DOM。
 *
 * ## 为什么统一走 `textContent`
 *
 * 面板要显示的数据来自 `chrome.storage` 与 background 应答 —— 那些内容
 * 理论上包含用户自己的昵称。用 `innerHTML` 等于把这些字符串当代码执行。
 * **本项目所有页内注入都只用 `textContent`**，这一层统一封住，调用方想出错也难。
 */

/** 建元素（可选 class / 文本） */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 绑一个点击处理器，**并阻断冒泡**。
 *
 * ## 为什么每个交互点都必须阻断
 *
 * 面板浮在 B站 页面之上。点击事件会沿 DOM 树冒泡到页面自己的监听器：
 *   - 首页：推荐卡片在外层监听点击 → 面板里点一下会跳走一个视频
 *   - 视频页：播放器在 document 级监听 → 点面板可能触发暂停
 *
 * `badge.ts` 在角标上做过同样的事（`ev.stopPropagation()`），理由相同。
 */
export function onClick(node: HTMLElement, handler: () => void): void {
  node.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    handler();
  });
}

/**
 * 一行「标签 + 开关」。
 *
 * ## ⚠️ 两种"灰"是两件事，别混（2026-11-17）
 *
 * | 传什么 | 效果 | 语义 | 例子 |
 * | --- | --- | --- | --- |
 * | 只传 `disabled` | 只**表盘**淡（`.switch.busy`） | **此刻**不可操作 | 读取中 / 读取失败 |
 * | 加传 `dim` | **整行**淡，含标签（`.row.dim`） | **本质**不可用（依赖不满足） | 没有账号 / 父开关关着 |
 *
 * 判据一句话：**"用户做点什么，它就会变可用吗？"**
 * 会（等读出来就好）⇒ 只 `disabled`；不会（得先去登录 / 先开父开关）⇒ 加 `dim`。
 *
 * 两者可以同时传 —— 那时按 `dim` 渲染整行，表盘同时是 busy 态。
 *
 * 为什么要把这条写在这里：`dim` 原先只在净化子项那一处调用点上有解释，
 * 其余调用点一直在踩（"没有账号"只传了 `disabled`，用户反馈"灰得不明显"）。
 *
 * @param label 标题
 * @param hint 副标题（空则不渲染）
 * @param checked 当前值
 * @param disabled 是否禁用（`true` 时不可点，**且不显示为"关"**）
 * @param dim 是否**本质不可用**（整行淡）。见上表，别拿它表示"读取中"
 * @param onToggle 切换回调
 */
export function switchRow(input: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  disabled?: boolean | undefined;
  /** **本质不可用**（依赖不满足）⇒ 整行淡。别拿它表示"读取中"，那是 `disabled` */
  dim?: boolean | undefined;
  onToggle: (next: boolean) => void;
}): HTMLElement {
  const row = el('label', `row${input.dim ? ' dim' : ''}`);

  const labelBox = el('span', 'row-label');
  labelBox.appendChild(el('span', undefined, input.label));
  if (input.hint) labelBox.appendChild(el('span', 'row-hint', input.hint));
  row.appendChild(labelBox);

  const sw = el('span', `switch${input.checked ? ' on' : ''}${input.disabled ? ' busy' : ''}`);
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = input.checked;
  cb.disabled = input.disabled === true;
  cb.addEventListener('change', (ev) => {
    ev.stopPropagation();
    input.onToggle(cb.checked);
  });
  // 点 label 会冒泡到页面；整行的点击都拦掉
  row.addEventListener('click', (ev) => {
    ev.stopPropagation();
  });

  sw.appendChild(cb);
  sw.appendChild(el('span', 'knob'));
  row.appendChild(sw);

  return row;
}

/** 一个胶囊（状态点 + 文案）。`tone` 决定颜色，颜色全部来自 tokens.css */
export function pill(text: string, tone: 'neutral' | 'good' | 'warn' | 'bad'): HTMLElement {
  return el('span', `pill pill-${tone}`, text);
}

/**
 * 内联 SVG 图标。
 *
 * ## 为什么不用字符（`×` `▸` `‹`）
 *
 * 这三个字符在各平台的字形与基线都不一样：微软雅黑的 `×` 偏上、
 * 苹方的 `▸` 比雅黑窄，同一个按钮在 Edge 和 macOS 上视觉高度能差 1~2px。
 * 而它们是**控件**，不是标点 —— 用字形等于把控件尺寸交给字体。
 *
 * ## 为什么用 `currentColor`
 *
 * 图标要跟着按钮的 `color` 走（hover / 激活各自有颜色），
 * 写死 stroke 就得为每个状态各配一份。
 *
 * ⚠️ **只用 `createElementNS`，不用 innerHTML** —— 与 `dom.ts` 文件头的纪律一致。
 */
export function iconClose(size = 14): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  // tokens.css 的 --pluma-icon-stroke 在 shadow 里可用；SVG 属性不吃变量，所以写常量
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  // 读屏用户靠按钮的 aria-label，图标本身没有语义 —— 不加这行会被念成"图形"
  svg.setAttribute('aria-hidden', 'true');
  // 命中区交给按钮，图标不吃指针事件
  svg.style.pointerEvents = 'none';

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M3.2 3.2 10.8 10.8M10.8 3.2 3.2 10.8');
  svg.appendChild(path);

  return svg;
}

/** 把容器的内容整个换掉（不用 innerHTML） */
export function replaceChildren(container: HTMLElement, children: readonly Node[]): void {
  container.textContent = '';
  for (const c of children) container.appendChild(c);
}
