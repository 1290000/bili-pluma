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
 * @param label 标题
 * @param hint 副标题（空则不渲染）
 * @param checked 当前值
 * @param disabled 是否禁用（`true` 时不可点，**且不显示为"关"**）
 * @param onToggle 切换回调
 */
export function switchRow(input: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  disabled?: boolean | undefined;
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

/** 把容器的内容整个换掉（不用 innerHTML） */
export function replaceChildren(container: HTMLElement, children: readonly Node[]): void {
  container.textContent = '';
  for (const c of children) container.appendChild(c);
}
