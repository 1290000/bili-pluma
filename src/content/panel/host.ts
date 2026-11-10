/**
 * 页内侧栏面板的 **Shadow DOM 宿主** —— 原生 DOM，不用 Preact（`AGENTS.md` §5.3）。
 *
 * ## 结构照抄 `badge.ts`，不另写一套
 *
 * `src/content/isolated/badge.ts` 已经解决了四个**真机踩过**的问题，
 * 这里逐条沿用，理由不在本文件复述（去那个文件看现场记录）：
 *
 * | 问题 | 做法 |
 * | --- | --- |
 * | 页面样式互相污染 | `attachShadow({ mode: 'closed' })` |
 * | CSS 变量不穿透 shadow 边界 | `tokens.css?raw` 塞进 shadow root 的 `<style>` |
 * | `document_start` 时 `document.body === null` | 挂到 `document.body ?? document.documentElement` |
 * | SPA 重复注入 | 幂等：按 id 查已有宿主 |
 *
 * ## ⚠️ 挂载点兜底：本入口是 `document_idle`，**仍然要兜**
 *
 * 本入口用 `document_idle`（ADR 0033 决定二的注记：不抢跑时序），理论上那时
 * `<body>` 一定存在。但兜底这一行是**零成本**的，而 `badge.ts` 那次真机
 * `TypeError` 的代价是一整块 UI 不出现。**"时序上不可能"是推理，"实测可能"是事实**，
 * 这一行保留 `AGENTS.md` §1.5 的第二条（能实测就不要推理）。
 *
 * ## 为什么宿主本身带 `position: fixed` 与最高 z-index
 *
 * 阶段 0 实测（ADR 0033）：直播页左侧被播放器 iframe 覆盖（`left:-20`, `w:1320`），
 * `z-index:2147483647` 的宿主在命中栈里 `shadowHostHitIndex: 0`（**最顶层**），
 * 点击不会被 iframe 吞掉。这条实测就是这两个样式值的依据，**不要随手下调**。
 *
 * `pointer-events` 只开在展开出来的部件上（见 `sidebar.ts` 的 CSS），
 * 宿主盒子在静息态尽量不占点击区 —— 否则左侧那一条会挡住页面自己的元素。
 */

/** 宿主元素的 id：幂等注入与查找都靠它 */
const HOST_ID = 'pluma-panel-host';

/** 我们自己持有的 shadow 引用（`closed` 模式下外部拿不到，只能自己存） */
let shadowRef: ShadowRoot | null = null;

/**
 * 建出（或复用）宿主，并把 `tokens.css` 与给定样式塞进 shadow root。
 *
 * 幂等：第二次调用**不会**插入第二个宿主，也不会重复 attachShadow
 * （`attachShadow` 对同一元素第二次调用会抛 `NotSupportedError`）。
 *
 * @param tokensCss `tokens.css` 的原始文本（调用方 `import ... ?raw` 传进来）。
 *   **必须传**：shadow root 内部拿不到外部样式表，CSS 变量不会穿透。
 *   **空串/纯空白会抛错**（不是静默降级）—— 理由见函数体内那段注释。
 * @param panelCss 面板自己的样式文本，排在 tokens **之后**（要依赖它定义的变量）。
 * @param build 在 shadow root 里搭 DOM 的回调。**只在新宿主建出时调用一次** ——
 *   事件监听都在这里绑，重复调用会绑多次。
 * @returns shadow root；建不出来时返回 `null`
 * @throws tokens 文本为空时抛错（**这是刻意的**，见函数体注释）
 */
export function ensurePanelHost(
  tokensCss: string,
  panelCss: string,
  build: (shadow: ShadowRoot) => void,
): ShadowRoot | null {
  // 已有宿主：直接复用。⚠️ 这里**不重跑 build**，否则每次 setEnabled 都会多绑一套监听
  const existing = document.getElementById(HOST_ID);
  if (existing && shadowRef) return shadowRef;

  // 宿主在但我们丢了引用（脚本被重载过）：删掉重建，避免挂上一个没人管的裸盒子
  existing?.remove();
  shadowRef = null;

  /**
   * ## ⚠️ tokens 是空的时候必须**当场报错**，不能静默挂一个没颜色的面板
   *
   * `tokensCss` 只由入口那一行 `import tokensCss from '...tokens.css?raw'` 提供。
   * 那行被删掉 / 被 `?raw` 写错 / 构建配置改坏时，传进来的是 `undefined` 或空串 ——
   * 类型上合法、构建通过、宿主照样挂上，但**所有 `var(--pluma-*)` 全落空**：
   * 面板是一块没有任何颜色、边框、字号的裸文字。
   *
   * 更糟的是它**看起来"已经工作了"**（有 DOM、能点、能展开），
   * 于是没人会去查 —— 这是本项目反复记录的"静默失效"形状
   * （见 `ui-prefs-store.ts` 文件头的同类事故）。
   *
   * 这里选择**抛错**而不是 `console.warn`：入口的 `main()` 会因此中止，
   * 问题在开发期第一次加载就暴露，而不是留到用户截图问"为什么是白板"。
   * 抛错前不插入宿主（下面才 append），页面上不会留半成品。
   */
  if (typeof tokensCss !== 'string' || tokensCss.trim() === '') {
    throw new Error(
      '[pluma:panel] tokens.css 文本为空 —— 检查入口是否 `import tokensCss from "…/tokens.css?raw"`。' +
        '空 tokens 会让面板所有 CSS 变量失效（表现为无样式裸元素），所以这里直接拒绝挂载。',
    );
  }

  const mount = document.body ?? document.documentElement;
  const host = document.createElement('div');
  host.id = HOST_ID;
  /**
   * 样式直接写在宿主的 inline style 上，而不是 shadow 内的 `:host`。
   *
   * 理由：`closed` 模式下页面拿不到 shadow root，但**我们自己的 CSS 也可能被
   * 页面那条 `*{…!important}` 命中**。inline style + `!important` 是唯一
   * 不会被页面样式表按优先级翻盘的写法。badge.ts 用的也是 inline 写法。
   */
  host.style.cssText =
    'position:fixed;left:0;top:50%;transform:translateY(-50%);' +
    'z-index:2147483647;pointer-events:none;';

  mount.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });

  /**
   * ⚠️ tokens 必须在最前面：后面的面板样式依赖它定义的变量。
   * 顺序反了不会报错，只会让所有 `var(--pluma-*)` 落到空值 —— 看起来"样式全丢了"。
   */
  const tokenStyle = document.createElement('style');
  tokenStyle.textContent = tokensCss;
  shadow.appendChild(tokenStyle);

  const panelStyle = document.createElement('style');
  panelStyle.textContent = panelCss;
  shadow.appendChild(panelStyle);

  build(shadow);

  shadowRef = shadow;
  return shadow;
}

/**
 * 摘掉宿主（用户关掉开关 / 扩展失效时）。
 *
 * 用 `getElementById` 而不是 `shadowRef.host` 那一路：宿主可能挂在
 * `document.body` 或 `document.documentElement` 上（见 `ensurePanelHost`），
 * 任何"从 body 上 removeChild"的写法在兜底路径下都摘不掉 → 面板永久残留。
 */
export function removePanelHost(): void {
  document.getElementById(HOST_ID)?.remove();
  shadowRef = null;
}

/** 当前是否已经挂上（诊断与单测用；不暴露 shadow root） */
export function isPanelMounted(): boolean {
  return document.getElementById(HOST_ID) !== null;
}

/** 宿主元素 id 的只读导出（单测要按 id 找它，避免测试里手抄常量） */
export const PANEL_HOST_ID = HOST_ID;
