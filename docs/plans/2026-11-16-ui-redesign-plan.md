# UI 改版方案 · 以 DSH 子智能体面板为视觉参考

> **状态：草案，待拍板。** 本文件只描述"怎么改"，**一个字的代码都还没动**。
> 参考图：会话里那张 `Clipboard_Screenshot.png`（DSH「子智能体」列表面板）。
> 权威关系：视觉**规则**的最终落点是 [02-ui-spec.md](../02-ui-spec.md) §6 与
> [tokens.css](../../src/design/tokens.css)；本文是**施工方案**，验收后按 §10 的规则收口，不长期留存。
>
> ⚠️ 本文遵守 [AGENTS.md](../../AGENTS.md) §3 的 12 条决策与 §5.3 的注入约束：
> **不加依赖、不引入 UI 框架、不改任何功能判据**。改版只动"看起来怎样"。

---

## 0. 一句话方案

把扩展的"底板"从**「白卡片 + 0.5px 描边 + 投影」的堆叠式**，换成参考图的
**「统一中性底 + 发丝分隔 + 留白分组」的平板式**；并在这个底板上重排
5 个 Tab、4 个独立窗口与页内角标的层级、间距、图标与状态表达。

**不是换皮**：参考图真正的特征不是配色，是**用底色档位和留白做层级，而不是用边框和阴影**。
这一条会连带改掉现在每一处 `border + border-radius + background` 的三层叠加。

---

## 1. 现状盘点：我们到底有几块界面

`git ls-files` 实测（2026-11-16）：

| # | 界面 | 入口文件 | 尺寸 | 渲染方式 | 主要组件 |
| --- | --- | --- | --- | --- | --- |
| 1 | **页内面板（主界面）** | [sidebar.ts](../../src/content/panel/sidebar.ts)（壳）+ [panel.ts](../../src/content/panel/panel.ts)（编排）+ [tabs.ts](../../src/content/panel/tabs.ts)（5 个 Tab） | 壳 280px 宽；内容区 `max-height: min(420px, 100vh-120px)` | Shadow DOM `closed` + 原生 DOM | 贴边条 / 标题行 / Tab 栏 / 胶囊 / 解锁卡 / 开关行 / 账号卡 / 元信息卡 / 并排按钮 / 二级返回条 / 诊断行 |
| 2 | 首页净化（二级） | `tabs.ts` 的 `homeCleanPane()` | 同上 | 同上 | 返回条 + 10 个开关行 |
| 3 | 诊断（二级） | `tabs.ts` + [diagnostics.ts](../../src/content/panel/diagnostics.ts) | 同上 | 同上 | 事实行 / 日志行 / 导出按钮 |
| 4 | **popup** | [popup/main.tsx](../../entrypoints/popup/main.tsx) | 360px 宽 | Preact | 标题条 + 1 个开关行 + 提示 |
| 5 | **更新窗口** | [update/index.html](../../entrypoints/update/index.html) | 440×600（`windows.create`） | 原生 DOM | h1 / 版本行 / 步骤卡 / 主按钮 / progress / 两个 `<details>` |
| 6 | **扫码登录窗口** | [login-window/main.tsx](../../entrypoints/login-window/main.tsx) | 独立 popup 窗口 | Preact | 标题 / 副标题 / 二维码卡 / 状态行 / 刷新按钮 / 保存失败卡 |
| 7 | **无痕权限页** | [need-incognito/index.html](../../entrypoints/need-incognito/index.html) | 新标签页全宽 | 原生 DOM | 标题 / 引导句 / 状态行 / 3 步动作 / 折叠理由 |
| 8 | **页内角标** | [isolated/badge.ts](../../src/content/isolated/badge.ts) | 贴播放器右下 | Shadow DOM `closed` | 胶囊角标 + 展开浮层（detail） |

> **第 9 块一开始漏了**：`src/content/panel/orphan-hint.ts`（扩展重载后的"孤儿态"提示）
> 自带 shadow root + **内联样式**，里面有 3 处裸 hex，不在 `PANEL_CSS` 里。
> 它也是唯一一块"用户只会在出故障时看到"的界面 —— 改版要动，但优先级最低。

### 1.1 组件全部集中在两个地方，这是好消息

- **DOM 构建**：`tabs.ts` 的三个构造函数 + [dom.ts](../../src/content/panel/dom.ts) 的
  `el()` / `onClick()` / `switchRow()` / `pill()`。
- **样式**：`sidebar.ts` 里的 `PANEL_CSS`（约 850 行字符串，全项目面板样式只有这一份）。

所以"重排视觉"在代码上约等于：**改 `tokens.css` + 改 `PANEL_CSS` + 改 `dom.ts` 的 3 个工厂**，
4 个 Tab 的 DOM 结构尽量不动。这是本方案敢分 6 个阶段做的前提。

### 1.2 现状的 7 个具体问题（不是审美意见，是可指的位置）

| # | 问题 | 位置 | 后果 |
| --- | --- | --- | --- |
| 1 | **三层叠加**：白底 + 0.5px 描边 + 12px 圆角，每个卡片都这么画 | `.unlock-card` / `.about-meta` / popup `.row` / update `.step` | 面板里 4~5 个卡片挨着，眼睛看到的是"一堆框"，不是"一条信息流" |
| 2 | **强调色语义混用**：Tab 激活、胶囊 good、按钮、链接全是同一个蓝 | `.tab.active` / `.pill-good` / `.acct-btn.accent` / `.sub-back` | "当前所在"和"一切正常"长得一样，扫一眼分不出哪条是状态 |
| 3 | **间距没有等级**：`.tab-pane` 全局 6px，组间组内同值 | `PANEL_CSS .tab-pane` | 关于 Tab 已经单独打补丁到 12px（`.about-pane`），说明问题真实存在 |
| 4 | **字号只有三档且 11px 承担太多**：hint / meta / 时间 / 徽章 / 按钮文案全在 11px | `.acct-btn`(11) / `.pane-note`(11) / `.badge-chip`(11) / `.diag-*`(11) | 满屏小字，没有"主句—支撑—元数据"的层次 |
| 5 | **状态载体不统一**：有的用胶囊、有的用文字行、有的用颜色 | 画质 Tab 胶囊 / 账号卡 `.acct-tag` / 更新卡徽标 | 用户学不会"哪里看状态" |
| 6 | **图标几乎为零**：全是文字 + `▸` `‹` `×` 字符 | `.sub-entry-chevron` / `.sub-back` / `.close` | 字符箭头在中文标点下基线不稳，且各平台字形不同（§6 已禁 emoji，字符箭头是同一类问题） |
| 7 | **深色模式只有变量、没有设计**：`tokens.css` 有 6 个变量覆盖，卡片底色仍是 `--pluma-surface` | `tokens.css` dark 块 | 暗色下"卡片 vs 底板"没有档位差，全靠那条 0.5px 描边撑着 |

> ⚠️ 第 3 条不是"手感"：`PANEL_CSS` 里 `.tab-pane.about-pane{gap:12px}` 那条注释
> 自己写着"关于页不协调的根因是组间距与组内间距同值"。**这次是把它升成全项目规则。**

---

## 2. 参考图实测（不是"看着像"，是量出来的）

把截图逐像素解码后采样（脚本在临时目录，不入库）：

| 项 | 实测值 | 说明 |
| --- | --- | --- |
| 面板底色 | `#DFE0E0` | **不是实色**：70% 近白材质压在压暗的遮罩上（见 §2.2）；纯白像素 0.00% |
| 顶栏 / 工具行 | `#E1E1E1` | 与内容区差 1~2 个明度点 —— 是遮罩/内容差异的产物，**不当作设计规则** |
| 主文字 | `#202226` | 近黑但不纯黑 |
| 次要文字 | `#8E929A` | 元信息、时间、token 数 |
| 强调色 | `#4881FA` | 实心像素 83 个 ≈ 2px 高 × 40px 宽的一条 —— **Tab 下划线** |
| 状态绿 | `#28D667` | 实心圆点，横向剖面 6px 宽 |
| 行节距 | ≈93px（双行项，图内像素） | 三行信息：标题 / 等宽 id / 右对齐两行 meta |
| meta 行距 | 17px | 右对齐、等宽数字 |

**结构（自上而下）：**

```text
标题（15-16/600）  [弱图标] [弱图标] … [···]        [描边按钮 文件夹]
────────────────────────────────────────────────────────  ← 发丝线
对话(蓝字+2px蓝下划线)   轨迹(灰)
────────────────────────────────────────────────────────
[ 禁用态灰 chip ]                       [图标][图标][图标]   ← 无边框图标按钮
子智能体   44 已完成 · 3 未运行                              ← 深色词 + 灰底信息
● 一级标题（13/600，单行省略）
  b0e4e34-....（11/等宽/灰）
                                        94.8k tok
                                        3 小时 05 分 16 秒
● …
```

### 2.1 提炼成 6 条可执行的设计原则

| # | 原则 | 具体做法 | 反例（现在就有的） |
| --- | --- | --- | --- |
| D1 | **一层材质，不叠框** | 浮层只有**一层**半透明材质 + 藏在阴影里的 0.5px 发丝；内部不再给每块加"白底 + 描边" | 白卡 + 描边 + 圆角 + 投影四件套 |
| D2 | **强调色只给"当前"和"可执行"** | 蓝 = 当前 Tab / 主按钮 / 可点链接；**状态不用蓝** | `pill-good` 也用蓝，与 Tab 激活撞色 |
| D3 | **状态用点，不用块** | 6px 圆点，固定在最左列，形成纵向扫描轴 | 胶囊做状态、标签做状态、文字做状态，三种并存 |
| D4 | **元信息右对齐 + 等宽数字** | `font-variant-numeric: tabular-nums`，右对齐 | 只有 `.about-meta` 和 `.diag-time` 做了 |
| D5 | **字重分层优先于字号分层** | 13px 主句用 600，13px 正文 400，11px 只给元数据（不再更小） | 靠 11px 硬塞信息 |
| D6 | **留白即分组** | 组间 12/16px，组内 4/6px；能用留白就不用线，能用线就不用框 | 全局 6px，组内外同值 |

> **为什么还要"校准"**：我们能照搬的是**材质配方**（70% + 40px + 8% 饱和提升），
> 不是它在截图里呈现出的那个灰度 —— 那个灰度取决于它下面压着什么。
> 所以 `--pluma-canvas` 只作为**回退实色**存在，正常路径走材质层（§2.2）。

### 2.2 源码核对：那层"灰"不是灰，是半透明 + 40px 模糊

上面的采样没量错，**归因错了**。我去 DSH 源码（`deepseek-ai/deepseek-harness`，master，
2026-11-16）对了一遍，面板底板是三件套：

| 项 | 源码值 | 出处 |
| --- | --- | --- |
| 材质填充 | `--dsw-menu-surface-fill: rgba(252, 253, 254, 0.7)`（深色 `rgba(48,49,54,0.64)`） | `packages/client/ui-theme/src/styles/design-platform.css` |
| 模糊 | `--dsw-menu-backdrop-filter: blur(40px) saturate(150%)` | `packages/client/ui-theme/src/styles/gradient-shadow-text.css` |
| 描边 | **不在 `border` 上**：`0 0 0 0.5px` 作为 box-shadow 第一层 | 同上（`--dsw-elevation-stroke`） |

所以实测到的 `#DFE0E0` = 70% 近白材质**压在"被压暗的遮罩"上**，不是面板自己的底色。
整幅图 0% 纯白也由此解释：**面板本来就不是实色**。

**可直接照搬的写法**（`packages/client/ui-primitives/src/MenuSurface.module.css` 原样）：

```css
.sheet { position: relative; isolation: isolate; }
.sheet::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;            /* 只铺在内容下面 */
  border-radius: inherit; /* 跟随容器圆角 */
  background: var(--pluma-menu-fill);
  backdrop-filter: var(--pluma-menu-blur);
  pointer-events: none;
}
```

**为什么材质要单独一层，而不是直接写在 `.sheet` 上** —— 源码注释原话：
"Filtering only the background keeps nested menus and fixed overlays free of an
ancestor backdrop root or a new fixed-position containing block."

这条对我们**尤其致命**：面板里有二级浮层（首页净化 / 诊断），写在容器上会让
`backdrop-filter` 变成它们的包含块 → 定位整体错位。

**另外两条从源码抄来的禁令：**

1. **容器上不许有 `opacity`**（`MenuSurface` 注释：Opacity on the container would prevent
   its material from blurring the page）。淡出动画要做在子元素上，不能做在 `.sheet` 上。
2. **`border` 与 elevation 阴影不许并存**（DSH 的 ui-theme spec 会直接判红）：
   要么 `border: 0` + 阴影第一层带描边，要么真 `border`，二选一。

⚠️ **`corner-shape`（超椭圆圆角）暂不照搬**：DSH 在 `@supports (corner-shape: superellipse(1.5))`
里全局启用，属于渐进增强，Chrome 支持面仍窄，且我们已有圆角规范。列进 §10 待裁决 F。

---

## 3. 令牌 v2（改配色只改这一个文件）

### 3.1 颜色

| 角色 | 浅色 | 深色 | 用在哪 | 禁止用在哪 |
| --- | --- | --- | --- | --- |
| `--pluma-canvas` | `#F1F2F1` | `#1A1C1E` | **实色底板**：独立窗口（popup / 更新 / 登录 / 无痕页）+ 材质回退 | 页内浮层正常态（它有材质层） |
| `--pluma-menu-fill` | `rgba(252,253,254,.70)` | `rgba(48,49,54,.64)` | **浮层材质填充**（照搬 DSH 原值） | 卡片内部 |
| `--pluma-menu-blur` | `blur(40px) saturate(150%)` | 同值 | 材质层的 `backdrop-filter` | 卡片内部 |
| `--pluma-surface` | `#FBFCFB` | `#232527` | 内容面：独立窗口的卡、行、选中行 | 页内浮层（会盖住材质） |
| `--pluma-card` | `rgba(255,255,255,.50)` | `rgba(255,255,255,.06)` | **面板内卡片**：半透明，让材质透出来 | 独立窗口（用 `--pluma-surface`） |
| `--pluma-sunken` | `#E9EAE9` | `#151719` | 凹陷：日志、二维码区、只读块 | 可点区域 |
| `--pluma-line` | `rgba(20,22,26,.10)` | `rgba(255,255,255,.10)` | 发丝分隔线 | 卡片四边框 |
| `--pluma-line-strong` | `rgba(20,22,26,.16)` | `rgba(255,255,255,.16)` | 输入框、需要"边界"的控件 | 装饰 |
| `--pluma-text` | `#1F2226` | `#E7E9EB` | 主文字 | 元数据 |
| `--pluma-text-muted` | `#6E747D` | `#9BA1A9` | 副标题、hint、meta | 主句 |
| `--pluma-accent` | `#3E77F0` | `#79A2FF` | 当前 Tab、主按钮、文字链接 | **状态** |
| `--pluma-accent-soft` | `#E9EFFD` | `#1E2A44` | 选中底、hover 底 | 大面积背景 |
| `--pluma-ok` | `#1FA855` | `#3DD68C` | 状态点 / good 胶囊 | 主按钮 |
| `--pluma-ok-dot` | `#28D667` | `#3DD68C` | **只给圆点**（参考图原值） | 文字（对比度不足） |
| `--pluma-warn` | `#B26A00` | `#F0B44C` | 降级、警告文字 | 装饰 |
| `--pluma-danger` | `#D92D20` | `#FF6B60` | 凭据失效、退出确认 | 普通错误标点 |

**三条硬规则：**

1. `--pluma-ok` 与 `--pluma-accent` **语义互斥**：前者是"事实：正常"，后者是"交互：这里/去做"。
   今天 `pill-good` 用蓝是历史遗留，**这次拆开**（见 §11 待裁决 A）。
2. 危险 / 警告的**使用范围不变**（02 §6 原话：危险仅用于凭据失效、警告仅用于降级），
   只调色值，不扩语义。
3. **不许出现第 5 种语义色**。需要"第三档"时用同一个色的不同明度档（`color-mix`），不新增名字。

### 3.2 尺度

| 项 | 值 | 备注 |
| --- | --- | --- |
| 间距阶 | 2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 | 组内 4–6，组间 12–16，区块 20–24 |
| 圆角 | 卡 10 / 控件 8 / chip 6 / 胶囊 999 | 从 12/8/4 调整：卡片降一档，chip 升两档 |
| 字号 | 15 标题 · 13 正文 · 11 元数据 | **不出现 11px 以下**（沿用 02 §6） |
| 行高 | 1.45（正文）/ 1.35（元数据单行） | 中文 13px × 1.45 ≈ 19px |
| 行高（控件） | 开关行 36 / 列表行 40 / Tab 32 / 按钮 30 | 现状多数 28–29，普遍偏挤 |
| 描边 | 0.5px（`border`），**不用** `height:1px` + 背景 | 已在 `.about-divider` 的注释里记过原因 |
| 阴影 | **三件套照搬**：`stroke` = `0 0 0 .5px <line>`；`panel` = stroke + `0 3px 8px rgba(0,0,0,.03)` + `0 0 16px rgba(0,0,0,.02)`；`prominent` = stroke + `0 3px 8px .04` + `0 0 20px .05` | 描边藏在阴影里 ⇒ 组件必须 `border: 0`；卡片 / 按钮仍无阴影 |
| 动效 | 120ms `ease-out`，只动 `background-color` / `color` / `transform` | 既有 150ms，缩短一档；加 `prefers-reduced-motion` 归零 |
| 字体 | 系统栈不变（`--pluma-font-sans`） | 不引入 webfont（02 §6） |
| 图标 | 内联 SVG，1.5px 描边，14/16px 两档 | 替换 `▸` `‹` `×` 三个字符箭头 |

### 3.3 字重

**中文只有 400 / 600 两档可用**：微软雅黑 / 苹方没有真 500，
浏览器用合成加粗补 500，在小字号下发虚、在 1.25x 缩放下发毛。

| 用途 | 字重 |
| --- | --- |
| 主句、标题、账号名、解锁结论 | 600 |
| 正文、hint、说明 | 400 |
| 数字（版本号、时间、百分比） | 400 + `tabular-nums` |

---

## 4. 组件标准

> 每个组件写四件事：**结构 / 度量 / 状态 / 禁止**。
> 类名一栏是**测试契约**（现有 135 个测试文件里有 `querySelector('.row')` 这类直接引用），
> 标 🔒 的类名**不许改名**，只能加修饰类。

### 4.1 浮层壳（`PanelShell`）

```text
▏                        ← 静息：8px 贴边条（宽度不动，ADR 0033 实测依据）
┌────────────────────────────┐
│ Pluma                  ×   │  ← 头：22px 高，标题 15/600，右上 24×24 无边框图标按钮
├────────────────────────────┤  ← 唯一一条横贯发丝线
│ 画质  净化  显示  账号  关于 │  ← Tab 32px，激活=蓝字 + 2px 蓝下划线
├────────────────────────────┤
│ （内容区，可滚动）           │
└────────────────────────────┘
```

| 项 | 现状 | 改为 |
| --- | --- | --- |
| 底板 | 纯白 + 0.5px 四边描边 + `0 4px 16px` 投影 | **照搬 DSH 材质**：70% 填充 + `blur(40px) saturate(150%)` + 藏在阴影里的 0.5px 描边 |
| 头与 Tab 之间 | `.sheet-head` 自带 `border-bottom`，`.tabs` 又自带 `border-bottom` | 合并为**一条**（两线相距 6px 时看起来像"双层表格线"） |
| Tab 样式 | 激活 = 圆角浅蓝底 + 600 | 激活 = 蓝字 + 2px 下划线（参考图），hover = 文字转主色 |
| Tab 宽度 | `flex:1 1 0`，5 格各 ~48px | 保持等分；**建议面板加宽到 300px**（§11 待裁决 B） |

🔒 类名：`.panel` `.strip` `.sheet` `.sheet-head` `.sheet-title` `.close` `.tabs` `.tab` `.tab-dot` `.panel-content` `.panel-body`

**落地的 CSS（可直接抄进 `tokens.css` + `PANEL_CSS`）：**

```css
/* ── tokens.css：材质与 elevation 三件套 ── */
--pluma-menu-fill: rgba(252, 253, 254, 0.7);   /* 深色：rgba(48, 49, 54, 0.64) */
--pluma-menu-blur: blur(40px) saturate(150%);
--pluma-elevation-stroke: 0 0 0 0.5px var(--pluma-line);
--pluma-elevation-panel:
  var(--pluma-elevation-stroke), 0 3px 8px 0 rgba(0, 0, 0, 0.03), 0 0 16px 0 rgba(0, 0, 0, 0.02);

/* ── PANEL_CSS：把 border 换成"阴影里的 0.5px" ── */
.sheet {
  position: relative;
  isolation: isolate;
  border: 0;                                    /* ⚠️ 与 elevation 二选一 */
  border-radius: 0 var(--pluma-radius-card) var(--pluma-radius-card) 0;
  box-shadow: var(--pluma-elevation-panel);
  background: transparent;                      /* 底色由 ::before 铺 */
}
```

`.sheet::before` 就是 §2.2 那一层，**一个字都不用改**。

**三个保护（缺一不可）：**

| # | 保护 | 做法 | 为什么 |
| --- | --- | --- | --- |
| ① | 不支持就退回实色 | `@supports not (backdrop-filter: blur(1px))` → `background: var(--pluma-canvas)`，`::before{display:none}` | 内核不认时不能只剩一层 70% 透明 |
| ② | 尊重"减少透明" | `@media (prefers-reduced-transparency: reduce)` → 同上 | 系统级无障碍偏好 |
| ③ | 播放/直播页可整块降级 | 宿主加 `data-surface="opaque"`，CSS 走实色分支 | 40px 模糊要重采样播放器那一层，真机掉帧时不能只有"改代码"一条路 |

> v1 只支持 Chrome + Edge（AGENTS §3 第 9 条），所以不写 `-webkit-` 前缀 ——
> DSH 自己也没写。若将来破例支持 Safari，回退分支已经兜住了。

**两条作用域限制（别套错）：**

1. **贴边条（`.strip`）不套材质** —— 8px 宽看不出模糊，纯属每帧白花钱。
   它继续用"半透明 surface + 0.5px 边"，与 `has-update` 的强调色逻辑不变。
2. **popup / 更新窗 / 登录窗 / 无痕页不套材质** —— 它们是**独立文档**，
   背后是空窗口，模糊没有东西可采样，只会白付合成成本。这四块用实色 canvas。

**禁止**：给 `.sheet` 加 `border-radius` 之外的装饰边、给 Tab 加选中阴影、
把「关于」红点改成数字（02 §5.3 反模式）。

### 4.2 Tab 内容骨架（`Pane`）

| 项 | 值 |
| --- | --- |
| 结构 | `section` 语义容器，`display:flex; flex-direction:column` |
| 组间距 | **12px**（唯一值，取代 `.about-pane` 的局部补丁） |
| 组内间距 | 4px（同一块内的行）/ 6px（同一组的控件之间） |
| 首屏 | 顶部不留额外 margin —— 那条发丝线已经是分隔 |
| 滚动 | 内容区自己滚（`.panel-content`），头与 Tab 不滚 |

🔒 类名：`.tab-pane`（`.about-pane` 保留为兼容别名，内部不再有独立 gap）

### 4.3 分段标题（`SectionHeader`）

```text
子智能体   44 已完成 · 3 未运行
└ 13/600 ┘ └ 11/400 muted，与标题同一个基线 ┘
```

| 项 | 值 |
| --- | --- |
| 高度 | 20px（行内基线对齐，不是块） |
| 左右 | 左标题 600；右侧计数/说明 11px muted |
| 用途 | 替代现在混用的 `.diag-section`（它同时被当"节标题"和"卡内标题"用） |

🔒 类名：`.diag-section` 保留（诊断/关于都在用），新增 `.section-head` 承担新语义；
**两者不许同时用于同一个元素**（现在 `about-meta-title` 就是 `.diag-section` 加两个类在改权重，属于同一问题的补丁）。

### 4.4 状态点行（`StatusRow`）—— **本次新增的主力组件**

参考图的核心视觉单元，用来承载"一组同类事实/条目"：

```text
●  一级标题（13/600，单行省略）
   二级说明（11/400 muted，可省略）
                              94.8k tok
                              3 小时 05 分 16 秒
```

| 项 | 值 |
| --- | --- |
| 左列 | 6px 圆点，`margin-top:6px` 与首行基线对齐；颜色 = ok / warn / bad / muted（muted = 无点，留 6px 空位） |
| 中列 | `flex:1 1 auto; min-width:0`（必须 `min-width:0`，否则省略号不生效） |
| 右列 | `flex:0 0 auto`，右对齐，`tabular-nums`，最多两行 |
| 行高 | min 40px，行间 0（靠 padding 8/0 撑开），**不加分隔线**（D1） |
| 点不可点 | 它是状态，不是按钮。要可点就整行 `role="button"` + hover 底色 |

**首批落点**（不改判据、只改呈现）：诊断的「事实」行、关于的「更新」三行元信息、
贡献者清单、净化子项的状态。

> ⚠️ **不许把它用成"装饰性列表"**：没有状态含义的条目（如 9 个分类开关）继续用
> `SwitchRow`，不套圆点 —— 圆点一旦泛滥就失去"状态"语义（D3）。

### 4.5 信息卡（`InfoCard`）

**降级为"只在需要边界时用"**。参考图的平板语言里，卡是例外不是默认。

| 项 | 值 |
| --- | --- |
| 何时用 | 内容需要与上下文**强隔离**：解锁画质卡（价值锚点）、二维码卡、更新版本卡 |
| 何时不用 | 一组开关、一组元信息、一组列表 → 用 `SectionHeader` + 留白 |
| 底 | `--pluma-card`（半透明，让材质透出来），**无描边**，圆角 10，内边距 10/12 |
| 卡头 | 左 13/600，右 11 muted 或胶囊，基线对齐 |

🔒 类名：`.unlock-card` `.unlock-head` `.unlock-title` `.unlock-anchor` `.about-meta` `.about-meta-head`

### 4.6 开关行（`SwitchRow`）

| 项 | 现状 | 改为 |
| --- | --- | --- |
| 高 | padding 6/8 → 约 44px（两行） | min 36px，padding 8/8 |
| 底 | 透明 + hover 8% 灰 | hover `--pluma-accent-soft`（与可点区域统一） |
| 开关 | 34×18，圆点 14 | 36×20，圆点 16（与 popup 统一，现在两处尺寸不同） |
| 触控区 | 整行 = label | 保持 |
| 两种灰 | `dim` 整行 0.5 / 只 `disabled` 表盘 0.5 | **不改**（02 §5.2 的硬约定） |

🔒 类名：`.row` `.row-label` `.row-hint` `.row.dim` `.switch` `.switch.on` `.switch.busy` `.knob`

**禁止**：把 `dim` 用来表示"读取中"；把开关画成"关"来表示"未知"（02 两处都明令）。

### 4.7 按钮四档

| 档 | 视觉 | 用在哪 | 类名 |
| --- | --- | --- | --- |
| 主（Primary） | 实心 `--pluma-accent`，白字 | 一个区块内**只有一个**：「立即更新」「扫码登录」 | `.acct-btn.accent`（沿用，🔒） |
| 次（Secondary） | 透明底 + `--pluma-line` 描边 | 「检查更新」「重新登录」「退出」 | `.acct-btn`（🔒） |
| 危险（Danger） | 透明底 + danger 描边 + 600 | 两步确认的第二步「确认退出」 | `.acct-btn.danger`（🔒） |
| 文字（Quiet） | 无底无边，muted → hover 主色下划线 | 「GitHub Releases」「查看日志」 | `.btn-link`（🔒） |

统一度量：高 30px、圆角 8、字号 12、横向 padding 10。
**并排规则不变**：两个中文四字按钮并排（`.acct-actions`），英文外链降为文字链接 ——
**不许存在第二份并排规则**（02 §5.3 已明令）。

**禁止**：添加"加载中"文案替换（更新窗口的主按钮文案恒为「立即更新」，
状态只靠 enabled/disabled 表达 —— 02 §5.3 已定）。

### 4.8 状态胶囊 / 状态点 / 徽章

三种载体，**语义不同，不许互换**：

| 载体 | 表达 | 何处 | 色调 |
| --- | --- | --- | --- |
| 胶囊 `pill` | **整机状态**（一条结论） | 画质 Tab 顶部、更新卡头「有新版本」 | neutral / good(绿) / warn / bad |
| 圆点 `dot` | **单条事实的状态** | StatusRow 左列 | ok / warn / bad / 无 |
| 徽章 `badge-chip` | **能力项**（4K / 60fps / Hi-Res） | 解锁卡 | 统一 `accent-soft` + accent 文字 |

| 胶囊规格 | 值 |
| --- | --- |
| 高 | 18px；padding 2/8；字号 11；圆角 999 |
| good | `ok` 18% 底 + `ok` 文字（**不再用蓝**） |
| neutral | 16% muted 底 + 主文字 |
| warn / bad | 18% 底 + 对应色文字（沿用现状配方） |

🔒 类名：`.pill` `.pill-neutral` `.pill-good` `.pill-warn` `.pill-bad` `.badge-chip` `.tab-dot`

### 4.9 导航：Tab 栏 / 二级返回条 / 二级入口

| 组件 | 形态 | 交互 |
| --- | --- | --- |
| Tab 栏 | 等分 5 格，32px 高，激活 2px 下划线 | 点击切换；**不做**滑动指示器（面板里没有横向滚动） |
| 二级返回条 `SubBar` | `‹` 图标 + 标题，**不再出「‹ 返回」三个字** | 点击返回栈 |
| 二级入口 `SubEntry` | 整行：左标题 + 中 muted 摘要 + 右 `›` 图标 | 整行可点，hover 底色 |

🔒 类名：`.sub-bar` `.sub-back` `.sub-title` `.sub-entry` `.sub-entry-hint` `.sub-entry-chevron`

**替代字符**：`▸` → 内联 SVG `chevron-right`；`‹ 返回` → `chevron-left` + 文字「返回」（图标 + 文字，
图标不是替换文字，是为了让"返回"在任何字号下都对得上基线）。

### 4.10 反馈：底部提示 / 行内说明 / 未知态

| 组件 | 规则 |
| --- | --- |
| `NoticeBar`（`.panel-notice`） | 成功 5s 自动消失；**失败常驻**（`NOTICE_TTL_MS` 的注释已定）；底色 = accent-soft / danger 14% |
| `InlineNote`（`.pane-note`） | 11px muted，`warn` 变体用 `--pluma-warn`；**一句一条**，不写段落 |
| 未知态 | 必须给"读不到"+"一个用户真能做的动作"，**不许落回默认值**（02 §5.3 四态表） |

🔒 类名：`.panel-notice` `.pane-note` `.pane-note.warn` `.pane-line`

---

## 5. 页面改造清单

优先级用**高 / 中 / 低**（⚠️ 不写 P0–P2：会与 04 §6 的「阶段 P0–P3」撞符号，02 §9 有前车之鉴）。

| # | 界面 | 改什么 | 优先级 | 依赖 | 风险 |
| --- | --- | --- | --- | --- | --- |
| S0 | `tokens.css` | 令牌 v2 全量替换 + 新增 ok/sunken/line 三组 | **高** | — | 低（值域变化，无结构变化） |
| S1 | 面板壳（`sidebar.ts`） | 底板换**材质**（70% + 40px + 阴影描边）、头与 Tab 合并成一条线、Tab 改下划线式、加 24×24 图标按钮 | **高** | S0 | **中**：`.tab.active` 被测试引用；贴边条不动；模糊要真机测帧率 |
| S2 | 画质 Tab | 胶囊改绿、解锁卡去描边、badges 统一、开关行度量 | **高** | S1 | 低（纯视觉） |
| S3 | 账号 Tab | A/B 卡改"分档底"而不是"灰/蓝底"、头像 24→28、胶囊独立行保留、按钮四档 | **高** | S1 | 中：`.acct-main` 的 154→229 实测结论不能被推翻 |
| S4 | 「关于」Tab | 元信息卡改 StatusRow + SectionHeader、删掉 `.about-pane` 的 gap 补丁 | 中 | S0 | 低 |
| S5 | 「净化」/「显示」Tab | 节标题统一、10 个开关行度量、二级入口图标化 | 中 | S1 | 低 |
| S6 | 首页净化 / 诊断（二级） | 返回条、日志块改 `sunken`、事实行改 StatusRow | 中 | S4 | 低 |
| S7 | 更新窗口 | 步骤卡去描边、主按钮统一 30px、`<details>` 摘要加图标、progress 换细条 | 中 | S0 | 低 |
| S8 | popup | 标题条与面板同构、开关行 36px、提示改 InlineNote | 中 | S0 | 低（360px 宽不动） |
| S9 | 登录窗口 | 二维码卡改 `sunken`、状态行加状态点、刷新按钮改次级 | 中 | S0 | 低 |
| S10 | 无痕权限页 | 标题层级、3 步动作改编号点、`<details>` 样式 | 低 | S0 | **高**：有文案字数断言（≤150 字可见文本），只许动样式 |
| S11 | 页内角标 | 胶囊改 canvas 82% 底、展开浮层用 StatusRow | 低 | S0 | 中：播放器上叠加，必须真机看 |
| S12 | 深色模式 | 全量走一遍（暗色下"档位差"是唯一分层手段） | 中 | S1–S6 | 中 |

**顺序理由**：S0 不动任何结构 → S1 只动壳（一次只改一个变量）→ S2/S3 是用户最常看的两屏，
先出效果 → 其余按"看的人多少"排。S10 有文案断言，放最后，避免和视觉改动混在一起归因。

---

## 6. 实施阶段（每阶段可独立交付、独立回滚）

### Stage 0 · 立规矩（不改视觉）—— **已完成 2026-11-16**

| 项 | 内容 |
| --- | --- |
| ① 令牌 | `src/design/tokens.css` 新增 22 个 v2 名字（材质 / elevation / 间距 / 高度 / 字重 / 动效 / 图标）。**旧声明一行没删、一个值没改**（`git diff` 里只有 `+` 行）。文件末尾带「翻转清单」：哪一阶段给哪个名字换值。 |
| ② 契约 | `tests/unit/design/ui-class-contract.test.ts`（15 条）：73 个 🔒 类名 + 11 个复合选择器 + "面板样式不许裸 hex" + "v2 令牌深浅两套齐备"。改名 → 变红，已反例验证。 |
| ③ 截图 | **未做**（见下）。 |
| 为什么先做 | 没有基线就没有"改完对比"，而本项目的验收纪律要求**能复现旧状态**（AGENTS §1.5） |
| 退出条件 | `node scripts/verify.mjs` 21 项全绿；`node node_modules/wxt/bin/wxt.mjs build` 通过（381.77 kB）；单测 136 文件 / 2279 条全绿 |
| 视觉等价怎么证明 | 不是靠截图，是靠**构造**：新增的全是自定义属性，而"没被引用的自定义属性不产生任何渲染效果"。判据命令：`grep -rn "pluma-menu-fill\|pluma-line\|pluma-ok\|pluma-elevation" src entrypoints \| grep -v tokens.css` **必须为空** |
| 回滚 | 删掉 `tokens.css` 里的 v2 块（契约测试同时删） |

⚠️ **③ 基线截图为什么没做**：`bsk` 的 daemon 在这个 shell 里起不来
（Job Object 不允许 breakaway，`bsk browsers` 直接报 os error 5）。
按 `docs/guides/browser-skill-setup.md` 需要 `bsk daemon start --foreground`
挂在常驻宿主里，再从独立终端连。

**这不阻塞 Stage 0**：改动的"零视觉影响"已经由构造证明（上面的 grep），截图是为了
**Stage 1 之后**能对比，所以它必须在 Stage 1 第一个视觉 commit **之前**补上 ——
已记进 Stage 1 的退出条件。

> 基线截图用 `bsk`（真实登录态）+ 明/暗两次；命令与坑见 [browser-skill-setup.md](../guides/browser-skill-setup.md)。
> 无登录态的界面（更新窗、无痕页）用 CDP，不需要登录态。

### Stage 1 · 壳 —— **代码已完成 2026-11-16（真机实测待补）**

| 项 | 内容 |
| --- | --- |
| 前置 | **先补 Stage 0 的 ③ 基线截图**（明/暗各一套）。没有"改前"，后面几个 commit 的"好看多了"都无法复核 |
| 改动文件 | `sidebar.ts`（`PANEL_CSS` 的 `.sheet/.sheet-head/.tabs/.tab/.close` 段）、`panel.ts` / `tabs.ts`（只同步宽度注释）、`dom.ts`（新增 `iconClose()`） |
| 一次只改一个变量 | ① **材质**（含 `@supports` 回退）② **宽度** ③ 线合并 ④ 线色 ⑤ Tab 下划线 ⑥ 图标按钮 —— **六个 commit**，各自带截图（截图待补） |
| 退出条件 | ① 的 commit 必须附**一条实测**：真机里 `getComputedStyle(sheet).backdropFilter` 有值、截图能看到背后内容被模糊（不是纯半透明），并记下播放页/直播页帧率；其余：5 个 Tab 都能切换；红点在「关于」上不跑偏；贴边条 `has-update` 仍可见；面板不遮挡播放器控件区 |
| 回滚 | `git revert` 单个 commit |

**实际交付（6 个 commit）：**

| commit | 内容 |
| --- | --- |
| `db37617` | 底板换材质：`::before` 铺 70% + `blur(40px) saturate(150%)`，`border: 0` + `--pluma-elevation-panel`，两条回退 |
| `f1a655f` | 280 → 300px，同步四处按旧宽度写的注释 |
| `3814915` | 删掉 Tab 行那条线（只留头部一条） |
| `d126a4d` | 修上一提交在 CSS 模板里误用的反引号（见下方坑） |
| `1f10824` | 头部那条线换 `--pluma-line`（10%） |
| `be0b165` | Tab 改下划线式（蓝字 + 2px，无底色；2px 透明占位防跳动） |
| `d832ce4` | 关闭按钮换内联 SVG，命中区 20 → 24px；顺带加"模板里禁第二个反引号"的守卫 |

⚠️ **踩到的坑（已写成测试）**：`PANEL_CSS` 是模板字符串，在它里面写注释时用了
Markdown 反引号（`` ` ``）会把字符串提前截断 —— 当天踩了两次，第二次还因为
`prettier --check ... | tail` 的退出码取自 `tail` 而**误提交**（HANDOFF 里记过同一条）。
现在 `tests/unit/design/ui-class-contract.test.ts` 有一条守卫盯着这件事。

### Stage 2 · 内容组件

| 项 | 内容 |
| --- | --- |
| 改动文件 | `dom.ts`（`switchRow` / `pill` 度量）+ `tabs.ts` 里逐 Tab 的类名与结构 |
| 关键顺序 | 先 `switchRow`（5 个 Tab 都用）→ 再 `pill` → 再 `StatusRow`（新组件，先在「关于」试点） |
| 退出条件 | 每个 Tab 在**未知态 / 无数据态 / 正常态**三种模型下都不破版（喂 `null` 看空态） |
| 回滚 | 按组件 revert |

### Stage 3 · 5 个 Tab

每个 Tab 一个 commit，顺序：画质 → 账号 → 关于 → 净化 → 显示。
每个 commit 必须带一张"改前/改后"真机截图（dark 可选，light 必做）。

### Stage 4 · 独立窗口

更新窗 → popup → 登录窗 → 无痕页。三者互不依赖，可并行。
**无痕页只许改 CSS**（`tests/unit/content/need-incognito-copy.test.ts` 断言可见文本 ≤150 字）。

### Stage 5 · 收口

| 项 | 内容 |
| --- | --- |
| 删旧 | 删掉 Stage 0 保留的旧变量别名、`.about-pane` 的 gap 补丁、`▸/‹/×` 字符用法 |
| 写回 | 把 §4 的规则写进 [02-ui-spec.md](../02-ui-spec.md) §6（**只写规则与角色，不抄 hex**，值以 `tokens.css` 为准） |
| 补决策 | 写 ADR 0037「底板改用半透明材质」：记**模糊的性能代价**与三条回退，并在 `docs/README.md` 的 ADR 表登记（`check-adr-index` 会断言两边一致） |
| 深色 | 逐屏核一遍对比度与档位差 |
| 退出条件 | §9 验收全过 + `node scripts/verify.mjs` 全绿 |

---

## 7. 兼容与适配（踩过的地方，逐条对应）

| # | 约束 | 对改版的含义 |
| --- | --- | --- |
| 1 | **Shadow DOM `closed`** | 变量不穿透：`tokens.css?raw` 必须继续塞进 shadow；`:host,:root` 双选择器**不许删**（`host.ts` 有整段解释） |
| 2 | **类名是测试契约** | `.row` `.acct-btn` `.sub-entry` `.tab` `.strip` `.panel-notice` `.acct-row.playback .acct-sub` 被 `querySelector` 直接引用；改名 = 同 commit 改测试，且要在 PR 说明里写清"契约变更" |
| 3 | **文案是契约** | `CLEAN_OPTION_META`、`NOTICE_LOGOUT_OK`、`data-testid="update-*"`、无痕页 ≤150 字断言 —— 视觉改版**一行文案都不许动**；要改文案另开一轮 |
| 4 | **两种灰** | `dim`（本质不可用）vs 只 `disabled`（此刻不可操作）是硬约定，视觉重排**不许合并成一个灰** |
| 5 | **280px 是实测定的** | 加宽要真机复测直播页/番剧页左侧遮挡；贴边条 8px 与 `z-index:2147483647` **不许动**（ADR 0033 阶段 0 实测） |
| 6 | **不许第二份相同规则** | 并排按钮只有 `.acct-actions`；卡片只有 `.unlock-card`/`.about-meta` 两款；新增前先搜一遍 `PANEL_CSS` |
| 7 | **无新依赖** | 图标用内联 SVG；不用 Tailwind/图标字体/CSS-in-JS（AGENTS §7：加依赖先问） |
| 8 | **性能** | 材质是 `blur(40px)`，**每帧都要重采样背后的内容** —— 播放/直播页必须真机测帧率；掉帧就走 `data-surface="opaque"` 降级。过渡只限颜色与 transform；不新增 `ResizeObserver` |
| 9 | **暗色 ** | `color-scheme: light dark` 已在；暗色下**不许**靠描边分层（暗底上 0.5px 白线会发光），只靠档位差 |
| 10 | **中文度量** | 字重只有 400/600（§3.3）；`tabular-nums` 给数字；`letter-spacing` 只给英文品牌名 |
| 11 | **无障碍** | 图标按钮必须有 `aria-label` 且跟状态变（`strip` 已有先例）；`focus-visible` 环 2px accent；11px 文字对比度 ≥4.5:1；`hover` 规则包进 `@media (hover: hover)`（触摸设备上 hover 会"卡住"） |
| 12 | **与页面共存** | 不引入全局 reset；`*{box-sizing}` 只在 shadow 内；所有交互点继续 `stopPropagation()` |

---

## 8. 验收标准

**分四类，缺一不算过。**

### 8.1 可机器验证

| 项 | 判据 |
| --- | --- |
| 测试 | `pnpm test`（135 个文件）全绿；**改类名的 commit 必须同时改测试** |
| 构建 | `pnpm build` 通过；`node scripts/verify.mjs` 全绿 |
| 令牌纯净 | `grep -rn "#[0-9a-fA-F]\{3,6\}" src/content/panel/ entrypoints/*/style.css` **只允许出现在 `tokens.css`** |
| 单一规则 | `grep -c "acct-actions"` 在 `PANEL_CSS` 里只有 1 处定义 |
| 文档 | `node scripts/verify.mjs --fast` 全绿（死链/篇幅/连号） |

### 8.2 视觉验收（人工，逐屏）

| 屏 | 必看 |
| --- | --- |
| 面板 · 5 Tab | 组间距 > 组内间距；同一屏最多 2 个"有边界"的块；Tab 激活只有下划线+蓝字 |
| 面板 · 未知/无数据态 | 不出现"已是最新"这类默认值；空态有话说、有动作 |
| 面板 · 二级 | 返回条不挤压标题；日志块 `sunken` 底，长行不撑破 |
| popup | 360px 无横向滚动；开关行 36px；提示不抖高度 |
| 更新窗 | 440px 内只有一个实心按钮；`<details>` 收起时不占首屏 |
| 登录窗 | 二维码 300px 不被裁；状态点颜色跟状态 |
| 无痕页 | 正文 ≤150 字（断言在测）；只有一处技术理由 |
| 角标 | 不遮挡播放器控件区；展开浮层不超出视口 |

### 8.3 真机回归（5 场景 × 明暗）

视频页 / 番剧页 / 直播页 / 首页 / InPrivate 各一次，检查：

- 面板展开不遮挡播放器 `right`/`bottom` 控件区
- 首页点击面板不跳转（`stopPropagation` 仍生效）
- 收起/展开无抖动（高度不跳）
- 暗色下面板与 B站 暗色页面不糊成一片

### 8.4 回归清单（旧 bug 不许复现）

| 旧 bug | 复验方式 |
| --- | --- |
| 诊断后面板消失（钉住态失效） | 点「诊断 ▸」→ 鼠标移开 → 面板应停留 |
| 点面板内部被当成"点外面" | 点任意 Tab → 面板不收起 |
| 关于页进即 dismiss 导致红点误清 | 进「关于」→ 红点消失但「立即更新」**仍可点** |
| 更新窗更新完变空白页 | 走一遍真机更新（需造假起点，见 HANDOFF） |
| 没有账号时开关"灰得不明显" | 退出账号 → 推荐流开关**整行淡** |
| 昵称被胶囊挤断 | 账号 Tab 长昵称 + 长到期日不出现省略号 |

---

## 9. 维护规则（以后加东西按这个来）

### R1 值的唯一真相源

| 内容 | 权威位置 |
| --- | --- |
| 颜色 / 间距 / 圆角 / 字号的实际值 | `src/design/tokens.css` |
| 组件的结构与用法规则 | `docs/02-ui-spec.md` §6（**只写角色与规则，不抄 hex**） |
| 本次施工顺序与验收 | 本文件（验收后归档，不再更新） |

> 这是对 AGENTS §6.1 的一次**收紧**：现在 02 §6 表里写着一份 hex，
> `tokens.css` 里写着另一份 —— 两份必然漂移。改版后 hex 只留在 `tokens.css`。

### R2 新增组件前必须回答的 5 问

1. 现有组件里有没有能直接用的？（先读 §4 清单，再 `grep PANEL_CSS`）
2. 它是不是**只是换个皮**的同一个东西？（若是，加修饰类，不新建）
3. 它有没有**状态矩阵**？（默认 / hover / active / disabled / busy / 未知）
4. 它的**未知态**说什么？（不许落默认值）
5. 它会不会成为**第二份相同规则**？（并排按钮、卡片、分组标题最容易犯）

五问里任何一个答不上来 → 先报告，不要自己发明（AGENTS §7）。

### R3 视觉变更的准入三问

| 问 | 不合格的例子 |
| --- | --- |
| 这个装饰在回答"我现在应该担心吗"吗？（02 §0 铁律） | 加一条渐变分隔线提升"精致感" |
| 它用的是已有令牌，还是新造了一个值？ | 为了一张卡写 `#f7f8fa` |
| 暗色下它还成立吗？ | 用 0.5px 白线分层 |

### R4 三条长期禁令（本次改版确立）

1. **一个区域最多一层底**：不许"底 + 卡 + 卡内块"三层背景叠着上色。
2. **一个区块只有一个主按钮**：主按钮用实心，其余降级；同一屏两个实心按钮 = 没有主次。
3. **状态只用点/胶囊/徽章三载体**，不新造第四种（比如"彩色左边条"）。

### R5 交付纪律

- **一次只改一个视觉变量**，一个 commit 一件事（否则真机反馈无法归因 —— 这是 2026-11-10 那轮
  "胶囊挪出卡片 + 缩写文案"同时改、复测后无法归因的教训，`tabs.ts` 里有原话）。
- 每个视觉 commit 带一张真机截图（light 必做）。
- 改完跑 `node scripts/verify.mjs`；只改文档跑 `--fast`。
- **不许顺手改文案**：文案改动走独立一轮，因为多条文案是被用户裁决钉死的（见 §7 第 3 条）。

---

## 10. 六件待拍板的事 —— **已拍板（2026-11-16）**

> 用户原话：「§10 的 A–F 六条就按你建议的来」。裁决结果：
> **A 改绿 · B 加宽到 300px · C 改下划线 · D 先保持 #378ADD · E 升为全局规则 · F 不搬 corner-shape**。
>
> 已落地：B（`f1a655f`）、C（`be0b165`）。未落地：A / D 属 Stage 2 的换色，
> E 属 Stage 2 的 `.tab-pane` 全局 gap —— 换色必须单独成 commit，不能和结构改动混。

| # | 问题 | 选项 | 我的建议 |
| --- | --- | --- | --- |
| A | 「已接管 / 正常」用**绿**还是继续用蓝？ | ① 绿（参考图语义：绿=事实正常，蓝=交互）② 保持蓝 | **①**，但要接受"蓝色只剩交互"这一语义收窄 |
| B | 面板宽度 280px 是否加到 300px？ | ① 不动 ② +20px | **②**，因为 5 个 Tab + 36px 开关行 + 两级文字在 280px 里已经贴边；代价是要真机复测遮挡 |
| C | Tab 从"浅蓝圆角底"改成"下划线"？ | ① 下划线（参考图）② 保持圆角底 | **①**，下划线在 5 格等分时更省横向空间，也更像"查看器" |
| D | 强调色从 `#378ADD` 改到 `#3E77F0`（参考 `#4881FA` 压一档）？ | ① 改 ② 保持 | **②先保持**也行 —— 但若选 ①，必须在暗色下重新核对比度 |
| E | 「关于」的 `about-pane` 局部 gap 补丁是否升级为全局规则？ | ① 升级（`.tab-pane` 全局 12px）② 保持局部 | **①**，否则每加一个 Tab 都要再打一次补丁 |
| F | 连 `corner-shape`（超椭圆圆角）一起照搬？ | ① 不搬 ② `@supports` 包一层 | **①**：DSH 有它的 spec 兜底，我们只有圆角规范，收益小、支持面窄 |

---

## 11. 明确不做的（范围外）

| 不做 | 为什么 |
| --- | --- |
| 不做"主题设置"（让用户选色/选密度） | 02 §0：界面是查看器不是操作台；多一个设置项就多一份要维护的组合 |
| 不改任何功能判据、状态机、文案 | 本次只做视觉；判据改动风险远高于收益，且多条已被用户裁决钉死 |
| 不加动画/转场（除 120ms 颜色过渡） | 面板注入在别人页面上，动效会与页面自己的动画抢注意力 |
| 不引入组件库 / 图标字体 | AGENTS §7：新依赖要先问 |
| 不改贴边条 8px、`z-index`、Shadow DOM 模式 | 三处都有真机实测依据（ADR 0033） |
| 不做响应式（面板不随窗口缩放变宽） | 它是浮层，不是页面；宽度变化会破坏"不遮挡"的实测结论 |

---

## 12. 一页速查（贴墙版）

```text
底板：70% 材质 + blur(40px) saturate(150%)，描边在阴影里，不叠白卡
线：0.5px 发丝，禁 1px 背景线           分组：组间 12，组内 4/6
圆角：卡 10 / 控件 8 / chip 6 / 胶囊 999  字：15/13/11，字重 400/600（没有 500）
数字：tabular-nums，右对齐               强调：蓝只给"当前/可执行"
状态：绿点=正常，胶囊=整机结论，徽章=能力   阴影：只给浮层，且第一层是描边
图标：内联 SVG 1.5px，禁字符箭头与 emoji   未知：说"读不到"+给动作，绝不落默认值
灰：dim=本质不可用，disabled=此刻不可用    透明：不支持的退回实色
```
