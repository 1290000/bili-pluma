// @vitest-environment jsdom

/**
 * 面板的**钉住态**（2026-11-10 真机 bug）。
 *
 * ## 用户在真机上遇到的现象
 *
 * > 「点击诊断、账号等按钮时面板会直接消失，而不会直接跳转到对应的界面，
 * > 需要再次唤起面板才能显示」
 *
 * ## 根因
 *
 * `sidebar.ts` 里 `mouseleave` **无条件** `setOpen(false)`：
 *
 * ```ts
 * panel.addEventListener('mouseleave', () => { setOpen(false); });
 * ```
 *
 * "悬停自动收起"（为了不打扰沉浸）与"点击进入二级界面"（需要停留）**互相冲突**：
 * 用户点完按钮，鼠标稍微一动就离开了面板 → 立刻收起。
 *
 * ## 修法：两种状态
 *
 * | 状态 | 触发 | 鼠标离开时 |
 * | --- | --- | --- |
 * | **预览态** | 悬停贴边条 / 面板 | 自动收起（保持沉浸） |
 * | **钉住态** | **点击面板内任何元素** | **不收起** |
 *
 * ## 反向验证
 *
 * 去掉 `if (pinned) return;` → "钉住后 mouseleave 不收起"必红。
 * 去掉 `panel.addEventListener('click', pin)` → "点击进入钉住"必红。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountSidebar } from '../../../src/content/panel/sidebar';

/**
 * 建一个侧栏；返回句柄与内部元素引用。
 *
 * ## ⚠️ 必须用 `mode: 'closed'`（2026-11-10 真机踩坑）
 *
 * 生产代码是 `closed`，而 `closed` 下 document 层收到的 `ev.target` 会被
 * **重定向为宿主元素** —— 这正是上一轮 bug 的成因。
 *
 * 用 `open` 写测试会**掩盖**这个问题（open 的 `composedPath` 能拿到内部节点），
 * 于是测试全绿而真机仍然坏。**测试必须用与生产相同的 mode。**
 *
 * ⚠️ `closed` 模式下 `host.shadowRoot` 是 `null`，所以这里**自己保存** shadow 引用
 * —— 生产代码（`host.ts` 的 `shadowRef`）也是这么做的。
 */
function mount() {
  const host = document.createElement('div');
  host.id = 'test-panel-host';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });

  // 一个假的面板主体（模拟 panel.ts 的 root）
  const body = document.createElement('div');
  body.className = 'panel-body';
  const btn = document.createElement('button');
  btn.textContent = '诊断';
  body.appendChild(btn);

  const handle = mountSidebar(shadow, { body });
  const panel = shadow.querySelector('.panel') as HTMLElement;
  const strip = shadow.querySelector('.strip') as HTMLElement;
  const close = shadow.querySelector('.close') as HTMLElement;

  return { handle, panel, strip, close, body, btn, host, shadow };
}

/** 模拟鼠标离开面板 */
function leave(panel: HTMLElement): void {
  panel.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
}

/** 模拟鼠标移入面板 */
function enter(panel: HTMLElement): void {
  panel.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
}

let mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  mounted = [];
});

afterEach(() => {
  // 摘掉 document 级监听，避免跨用例污染
  for (const m of mounted) m.handle.dispose();
  document.body.textContent = '';
});

function make() {
  const m = mount();
  mounted.push(m);
  return m;
}

describe('★★ 钉住态：修复"点诊断后面板消失"', () => {
  it('★ 预览态：悬停展开，鼠标离开**自动收起**（保持沉浸）', () => {
    const m = make();
    enter(m.panel);
    expect(m.handle.isOpen()).toBe(true);
    expect(m.handle.isPinned()).toBe(false);

    leave(m.panel);
    expect(m.handle.isOpen()).toBe(false);
  });

  it('★★ 点击面板内元素 → 进入钉住态', () => {
    const m = make();
    enter(m.panel);
    expect(m.handle.isPinned()).toBe(false);

    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isPinned()).toBe(true);
  });

  it('★★ 钉住后鼠标离开 → **不收起**（这就是用户报的 bug）', () => {
    /**
     * 反例：去掉 `mouseleave` 里的 `if (pinned) return;` → 本条必红。
     * 表现就是"点完诊断，鼠标一动面板就没了"。
     */
    const m = make();
    enter(m.panel);
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    leave(m.panel);
    expect(m.handle.isOpen(), '钉住后不该因为鼠标离开而收起').toBe(true);
  });

  it('★★ 点击面板内**任何**元素都钉住（不只是按钮）', () => {
    /**
     * 用户点一个开关、鼠标移开，面板照样消失 —— 那是同一个 bug 的另一种形态。
     * 所以钉住绑在面板容器的 click 上，不是在每个按钮上单独绑。
     */
    const m = make();
    enter(m.panel);
    // 点一个普通 div（模拟面板里的说明文字）
    const plain = document.createElement('p');
    m.body.appendChild(plain);
    plain.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(m.handle.isPinned()).toBe(true);
    leave(m.panel);
    expect(m.handle.isOpen()).toBe(true);
  });

  it('★ 点 × 主动关闭 → 退出钉住并收起', () => {
    const m = make();
    enter(m.panel);
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isPinned()).toBe(true);

    m.close.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isOpen()).toBe(false);
    expect(m.handle.isPinned()).toBe(false);
  });

  it('★ 点面板外 → 退出钉住并收起', () => {
    /**
     * ⚠️ 面板内部的点击必须带 `composed: true`（2026-11-10）。
     *
     * shadow DOM 里的事件默认**不跨 shadow 边界**：只写 `bubbles: true` 时，
     * 事件在 shadow root 处就停了，document 根本收不到 ——
     * 那样 `insideClick` 标记不会被消费，会一直留到 `setTimeout(0)` 复位。
     *
     * 真机的真实点击是**跨边界**的（浏览器自动 `composed`），
     * 所以测试也必须带上，否则测的不是真机形态。
     */
    const m = make();
    enter(m.panel);
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isPinned()).toBe(true);

    // 点 body 上别的地方（模拟点页面内容）
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(m.handle.isOpen()).toBe(false);
    expect(m.handle.isPinned()).toBe(false);
  });

  it('★ 钉住态下点面板内部**不**退出（只有点外部才退出）', () => {
    const m = make();
    enter(m.panel);
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    // 再点一次面板内部
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isPinned()).toBe(true);
    expect(m.handle.isOpen()).toBe(true);
  });

  it('★ 退出钉住后，mouseleave 恢复自动收起', () => {
    const m = make();
    enter(m.panel);
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    leave(m.panel);
    expect(m.handle.isOpen()).toBe(true);

    // 点 × 退出钉住
    m.close.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    // 再悬停再离开 → 应该自动收起
    enter(m.panel);
    expect(m.handle.isOpen()).toBe(true);
    leave(m.panel);
    expect(m.handle.isOpen()).toBe(false);
  });

  it('★ dispose 摘掉 document 监听（不泄漏）', () => {
    const m = make();
    enter(m.panel);
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    m.handle.dispose();

    // dispose 之后点外部不该再有反应（监听已摘）
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    // 面板仍是开的 —— 因为点外部已经管不着它了（监听已摘）
    expect(m.handle.isOpen()).toBe(true);
  });

  it('未钉住时点外部不影响状态（不会误收起预览态）', () => {
    const m = make();
    enter(m.panel);
    expect(m.handle.isPinned()).toBe(false);

    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    // 预览态下点外部：document 监听里 `if (!pinned) return` —— 不动
    // 面板仍然开着（等 mouseleave 才收）
    expect(m.handle.isOpen()).toBe(true);
  });
});

describe('★★ 真机 bug 回归：closed shadow root 的 target 重定向（2026-11-10）', () => {
  /**
   * ## smoke 的真机证据
   *
   * ```
   * {"targetTag":"DIV","targetId":"pluma-panel-host"}
   * {"composedPath":["DIV#pluma-panel-host","BODY","HTML"]}
   * ```
   *
   * 面板在 `closed` shadow root 里 → document 层 `ev.target` 被**重定向为宿主**。
   * 上一版用 `panel.contains(ev.target)` 判"点在面板内"，**恒为 false**
   * （`panel` 是 shadow 内部的 div，宿主是它的祖先之外）。
   *
   * → 每次点面板内部都判成"点在外面" → `unpin(); setOpen(false)` → 立刻收起。
   * **用户看到的现象和修复前一模一样。**
   *
   * ## 本组测试的前提
   *
   * 用 `mode: 'closed'`（与生产一致）。jsdom 实测**确实复现了重定向**：
   * - closed：`composedPath` = `DIV,BODY,HTML,Document,Window`（只有宿主）
   * - open：`composedPath` = `BUTTON,ShadowRoot,DIV,...`（有内部节点）
   *
   * 所以这组测试能**真实**验证修复，不是只测标记机制。
   */

  it('★ 前提确认：jsdom 在 closed 模式下确实把 target 重定向成宿主', () => {
    /**
     * 这条不是测生产代码，是**证明本文件的测试环境能复现真机形态**。
     * 它红了说明 jsdom 行为变了，后面几条的结论要重新评估。
     */
    const m = make();
    let docTargetIsHost = false;
    const probe = (ev: MouseEvent): void => {
      docTargetIsHost = ev.target === m.host;
    };
    document.addEventListener('click', probe, false);

    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    document.removeEventListener('click', probe, false);

    expect(docTargetIsHost, 'jsdom 没把 target 重定向成宿主 —— 本文件的测试前提不成立').toBe(true);
  });

  it('★★ 点面板内部的按钮，**面板不收起**（真机 bug 的精确复现）', () => {
    /**
     * 反例：把 `if (insideClick) return` 删掉 → 本条必红。
     *
     * 注意这里的点击路径与真机一致：
     * `btn`（shadow 内部）→ … → `panel`（shadow 内部）→ 宿主 → body → document
     * document 层看到的 target 是宿主，不是 btn。
     */
    const m = make();
    enter(m.panel);
    expect(m.handle.isOpen()).toBe(true);

    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isPinned()).toBe(true);

    // ★ 关键：点击之后面板必须仍然展开
    expect(m.handle.isOpen(), '点面板内部不该收起 —— 这就是真机 bug').toBe(true);

    // 再点一次（模拟用户连点 Tab）也不能收
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isOpen()).toBe(true);
  });

  it('★★ 点面板内部的**非交互**区域（纯 DOM）也不收起', () => {
    /**
     * 面板里有一段说明文字（没有 stopPropagation）——
     * 那时事件会**冒泡到 document**，走的正是 `insideClick` 标记那条路。
     *
     * ⚠️ 这是唯一能验证"标记机制真的在工作"的场景（见下一条的说明）。
     */
    const m = make();
    const plain = document.createElement('p');
    m.body.appendChild(plain);

    enter(m.panel);
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isPinned()).toBe(true);

    plain.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isOpen(), '点面板内的普通元素不该收起').toBe(true);
  });

  it('★★ 标记机制确实在工作：纯 DOM 元素的点击靠它才不收起', () => {
    /**
     * ## 为什么这条能区分"标记在工作"与"标记坏了但恰好没影响"
     *
     * 面板里**拦冒泡**的交互元素（Tab / 开关 / ▸）会让 document 完全收不到事件
     * —— 那种情况下 `insideClick` 有没有置上都**无所谓**，
     * 因为 `onDocumentClick` 根本不会执行。
     *
     * （实测：子元素 `stopPropagation()` 后，panel 冒泡监听 0 次、document 冒泡监听 0 次。）
     *
     * 只有**不拦冒泡**的元素（说明文字、卡片容器）才会把事件送到 document ——
     * 那时 `insideClick` 是**唯一**阻止"点内部被判成点外面"的东西。
     *
     * 所以本条用纯 DOM 元素：如果标记机制坏了（比如置标记的监听被删、或改成
     * 收不到的阶段），document 会看到一次"没有标记的点击" → 判定为点外面 → 收起。
     */
    const m = make();
    const plain = document.createElement('div');
    plain.className = 'pane-note';
    m.body.appendChild(plain);

    enter(m.panel);
    // 先钉住（用拦冒泡的按钮，不会污染后续的标记状态）
    m.close.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    enter(m.panel);
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isPinned()).toBe(true);

    // ★ 关键：点一个**不拦冒泡**的内部元素 —— 事件会到 document
    plain.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(m.handle.isOpen(), '不拦冒泡的内部元素被当成了"点外面" —— insideClick 标记没生效').toBe(
      true,
    );
    expect(m.handle.isPinned()).toBe(true);
  });

  it('★★ 点**带 stopPropagation 的交互元素**也不收起（真机上 Tab / 开关都这样）', () => {
    /**
     * ## 这条是关键 —— 第一版的测试**漏了它**
     *
     * 面板里每个交互点（Tab、开关、`▸` 入口、× ）都调了 `ev.stopPropagation()`，
     * 那是为了阻止冒泡到 B站 页面（首页推荐卡片会跳走）。
     *
     * 后果：**事件在子元素那里就停了，到不了 `panel`**。
     *
     * 所以"置 insideClick 标记"的监听**必须是捕获阶段** ——
     * 捕获从外往里经过 panel 时就触发，早于子元素的 `stopPropagation`。
     *
     * ⚠️ 第一版测试用的 `btn` **没有** `stopPropagation`，于是
     * "把置标记改成冒泡阶段"这条反例**测试照样全绿** ——
     * 而真机上它就是坏的。**测试缺了这一条，等于没守住。**
     */
    const m = make();
    const blocking = document.createElement('button');
    blocking.textContent = '诊断 ▸';
    // 模拟真实交互点：拦掉冒泡
    blocking.addEventListener('click', (ev) => {
      ev.stopPropagation();
    });
    m.body.appendChild(blocking);

    enter(m.panel);
    blocking.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    // ★ 即使子元素拦了冒泡，面板也必须进入钉住态且不收起
    expect(m.handle.isPinned(), '置标记的监听被 stopPropagation 拦掉了 —— 必须用捕获阶段').toBe(
      true,
    );
    expect(m.handle.isOpen()).toBe(true);
  });

  it('★★ 点带 stopPropagation 的元素后，再点外部仍能收起', () => {
    /**
     * 组合场景：内部拦截冒泡的元素 → 事件**到不了 document** →
     * `insideClick` 标记没人消费 → 必须靠 `setTimeout(0)` 复位。
     *
     * 这条验证"标记不会永远卡在 true"。
     */
    const m = make();
    const blocking = document.createElement('button');
    blocking.addEventListener('click', (ev) => {
      ev.stopPropagation();
    });
    m.body.appendChild(blocking);

    enter(m.panel);
    blocking.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isPinned()).toBe(true);

    return new Promise<void>((resolve) => {
      // 等标记复位
      setTimeout(() => {
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(m.handle.isOpen(), '标记卡在 true → 点外部收不起来').toBe(false);
        resolve();
      }, 0);
    });
  });

  it('★ 点面板**外**仍然收起（标记机制没有把外部点击也放过）', () => {
    const m = make();
    enter(m.panel);
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isPinned()).toBe(true);

    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(m.handle.isOpen()).toBe(false);
    expect(m.handle.isPinned()).toBe(false);
  });

  it('★ 点内部 → 点外部 → **再**点内部，状态正确切换（标记会复位）', () => {
    /**
     * `insideClick` 用 `setTimeout(0)` 复位。这条验证它**真的复位了** ——
     * 如果永远为 true，点外部就永远收不起来。
     */
    const m = make();
    enter(m.panel);
    m.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(m.handle.isOpen()).toBe(true);

    return new Promise<void>((resolve) => {
      // 等一个宏任务，让 setTimeout(0) 复位
      setTimeout(() => {
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        outside.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
        expect(m.handle.isOpen(), '标记没复位 → 点外部收不起来').toBe(false);
        resolve();
      }, 0);
    });
  });
});
