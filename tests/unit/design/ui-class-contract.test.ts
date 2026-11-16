// @vitest-environment node

/**
 * 面板的**类名契约** + 令牌纯度（UI 改版 Stage 0 的交付物 ②）。
 *
 * ## 为什么需要这个文件
 *
 * 现在有 135 个测试文件，其中至少 9 个用 `querySelector('.row')`、`.acct-btn`、
 * `.sub-entry`、`.acct-row.playback .acct-sub` 这类**类名**定位元素。
 * 也就是说：**类名不是样式细节，是测试接口**。
 *
 * UI 改版（`docs/plans/2026-11-16-ui-redesign-plan.md`）会大改 `PANEL_CSS`，
 * 最容易发生的事故是"重命名一个类，DOM 与 CSS 一起改、看着没问题，
 * 但某个测试文件的 querySelector 悄悄匹配不到了"——
 * 那种失败往往表现为"断言 0 个元素"而不是报错，非常难看出来。
 *
 * 这个文件把契约收在一处：**改名必须来这里改，且改的时候必须给理由**。
 *
 * ## 为什么查 CSS 文本而不是查 DOM
 *
 * `panel-mount.test.ts` 的头注释写得很清楚：jsdom 没有布局，
 * **不测视觉**。而这里要守的恰恰不是视觉，是"这个名字还在不在"。
 * 直接读 `PANEL_CSS` 的文本，比构造一个完整 `PanelModel` 更稳、更快，
 * 也不会因为模型字段变化而连带失败。
 *
 * ⚠️ **它守不住的东西**：DOM 里是否真的用了这个类。那不是本文件的职责 ——
 * 各 Tab 的行为测试已经通过 `querySelector` 覆盖了那一层。
 *
 * ## 不在本契约内的
 *
 * - 独立窗口（popup / 更新 / 登录 / 无痕页）：它们的类名**没有任何测试引用**，
 *   改版时可按视觉需要自由调整。
 * - `data-testid`：属于另一套契约，由现有测试直接断言，不在此重复。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PANEL_CSS } from '../../../src/content/panel/sidebar';

/**
 * 🔒 类名契约 —— 与 `docs/plans/2026-11-16-ui-redesign-plan.md` §4 的 🔒 表一致。
 *
 * 按组件分组，方便"改哪块看哪段"。**删条目要给出理由**（写进 commit message）。
 */
const CONTRACT: Record<string, readonly string[]> = {
  浮层壳: [
    'panel',
    'strip',
    'strip-dot',
    'sheet',
    'sheet-head',
    'sheet-title',
    'close',
    'panel-body',
    'panel-content',
  ],
  导航: ['tabs', 'tab', 'tab-dot', 'tab-pane', 'sub-bar', 'sub-back', 'sub-title'],
  二级入口: ['sub-entry', 'sub-entry-hint', 'sub-entry-chevron'],
  状态: ['pill', 'pill-neutral', 'pill-good', 'pill-warn', 'pill-bad', 'pane-head', 'pane-line'],
  画质卡: ['unlock-card', 'unlock-head', 'unlock-title', 'unlock-anchor', 'badges', 'badge-chip'],
  开关行: ['row', 'row-label', 'row-hint', 'switch', 'knob'],
  账号卡: [
    'acct-row',
    'acct-avatar',
    'acct-main',
    'acct-pill-row',
    'acct-identity-btn',
    'acct-name',
    'acct-sub',
    'acct-tag',
    'acct-actions',
    'acct-btn',
    'acct-result',
  ],
  关于: [
    'about-meta',
    'about-meta-head',
    'about-divider',
    'about-credit',
    'contributors',
    'contributor',
    'contributor-avatar',
    'contributor-name',
    'btn-link',
  ],
  诊断: [
    'diag-section',
    'diag-facts',
    'diag-logs',
    'diag-row',
    'diag-label',
    'diag-value',
    'diag-log',
    'diag-time',
    'diag-step',
    'diag-detail',
  ],
  提示: ['pane-note', 'panel-notice'],
  /**
   * 加载时间轴（T5，2026-11-20）。速览行 + 二级浮层「本次加载」。
   *
   * 这一组的类名**全是新增**，没有一个是给旧组件改名的结果 ——
   * 所以旧那九组一个字都没动。`ld-` 前缀是为了在 DevTools 里能一眼认出
   * "这是加载详情那块"（`.diag-*` 已经是诊断浮层的，两者会同时出现在 DOM 里）。
   *
   * ⚠️ `ld-tone-*` 五个也要登记：它们是**语义色唯一的入口**，
   * 改名的后果不是变丑，是所有圆点与结论大字一起掉回继承色（看起来"没有颜色"），
   * 而那五个名字正是 `sidebar.ts` 末尾那一段的全部消费者。
   */
  加载详情: [
    'ld-quick',
    'ld-quick-head',
    'ld-quick-label',
    'ld-quick-more',
    'ld-quick-main',
    'ld-quick-dot',
    'ld-quick-title',
    'ld-quick-sub',
    'ld-conclusion',
    'ld-conclusion-icon',
    'ld-conclusion-body',
    'ld-conclusion-kicker',
    'ld-conclusion-title',
    'ld-conclusion-tag',
    'ld-conclusion-counts',
    /** 2026-11-20（裁决 ②）：结论与时间轴自洽的那句解释（只在有 P2P 时出现） */
    'ld-conclusion-note',
    'ld-count',
    'ld-timeline',
    'ld-row',
    'ld-node-wrap',
    'ld-node',
    /** 2026-11-20（裁决 ④）：里程碑的短竖线，与线路的圆/菱形/三角是两套形状 */
    'ld-tick',
    'ld-conn',
    /**
     * 2026-11-20（T11）：空档分隔行。**它不是事件** —— 一条细横线（`::before`）
     * 加一句话，没有圆点也没有竖线。改名的后果是那条线与文字一起失去样式，
     * 时间轴里凭空多出一行没有形状的裸文字（看起来像渲染坏了）。
     * ⚠️ 它挂在 `.ld-row` 上（`.ld-row.ld-gap`），所以不能拿 `.ld-row` 顶替。
     */
    'ld-gap',
    'ld-body',
    'ld-title-row',
    'ld-title',
    'ld-delta',
    'ld-detail',
    'ld-legend',
    'ld-legend-item',
    'ld-legend-text',
    'ld-tone-ok',
    'ld-tone-warn',
    'ld-tone-bad',
    'ld-tone-muted',
    'ld-tone-accent',
  ],
};

/**
 * 复合选择器：靠"两个类同时命中"才有意义的那些。
 *
 * 这类最容易在重构里被拆散（例如把 `.acct-btn.accent` 改成 `.btn-primary`），
 * 而单看类名清单发现不了 —— 所以按**完整片段**断言。
 */
const COMPOUND = [
  '.tab.active',
  '.switch.on',
  '.switch.busy',
  '.row.dim',
  '.acct-btn.accent',
  '.acct-btn.danger',
  '.acct-row.primary',
  '.acct-row.playback',
  '.pane-note.warn',
  '.unlock-title.good',
  '.unlock-title.muted',
  /**
   * 2026-11-20（T7）三枚。它们都**不是新类名**，而是既有类的第三个状态 ——
   * 所以登记在这里而不是上面的分组里。三个的共同点是"少一条就静默失效"：
   *
   * - `.diag-row.warn` → 观测到 PCDN 时那两行不变黄，"这一块唯一想让人看见的事"没了颜色
   * - `.diag-logs[hidden]` → **折叠是一个属性、界面照旧铺开**（作者样式的 display:flex
   *   会盖掉 UA 的 `[hidden]{display:none}`），原始事件表默认就占满一整屏
   * - `.sub-entry-chevron.open` → 展开后箭头不转向，用户无从判断当前是开还是关
   */
  '.diag-row.warn',
  '.diag-logs[hidden]',
  '.sub-entry-chevron.open',
] as const;

/** 该 CSS 里是否定义了恰好这个类（`.row` 不能命中 `.row-label`） */
function hasClass(css: string, name: string): boolean {
  return new RegExp(`\\.${name}(?![\\w-])`).test(css);
}

describe('面板类名契约', () => {
  for (const [group, names] of Object.entries(CONTRACT)) {
    it(`${group}：${String(names.length)} 个类名都还在`, () => {
      const missing = names.filter((n) => !hasClass(PANEL_CSS, n));
      expect(missing).toEqual([]);
    });
  }

  it('复合选择器没被拆散', () => {
    const missing = COMPOUND.filter((sel) => !PANEL_CSS.includes(sel));
    expect(missing).toEqual([]);
  });
});

describe('面板样式不许硬编码颜色', () => {
  /**
   * `var(--pluma-x, #hex)` 里的回退值是**允许的**（宿主页面可能整体丢变量时的兜底），
   * 但它必须是某个令牌的回退。这里先把这种写法剥掉，再看剩下的裸 hex。
   */
  const stripped = PANEL_CSS.replace(/var\(\s*--[\w-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/g, 'var(--x)');

  it('除了令牌回退，一个裸色值都不许有', () => {
    const bare = stripped.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    expect(bare).toEqual([]);
  });

  it('所有颜色都走 var(--pluma-*)', () => {
    // 反向验证：上面那条如果因为正则写错而永远为空，这条会兜住
    expect(stripped).not.toMatch(/rgb\(|hsl\(/);
  });
});

describe('v2 令牌（Stage 0）', () => {
  const tokens = readFileSync(join(process.cwd(), 'src/design/tokens.css'), 'utf8');

  /** Stage 0 必须已声明的 v2 名字。加名字可以，删要连同方案一起改 */
  const V2 = [
    '--pluma-canvas',
    '--pluma-menu-fill',
    '--pluma-menu-blur',
    '--pluma-card',
    '--pluma-sunken',
    '--pluma-line',
    '--pluma-line-strong',
    '--pluma-ok',
    '--pluma-ok-dot',
    '--pluma-accent-soft',
    '--pluma-elevation-stroke-color',
    '--pluma-elevation-stroke',
    '--pluma-elevation-panel',
    '--pluma-elevation-prominent',
    '--pluma-radius-chip',
    '--pluma-radius-pill',
    '--pluma-h-control',
    '--pluma-h-row',
    '--pluma-h-tab',
    '--pluma-h-list-row',
    '--pluma-font-weight-strong',
    '--pluma-duration',
    '--pluma-ease',
  ];

  it('浅色与深色都声明齐了', () => {
    const missing = V2.filter((n) => !new RegExp(`${n}\\s*:`).test(tokens));
    expect(missing).toEqual([]);
  });

  it('深色块不是漏的（深色必须覆盖材质与线）', () => {
    const dark = tokens.slice(tokens.indexOf('prefers-color-scheme: dark'));
    const mustOverride = ['--pluma-menu-fill', '--pluma-line', '--pluma-ok', '--pluma-accent-soft'];
    const missing = mustOverride.filter((n) => !new RegExp(`${n}\\s*:`).test(dark));
    expect(missing).toEqual([]);
  });
});
