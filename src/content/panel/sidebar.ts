/**
 * 页内侧栏面板的**骨架**：静息态贴边条 → 展开态面板。
 *
 * ## 本阶段只做"壳"（1.1.0 阶段 1）
 *
 * 面板内容（画质 / 净化 / 账号三个 Tab）全部留到后续阶段。
 * 现在展开态里**只有标题和一个关闭按钮**，外加一句醒目的占位 ——
 * 刻意不放假开关：渲染一个点了没反应的控件，比渲染一句"还没做"更糟。
 *
 * ## 形态依据（ADR 0033 决定一）
 *
 * ```text
 * 静息：  ▏            ← 8px 宽的贴边条，鼠标移入 / 点击才展开
 * 展开：  ┌──────────┐
 *         │ Pluma  × │
 *         │ （骨架）  │
 *         └──────────┘
 * ```
 *
 * 左侧贴边而不是右下角：右下角被播放器控制栏占满，且页内角标
 * （`badge.ts`，`right:16px;bottom:96px`）已经在那里了。
 *
 * ## 为什么用 `mouseenter` / `mouseleave` 而不是 `mouseover` / `mouseout`
 *
 * `mouseover` 在子元素之间移动**也会触发**（冒泡），鼠标每划过一行内部元素
 * 面板就"重新展开一次"，表现为展开动画抖个不停。`mouseenter` / `mouseleave`
 * 不冒泡，一个进出只触发一次。
 *
 * ## 为什么要停止事件冒泡
 *
 * 面板浮在 B站 页面之上，点击会经 DOM 冒泡被页面自己的监听器接住
 * （首页推荐卡片的跳转、播放器的点击暂停）。所以每个交互点都要
 * `stopPropagation()`，与 `badge.ts` 的做法一致。
 */

import { iconClose } from './dom';

/** 面板自己的样式。**全部用 `tokens.css` 的变量，不许硬编码颜色**（`02-ui-spec.md` §6） */
export const PANEL_CSS = `
.panel {
  display: flex;
  align-items: stretch;
  font-family: var(--pluma-font-sans);
  user-select: none;
}

/* ── 静息态：8px 贴边条 ──
   宽度 8px 来自 ADR 0033 决定一。只有这一条接收鼠标事件（宿主是 pointer-events:none），
   所以它不会挡住页面左侧的内容 —— 命中区只有这 8px。

   ## 2026-11-16：贴边条也用材质（用户真机反馈「没有用上新材质，死白一条」）
   方案 §4.1 原本判断"8px 宽看不出模糊，不值得"，**这条判断错了**：
   blur 的采样半径是 40px，磨砂感来自它**周边的页面内容**，不是这 8px 自身 ——
   白页面上"72% 白"确实和"模糊过的白"看不出差别，但在有内容的页面上
   死白一条非常突兀（用户截图为证）。 */
.strip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 8px;
  height: 72px;
  border-radius: 0 var(--pluma-radius-control) var(--pluma-radius-control) 0;
  /* 底色交给 ::before；这里只留边框 —— 8px 的东西没有 elevation，
     一根 0.5px 的真边框就够（DSH 规则：真 border 与 elevation 不并存，这里没有后者） */
  background: transparent;
  border: 0.5px solid var(--pluma-border);
  border-left: none;
  cursor: pointer;
  pointer-events: auto;
  position: relative;
  isolation: isolate;
}

/* 与 .sheet 同一份材质。hover 靠把材质调"实"来表达（混 20% surface），
   不再像旧版那样整块换底色 —— 那在磨砂语言里等于闪一下。 */
.strip::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: var(--pluma-menu-fill);
  backdrop-filter: var(--pluma-menu-blur);
  pointer-events: none;
  transition: background-color var(--pluma-duration) var(--pluma-ease);
}

.strip:hover::before {
  background: color-mix(in srgb, var(--pluma-menu-fill) 80%, var(--pluma-surface));
}

/* 贴边条上的三个点：纯视觉暗示"这里能点"，不是图标字库 */
/* 有新版本：贴边条与它那三个点改用强调色（2026-11-17）。
   这是"用户没打开面板时唯一能看见的提示" —— 角标靠图标是否固定到工具栏，
   红点在面板内部，两者都要求用户先做点什么。
   ⚠️ 不改尺寸、不加新元素：那三个 2px 点本来就是用 box-shadow 画的。 */
.strip.has-update {
  border-color: var(--pluma-accent);
}

.strip.has-update .strip-dot {
  background: var(--pluma-accent);
  box-shadow: 0 4px 0 var(--pluma-accent), 0 -4px 0 var(--pluma-accent);
}

.strip-dot {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: var(--pluma-text-muted);
  box-shadow: 0 4px 0 var(--pluma-text-muted), 0 -4px 0 var(--pluma-text-muted);
}

/* ── 展开态：骨架 ── */
.sheet {
  display: none;
  flex-direction: column;
  /* 300px（2026-11-16 改版，原 280px）：内容区 = 300 − 左右 padding 28 = **272px**。
     五个 Tab 等分后每格约 56px；中文两字 13px 约 26px，余量够。
     原来的 280px 是按"三个 Tab + 一行开关 + 副标题"算的，加到第五个 Tab
     和 36px 高的开关行之后已经贴边。
     ⚠️ 上限仍是 02-ui-spec 的口径：**不许出现横向滚动**；
     再往上加必须重新真机量直播页左侧的遮挡（ADR 0033 阶段 0 那套）。 */
  width: 300px;
  padding: 12px 14px 14px;
  /* 底板 = **一层材质**，不再是"实色 + 描边 + 投影"三件套（2026-11-16 改版，方案 §2.2）。
     材质必须铺在 ::before 而不是 .sheet 上：写在容器上会让后代（二级浮层）拿到
     新的 fixed 包含块，定位整体错位 —— 这是 DSH 「MenuSurface.module.css」 的原话。
     border 也必须为 0：0.5px 描边是 elevation 的**第一层**，两者并存会画成双线。 */
  border: 0;
  border-radius: 0 var(--pluma-radius-card) var(--pluma-radius-card) 0;
  color: var(--pluma-text);
  font-size: var(--pluma-font-body);
  line-height: 1.5;
  pointer-events: auto;
  position: relative;
  isolation: isolate;
  box-shadow: var(--pluma-elevation-panel);
}

/* 材质层：70% 近白 + 40px 模糊（照搬 DSH 的值，见 tokens.css）。
   「inset:0」 + 「z-index:-1」 + 「border-radius:inherit」：只铺在内容下面，且跟着容器圆角走。
   ⚠️ 容器上不许出现 「opacity」 —— 那会让材质停止采样页面，模糊直接失效。 */
.sheet::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: var(--pluma-menu-fill);
  backdrop-filter: var(--pluma-menu-blur);
  pointer-events: none;
}

/* 回退：内核不认 backdrop-filter 时，只剩一层 70% 透明 —— 换成实色。
   v1 只支持 Chrome/Edge（AGENTS §3 第 9 条），但"不认"不等于"不存在"：
   旧内核、被禁用的 GPU 合成都可能走到这里，那时面板会变成"能看见页面文字"。
   贴边条回到改版前的半透明白（没有模糊垫底，72% 白恰好是"隐约可见"） */
@supports not (backdrop-filter: blur(1px)) {
  .sheet {
    background: var(--pluma-surface);
  }

  .sheet::before,
  .strip::before {
    display: none;
  }

  .strip {
    background: color-mix(in srgb, var(--pluma-surface) 72%, transparent);
  }

  .strip:hover {
    background: color-mix(in srgb, var(--pluma-surface) 92%, transparent);
  }
}

/* 系统级"减少透明"偏好：直接给实色，不跟用户对着干 */
@media (prefers-reduced-transparency: reduce) {
  .sheet {
    background: var(--pluma-surface);
  }

  .sheet::before,
  .strip::before {
    display: none;
  }

  .strip {
    background: color-mix(in srgb, var(--pluma-surface) 72%, transparent);
  }

  .strip:hover {
    background: color-mix(in srgb, var(--pluma-surface) 92%, transparent);
  }
}

/* 展开时隐藏贴边条：两者并排会多出 8px 的空隙，看起来像没对齐 */
.panel.open .strip {
  display: none;
}

.panel.open .sheet {
  display: flex;
}

/* ── 钉住态的可视提示（2026-11-10）──
   钉住 = 鼠标离开不会收起。这本身对用户是"面板不会自己跑掉"，
   但**必须让状态可见** —— 否则用户不知道"为什么有时候收起、有时候不收"。
   做法：给面板加一道信息色左边框。颜色走 tokens，不硬编码。 */
.panel.pinned .sheet {
  border-left: 2px solid var(--pluma-accent);
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  /* 面板里**唯一**一条横贯线（2026-11-16 改版：Tab 行那条已删）。
     走 --pluma-line（10%）而不是 --pluma-border（15%）：
     15% 在半透明白底上会显成一道灰杠，10% 才是"发丝"。 */
  border-bottom: 0.5px solid var(--pluma-line);
}

.sheet-title {
  font-size: var(--pluma-font-title);
  font-weight: 600;
  letter-spacing: 0.2px;
}

.close {
  /* 24×24（2026-11-16 改版，原 20×20）：图标按钮的命中区下限。
     「×」字符换成内联 SVG —— 字形在不同中文字体里基线与宽度都不一样，
     控件尺寸不该交给字体（见 dom.ts 的 iconClose）。 */
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--pluma-radius-control);
  background: transparent;
  color: var(--pluma-text-muted);
  font-family: inherit;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color var(--pluma-duration) var(--pluma-ease),
    color var(--pluma-duration) var(--pluma-ease);
}

.close:hover {
  background: var(--pluma-accent-bg);
  color: var(--pluma-text);
}

.skeleton {
  margin: 10px 0 0;
  padding: 10px;
  border-radius: var(--pluma-radius-control);
  background: var(--pluma-accent-bg);
  color: var(--pluma-text);
  font-size: var(--pluma-font-caption);
  line-height: 1.45;
}

/* ── 展开区里的面板主体（阶段 2）──
   尺寸按 02-ui-spec §1：面板比 popup 窄一档，但同样不许出现横向滚动。
   高度给上限 + 纵向滚动：直播页左侧空间有限，内容多了让它自己滚，
   而不是把面板撑到盖住整个页面。 */
.panel-body {
  display: flex;
  flex-direction: column;
  margin-top: 8px;
  max-height: min(420px, calc(100vh - 120px));
}

/* ── Tab 栏 ──
   ## 五个 Tab 放得下（2026-11-16 改版重算；原注释算的是"四个 Tab / 280px"）
   面板 300px 减左右 padding 28px = 272px，再减 4 个 gap（2px × 4 = 8px）= 264px。
   .tab 是 flex 1 1 0，每格 **52.8px**。
   中文「画质」在 13px 字号下约 26px，横向零 padding、纵向 min-height 32px，
   富余 26px —— 不需要缩字号，也不需要改成图标。

   ## 为什么从「浅蓝圆角底」改成「下划线」（2026-11-16）
   参考图实测：激活项 = 蓝字 + 2px 下划线，**没有底色块**
   （截图里 83 个实心蓝像素 ≈ 2px × 40px 的一条，正好是下划线）。
   底色块在五格等分时会把每格都画成一个按钮，整条读起来像工具栏；
   下划线只标记"当前在哪一页"，符合 02 §0 的查看器定位。 */
.tabs {
  display: flex;
  gap: 2px;
  /* 无 border-bottom：整块面板只剩 sheet-head 那一条横贯线。
     这里也不留 padding-bottom —— 下划线与内容之间的呼吸由 .panel-content 的
     padding-top 给，多一层 padding 会让下划线浮在半空。 */
  padding-bottom: 0;
}

.tab {
  /* 红点用绝对定位挂在右上角，所以这里必须是定位上下文 */
  position: relative;
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* border-box：min-height 要含那 2px 下划线，否则切 Tab 时行高会多 2px */
  box-sizing: border-box;
  min-height: var(--pluma-h-tab);
  padding: 0;
  border: none;
  /* 透明下划线占位：激活只换颜色，**不改变行高**（否则每次切 Tab 内容都跳 2px） */
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--pluma-text-muted);
  font-family: inherit;
  font-size: var(--pluma-font-body);
  cursor: pointer;
  transition:
    color var(--pluma-duration) var(--pluma-ease),
    border-color var(--pluma-duration) var(--pluma-ease);
}

/* hover 只改文字色，**不给底色** —— 底色会和"激活"抢注意力（D2） */
.tab:hover {
  color: var(--pluma-text);
}

/* 「关于」Tab 的红点：有新版本时出现。
   用圆点而不是数字 —— 这里没有"几条"的概念，数字会被读成未读消息数。 */
.tab-dot {
  position: absolute;
  top: 4px;
  right: 6px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--pluma-danger, #d33);
}

.tab-dot[hidden] {
  display: none;
}

/* ── 「关于」Tab 的组间距：**已升级为全局规则**（2026-11-16 裁决 E）──
   原来这里有一条「.tab-pane.about-pane { gap: 12px }」，理由写在它的注释里：
   "关于页不协调的根因是组间距与组内间距同值"。但那是**所有 Tab 的**问题，
   只给关于页打补丁意味着每加一个 Tab 都要再打一次。
   现在 「.tab-pane」 全局 12px，「.about-pane」 这个修饰类已经**没有样式职责**，
   从 DOM 里删掉了（契约测试同步移除）。 */

/* 元信息卡：与 「.unlock-card」 **同一款**（padding / 边框 / 圆角 / 底色），
   不新造一套卡视觉。卡内 4px 是"行距"，与组间距 12px 是两个量级。
   2026-11-16：底换 --pluma-card（半透明）—— 用户真机反馈「关于页这块白底突兀」，
   与解锁卡同一天、同一个原因，一次改齐。 */
.about-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  /* 与 .unlock-card 同一档描边（见上） */
  border: 0.5px solid var(--pluma-line);
  border-radius: var(--pluma-radius-card);
  background: var(--pluma-card);
}

/* 卡头：标题左、状态徽标右 —— 与 「.unlock-head」 同一模式 */
.about-meta-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

/* 卡内的节标题沿用 「.diag-section」 的排版，只把它自带的外边距归零。
   同样用两个类提权重（理由同上：这条块在 「.diag-section」 之前） */
.diag-section.about-meta-title {
  margin: 0;
}

/* 数值等宽：三行的 「v1.x.y」 才能上下对齐，否则每次版本变化数字都左右跳 */
.about-meta .diag-value {
  font-variant-numeric: tabular-nums;
}

/* 「上次检查」不是主角，值也用 muted —— 否则三个值权重一样，看不清哪个是重点 */
.about-meta .diag-value.soft {
  color: var(--pluma-text-muted);
}

/* 主操作按钮：只换填充，**高度/圆角/字号完全沿用 「.acct-btn」**。
   不复用 「.primary-btn」 —— 它字号是 body、还带 「margin-top:2px」，
   与 「.acct-btn」 并排会不等高、基线错开。 */
.acct-btn.accent {
  border-color: var(--pluma-accent);
  background: var(--pluma-accent);
  color: var(--pluma-surface);
}

/* 实心按钮的 hover 不能再叠 「.acct-btn:hover」 那层浅底（会出现"半蓝半灰"），
   改用轻微提亮 */
.acct-btn.accent:hover:not(:disabled) {
  background: var(--pluma-accent);
  filter: brightness(1.06);
}

/* 英文外链降级为**文字链接**：仍然可聚焦、可键盘触发（它还是个 <button>），
   只是不再和主操作抢同样的视觉重量 —— 三个等大按钮看不出主次。 */
.btn-link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--pluma-text-muted);
  font-family: inherit;
  font-size: var(--pluma-font-caption);
  cursor: pointer;
}

.btn-link:hover {
  color: var(--pluma-text);
  text-decoration: underline;
}

/* 功能与署名之间**唯一**一条分隔线。
   ⚠️ 用 「height:0」 + border，不用 「height:1px」 + background —— 后者在 1.5x/2x
   屏上会被拉成 2px 灰条，看起来发毛；0.5px 的 border 会按 DPI 正确取整。 */
.about-divider {
  height: 0;
  border-top: 0.5px solid var(--pluma-border);
}

/* 署名区：一块，内部 6px */
.about-credit {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.about-credit .diag-section {
  margin: 0;
}

/* 「关于」Tab 的贡献者清单：两列换行，头像 + login */
.contributors {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
}

.contributor {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 4px;
  border: none;
  border-radius: var(--pluma-radius-control);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: var(--pluma-font-caption);
  cursor: pointer;
}

.contributor:hover {
  background: var(--pluma-accent-bg);
}

.contributor-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.contributor-avatar[hidden] {
  display: none;
}

/* 名字用正文色（不是 muted）：这一排要读起来像**署名**，不是一排待点按钮 */
.contributor-name {
  color: var(--pluma-text);
}

/* 激活态 = 蓝字 + 2px 下划线，**没有底色**（2026-11-16 改版）。
   显式写 background: transparent，而不是"悄悄删掉老那条浅蓝底" ——
   这样下一个人想加"选中底色"时必须先动这一行，动不了就会看见冲突。 */
.tab.active {
  background: transparent;
  color: var(--pluma-accent);
  border-bottom-color: var(--pluma-accent);
  font-weight: var(--pluma-font-weight-strong);
}

.panel-content {
  overflow-y: auto;
  padding-top: 8px;
}

/* 组间距 **12px，全局唯一值**（2026-11-16 裁决 E）。
   原来是 6px —— 组与组、组与组内元素同值，读起来是一条没有层级的长列表。
   组内自己用 4px（卡内行距）与 6px（同组控件）拉开，见各组件。
   ⚠️ 「.about-pane」那个局部补丁已删：它是同一个问题的第一次发作。 */
.tab-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── 状态胶囊 ──
   颜色只来自 tokens.css（02-ui-spec §6）。neutral 用 muted 文字色，
   其余三档各用一个语义色 —— 与 popup 的胶囊同一套语义。 */
.pane-head {
  display: flex;
  align-items: center;
}

/* 胶囊 18px 高（2026-11-16 度量）：原来靠 padding + line-height 撑出约 19.4px，
   高度随字号漂；写死高度后，胶囊与它旁边 11px 文字的基线才对得稳。 */
.pill {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border-radius: var(--pluma-radius-pill);
  font-size: var(--pluma-font-caption);
  line-height: 1;
}

.pill-neutral {
  background: color-mix(in srgb, var(--pluma-text-muted) 16%, transparent);
  color: var(--pluma-text);
}

/* 「事实：正常」用绿，不用蓝（2026-11-16 裁决 A）。
   蓝从此只表示「交互：当前/去做」—— 两者之前撞在一起，扫一眼分不出哪条是状态。 */
.pill-good {
  background: color-mix(in srgb, var(--pluma-ok) 16%, transparent);
  color: var(--pluma-ok);
}

.pill-warn {
  background: color-mix(in srgb, var(--pluma-warning) 18%, transparent);
  color: var(--pluma-warning);
}

.pill-bad {
  background: color-mix(in srgb, var(--pluma-danger) 16%, transparent);
  color: var(--pluma-danger);
}

.pane-line {
  margin: 0;
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
  line-height: 1.45;
}

.pane-note {
  margin: 0;
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
  line-height: 1.45;
}

.pane-note.warn {
  color: var(--pluma-warning);
}

/* ── 解锁画质卡（对应 02-ui-spec §2.3）──
   2026-11-16：底从 --pluma-surface（实色白）换成 --pluma-card（半透明）。
   用户真机反馈：磨砂底板上一块实白卡"很突兀" —— 卡应该让材质透出来，
   只用一档更亮来分层（方案 §4.5）。 */
.unlock-card {
  padding: 8px 10px;
  /* 描边走发丝（10%）：卡底只有 50% 白，去掉描边会在磨砂底上"消失"，
     而 15% 又像画了个框 —— 10% 是这两者之间唯一说得通的值。 */
  border: 0.5px solid var(--pluma-line);
  border-radius: var(--pluma-radius-card);
  background: var(--pluma-card);
}

.unlock-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.unlock-title {
  font-size: var(--pluma-font-body);
  font-weight: 600;
}

.unlock-title.good {
  /* 与 pill-good 同一个语义：这是事实（已解锁），不是交互 —— 所以是绿不是蓝 */
  color: var(--pluma-ok);
}

.unlock-title.muted {
  color: var(--pluma-text-muted);
}

.unlock-anchor {
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
  text-align: right;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

/* 徽章圆角走令牌（4 → 6px）：4px 在 11px 字高上像个直角块 */
.badge-chip {
  padding: 1px 6px;
  border-radius: var(--pluma-radius-chip);
  background: var(--pluma-accent-bg);
  color: var(--pluma-accent);
  font-size: var(--pluma-font-caption);
  line-height: 1.5;
}

/* ── 开关行（与 popup / 设置页同一形态）── */
/* 开关行（2026-11-16 度量）：
   - min-height 36px：单行项原来只有 31px，手指落点偏小；两行项本来就 47px，
     **所以 padding 不加到 8px** —— 那会把两行项顶到 51px，把净化页拉长一大截。
   - hover 从"8% 灰"换成 accent-soft：可点区域全项目同一个反馈色，
     灰 hover 在半透明底上看起来像"这一行脏了"。 */
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: var(--pluma-h-row);
  padding: 6px 8px;
  border-radius: var(--pluma-radius-control);
  cursor: pointer;
  transition: background-color var(--pluma-duration) var(--pluma-ease);
}

.row:hover {
  background: var(--pluma-accent-soft);
}

.row.dim {
  opacity: 0.5;
}

.row-label {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: var(--pluma-font-body);
}

.row-hint {
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
  line-height: 1.35;
}

/* 开关本体 36×20（panel 与 popup 原来一个 34×18、一个 36×20，同一天统一） */
.switch {
  position: relative;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--pluma-border);
  transition: background-color var(--pluma-duration) var(--pluma-ease);
}

.switch.on {
  background: var(--pluma-accent);
}

.switch.busy {
  opacity: 0.5;
}

.switch input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.switch .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--pluma-surface);
  transition: transform var(--pluma-duration) var(--pluma-ease);
  pointer-events: none;
}

.switch.on .knob {
  transform: translateX(16px);
}

/* ── 二级浮层入口 / 返回条 ── */
.sub-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 2px;
  padding: 7px 8px;
  border: 0.5px solid var(--pluma-border);
  border-radius: var(--pluma-radius-control);
  background: transparent;
  color: var(--pluma-text);
  font-family: inherit;
  font-size: var(--pluma-font-body);
  text-align: left;
  cursor: pointer;
}

.sub-entry:hover {
  background: var(--pluma-accent-bg);
}

.sub-entry-hint {
  flex: 1 1 auto;
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
}

.sub-entry-chevron {
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
}

.sub-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
  border-bottom: 0.5px solid var(--pluma-border);
}

.sub-back {
  padding: 2px 6px;
  border: none;
  border-radius: var(--pluma-radius-control);
  background: transparent;
  color: var(--pluma-accent);
  font-family: inherit;
  font-size: var(--pluma-font-body);
  cursor: pointer;
}

.sub-back:hover {
  background: var(--pluma-accent-bg);
}

.sub-title {
  font-size: var(--pluma-font-body);
  font-weight: 600;
}

/* ── 账号卡（对应 02-ui-spec §2.4：A 灰 / B 信息色）── */
.acct-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--pluma-radius-card);
}

.acct-row.primary {
  background: color-mix(in srgb, var(--pluma-text-muted) 10%, transparent);
}

.acct-row.playback {
  background: var(--pluma-accent-bg);
}

.acct-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--pluma-text-muted) 22%, transparent);
  color: var(--pluma-text);
  font-size: var(--pluma-font-caption);
}

.acct-avatar.accent {
  background: color-mix(in srgb, var(--pluma-accent) 28%, transparent);
  color: var(--pluma-accent);
}

.acct-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
}

/**
 * 取流身份胶囊的**独立行**（2026-11-11，S4）。
 *
 * ## 为什么它需要单独一行（真机像素实测）
 *
 * 面板真实宽 **311 CSS**，卡片内容区 295。行内原本塞了
 * '头像48 + main + VIP标签25.7 + 胶囊67'，三者都是 'flex: 0 0 auto'，
 * 于是 '.acct-main' 只剩 **154.3** —— 不够：
 *
 * '''
 * {{取流账号昵称}}（16 字）  →  {{取流账号昵称}}...   ← 少 4 字
 * 仅取流 · 6 个月后到期（13 字）→  仅取流 · 6 个月...  ← 截断
 * '''
 *
 * 挪出来后 '.acct-main' 从 154.3 → **229**（+67 胶囊 +8 间距），够放。
 *
 * ## 为什么左对齐而不是右对齐
 *
 * 左对齐与卡片左边缘对齐，读起来是"**这张卡**的当前设置"。
 * 右对齐会把它推离卡片视觉范围，反而像页面级的控件。
 *
 * ## ⚠️ 它与 '.acct-row' 是**同级**，不是子级
 *
 * 见 'tabs.ts' 的 'pillRow' —— 胶囊被 append 到 'box'，不在 'playbackRow' 里。
 * 所以这里的 'margin-left' 用来**模拟卡片内缩进**（与 '.acct-row' 的 padding 对齐）。
 */
.acct-pill-row {
  display: flex;
  align-items: center;
  /* 与 .acct-row 的 padding: 7px 8px 左内边距对齐 */
  padding: 0 8px;
  margin-top: 2px;
}

.acct-name {
  font-size: var(--pluma-font-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acct-sub {
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acct-tag {
  flex: 0 0 auto;
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
}

.acct-tag.accent {
  color: var(--pluma-accent);
}

.primary-btn {
  margin-top: 2px;
  padding: 7px 10px;
  border: none;
  border-radius: var(--pluma-radius-control);
  background: var(--pluma-accent);
  color: var(--pluma-surface);
  font-family: inherit;
  font-size: var(--pluma-font-body);
  cursor: pointer;
}

/* ── 面板内**并排按钮行**（2026-11-10 加，2026-11-17 起两个 Tab 共用）──
   账号 Tab：重新登录 / 退出播放账号；关于 Tab：立即更新 / 检查更新。
   两处都是"两个短中文按钮并排、各占一半"。面板内容区 272px
   （「.sheet」是 300px，减去左右各 14px padding），两格各约 133px，
   11px 字号下四字按钮约 44px —— 余量充足，竖排反而把下面的内容挤下去。 */
.acct-actions {
  display: flex;
  gap: 6px;
  /* 不再自己叠 margin：组间距由 .tab-pane 的 12px 给（2026-11-16 裁决 E）。
     以前这里是 8px，只有关于页靠一条 .about-pane 覆盖归零，账号页会变成 12+8=20。 */
  margin-top: 0;
}

.acct-btn {
  flex: 1 1 0;
  padding: 7px 6px;
  border: 0.5px solid var(--pluma-border);
  border-radius: var(--pluma-radius-control);
  background: transparent;
  color: var(--pluma-text);
  font-family: inherit;
  font-size: var(--pluma-font-caption);
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s;
}

.acct-btn:hover:not(:disabled) {
  background: var(--pluma-accent-bg);
}

.acct-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 「确认退出」—— 危险色，让第二次点击**明显不同于第一次** */
.acct-btn.danger {
  border-color: var(--pluma-danger);
  color: var(--pluma-danger);
  font-weight: 600;
}

/* 登录 / 退出的结果提示 */
.acct-result {
  margin: 6px 0 0;
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
  line-height: 1.4;
}

.acct-result.danger {
  color: var(--pluma-danger);
}

/* ── 面板底部提示条（登录失败等）──
   放在 root 末尾而不是 content 里 —— content 每次 render 都会被清空 */
.panel-notice {
  margin: 8px 0 0;
  padding: 6px 8px;
  border-radius: var(--pluma-radius-control);
  background: var(--pluma-accent-bg);
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
  line-height: 1.4;
}

.panel-notice.danger {
  background: color-mix(in srgb, var(--pluma-danger) 14%, transparent);
  color: var(--pluma-danger);
}

/* ── 诊断浮层（阶段 3）── */
.diag-section {
  margin: 4px 0 0;
  color: var(--pluma-text-muted);
  font-size: var(--pluma-font-caption);
  font-weight: 600;
}

.diag-facts,
.diag-logs {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.diag-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
  font-size: var(--pluma-font-caption);
  line-height: 1.4;
}

.diag-label {
  flex: 0 0 auto;
  max-width: 50%;
  color: var(--pluma-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}

.diag-value {
  flex: 1 1 auto;
  color: var(--pluma-text);
  text-align: right;
  word-break: break-all;
}

/* ok===true 绿 / false 红 / 省略中性 —— 与 02-ui-spec §4.2 的自检行同一语义 */
.diag-row.ok .diag-value {
  color: var(--pluma-accent);
}

.diag-row.bad .diag-value {
  color: var(--pluma-danger);
}

.diag-log {
  display: flex;
  gap: 6px;
  padding: 2px 0;
  font-size: var(--pluma-font-caption);
  line-height: 1.4;
  color: var(--pluma-text-muted);
}

.diag-time {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.diag-step {
  flex: 0 0 auto;
  color: var(--pluma-text);
}

.diag-detail {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

/** 面板从静息切到展开 / 收回时要做的动作，由 `mountSidebar` 返回 */
export interface SidebarHandle {
  /** 是否已经展开 */
  isOpen(): boolean;
  /** 是否处于钉住态（`pinned`）。诊断/单测用 */
  isPinned(): boolean;
  /** 展开（幂等） */
  open(): void;
  /** 收回（幂等）。会**退出钉住态** */
  close(): void;
  /** 摘掉 `document` 级监听器。面板销毁时必须调 */
  dispose(): void;
  /**
   * 有新版本、且用户还没看过这一版时，让**贴边条**显眼一点（2026-11-17）。
   *
   * ## 为什么这条通道必须存在
   *
   * 另外两条通知通道都要求用户先做点什么才看得见：
   *
   * | 通道 | 前提 |
   * | --- | --- |
   * | 工具栏角标 | 图标得**固定在工具栏**（Edge 默认把新装的扩展收进「扩展」菜单） |
   * | 「关于」Tab 红点 | 面板得先被**展开** |
   *
   * 贴边条是唯一"打开 B站 页面就在那儿"的载体。真机反馈"检测到新版本后
   * 不打开面板完全不知道"说的就是这件事。
   *
   * 面板展开时贴边条本来就隐藏（`.panel.open .strip{display:none}`），所以这里
   * 不用管展开态 —— 展开后由「关于」Tab 的红点与卡里的徽标接管。
   */
  setUpdateDot(active: boolean): void;
}

/** `mountSidebar` 的选项 */
export interface SidebarOptions {
  /** 塞进展开区的面板主体（`panel.ts` 的 `mountPanelBody().root`） */
  body?: HTMLElement | undefined;
  /**
   * **每次从收起变为展开时**回调一次。
   *
   * ## 为什么这个回调是必需的（2026-11-10 真机根因 2）
   *
   * 面板的取数原本只在**挂载时**跑一次（`content-panel.content.ts` 的 `paint()`
   * 在已有 sidebar 时短路）。而挂载发生在 `document_idle` —— 那时 `content.ts`
   * 的 `pageState` 刚初始化（`pageKey` 有值、`playback` 还是 null），
   * 于是面板拿到一份**半成品**并一直显示它。smoke 实测：
   * 等 20 秒重开一样、整页 reload 等 9 秒一样 —— 因为没有第二次取数。
   *
   * 有了这个回调，用户在「收起 → 展开」这个自然动作里就能刷新数据。
   *
   * ⚠️ 只在**状态真的从 false 变 true** 时调，重复的 `open()` 不重复触发
   * （hover 会连续命中，节流在调用方做）。
   */
  onOpen?: (() => void) | undefined;
  /**
   * **每次从展开变为收起时**回调一次（2026-11-10）。
   *
   * ## 为什么需要它
   *
   * 扫码登录后的轮询（`login-poller.ts`）是每 3 秒发一次 `account/summary` 的定时器。
   * 用户收起面板后它**必须停** —— 否则面板都看不见了，还在后台一直唤醒 background。
   *
   * 面板收起的路径有三条：鼠标离开（预览态）、点 × 、点面板外。
   * 三条都汇到 `setOpen(false)`，所以这里一个回调就能全覆盖。
   *
   * ⚠️ 与 `onOpen` 对称：只在**状态真的变了**时触发，重复的 `close()` 不重复调。
   */
  onClose?: (() => void) | undefined;
}

/**
 * 在 shadow root 里搭出侧栏骨架，并绑好展开 / 收回。
 *
 * ⚠️ 只在**新宿主建出时调用一次**（见 `host.ts` 的 `build` 参数）。
 * 重复调用会在同一个 DOM 上绑两套监听，表现为"点一次开、点两次关"。
 *
 * @param shadow `attachShadow()` 的返回值
 * @param opts 见 `SidebarOptions`
 *   - `body` 不传时退回阶段 1 的占位文案 —— 那条路径留给单测与"面板还没接上"的场景。
 *     ⚠️ 接上之后**不要**再渲染占位文案：一句"尚未接入"挂在一个已经能用的面板上，
 *     比没有更糟（用户会以为功能坏了）。
 */
export function mountSidebar(shadow: ShadowRoot, opts: SidebarOptions = {}): SidebarHandle {
  const { body, onOpen, onClose } = opts;
  const panel = document.createElement('div');
  panel.className = 'panel';

  const strip = document.createElement('div');
  strip.className = 'strip';
  strip.setAttribute('role', 'button');
  strip.setAttribute('aria-label', '打开 Pluma 面板');
  strip.setAttribute('tabindex', '0');
  const dot = document.createElement('span');
  dot.className = 'strip-dot';
  strip.appendChild(dot);

  const sheet = document.createElement('div');
  sheet.className = 'sheet';

  const head = document.createElement('div');
  head.className = 'sheet-head';

  const title = document.createElement('span');
  title.className = 'sheet-title';
  title.textContent = 'Pluma';
  head.appendChild(title);

  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  // `×` 换成内联 SVG：字形高度交给字体 = 控件尺寸不可控（见 dom.ts 的 iconClose）
  close.appendChild(iconClose());
  close.setAttribute('aria-label', '收起面板');
  head.appendChild(close);

  sheet.appendChild(head);

  /**
   * 展开区内容：**有主体就放主体**，没有才退回占位文案。
   *
   * `docs/02-ui-spec.md` §0 的精神是"每个元素都要回答一个问题"；
   * 一个点了不动的 Tab 只会让用户以为坏了 —— 所以阶段 1 写的是"尚未接入"。
   * 现在主体已经接上，占位文案**不能再出现**（见函数签名注释）。
   */
  if (body) {
    sheet.appendChild(body);
  } else {
    const skeleton = document.createElement('p');
    skeleton.className = 'skeleton';
    skeleton.textContent = '面板内容（画质 / 净化 / 账号）尚未接入，后续版本开放。';
    sheet.appendChild(skeleton);
  }

  panel.appendChild(strip);
  panel.appendChild(sheet);
  shadow.appendChild(panel);

  const setOpen = (next: boolean): void => {
    const was = panel.classList.contains('open');
    panel.classList.toggle('open', next);
    /**
     * ⚠️ **只在 false → true 那一次**触发 `onOpen`。
     *
     * hover 会连续命中 `mouseenter`，重复的 `open()` 也会调到这里。
     * 如果每次都回调，节流就成了唯一防线，而节流做在调用方 ——
     * 这里少一道判据，调用方漏了就变成每一次 DOM 事件都取数。
     */
    if (!was && next) onOpen?.();
    /**
     * ⚠️ 收起时也要回调（2026-11-10）—— 扫码登录后的轮询必须停。
     * 与 `onOpen` 对称：只在 true → false 那一次触发。
     */
    if (was && !next) onClose?.();
  };

  /**
   * ## 钉住态（2026-11-10 真机修的 bug）
   *
   * ### 问题现象
   *
   * 用户点「诊断 ▸」→ 面板**直接消失**，必须重新唤起才能看到诊断界面。
   *
   * ### 根因
   *
   * `mouseleave` 无条件 `setOpen(false)`。而"悬停自动收起"（为了不打扰沉浸）
   * 与"点击进入二级界面"（需要停留）**互相冲突**：
   * 用户点完按钮，鼠标稍微一动就离开了面板 → 立刻收起。
   *
   * ### 修法：两种状态
   *
   * | 状态 | 触发 | 鼠标离开时 |
   * | --- | --- | --- |
   * | **预览态** | 悬停贴边条 / 面板 | 自动收起（保持沉浸） |
   * | **钉住态** | **点击面板内任何元素** | **不收起** |
   *
   * ⚠️ **"任何元素"是刻意的**：只对 Tab 和「▸」生效的话，
   * 用户点了一个开关、鼠标移开，面板照样消失 —— 那是同一个 bug 的另一种形态。
   * 所以钉住绑在**面板容器**的 click 上（捕获阶段），不是在每个按钮上单独绑。
   *
   * ### 退出钉住
   *
   * - 点面板上的 × （`close()`）
   * - **点面板外的页面区域** —— 监听 `document` 的 click
   *
   * 关于后者：面板内所有交互点都会 `stopPropagation()`（防冒泡到 B站 页面），
   * 所以**页面级监听只会在真正点到面板外时触发** —— 不需要额外判"点的位置在哪"。
   * 但要注意：这里的 click 监听在 panel 元素上，它自己也会收到冒泡 ——
   * 所以用 `contains()` 再判一次，双保险。
   */
  let pinned = false;

  /** 进入钉住态（幂等） */
  const pin = (): void => {
    if (pinned) return;
    pinned = true;
    panel.classList.add('pinned');
  };

  /** 退出钉住态（幂等） */
  const unpin = (): void => {
    if (!pinned) return;
    pinned = false;
    panel.classList.remove('pinned');
  };

  /**
   * ## 点击是否发生在**面板内部**（2026-11-10 真机第二次踩坑的修法）
   *
   * ### 为什么不能靠 `panel.contains(ev.target)`
   *
   * 面板在 **`closed` shadow root** 里。document 层收到的 `ev.target` 已被
   * **重定向为宿主元素** `#pluma-panel-host`，而 `panel` 是 shadow **内部**的 div
   * → `panel.contains(宿主)` **恒为 false**。
   *
   * 于是"点面板内"与"点面板外"在 document 层**完全同形** → 点任意 Tab 都判成
   * "点在外面" → 立刻收起。**用户看到的现象和修复前一模一样。**
   *
   * smoke 的真机证据（`composedPath`）：
   * ```
   * {"targetTag":"DIV","targetId":"pluma-panel-host"}
   * {"composedPath":["DIV#pluma-panel-host","BODY","HTML"]}
   * ```
   *
   * `composedPath()` **也救不了**：`closed` 模式下它在 document 层拿不到 shadow 内部节点。
   * （jsdom 实测同样如此：closed 的 path 只有 `DIV,BODY,HTML,Document,Window`；
   * open 才有 `BUTTON,ShadowRoot,...`。所以测试必须用 `closed` 才有意义。）
   *
   * ### 修法：**内部置标记，外部只看标记**
   *
   * `panel` 自己在 shadow 内部，它收到的 `ev.target` 是**真实**的内部节点。
   * 由它置 `insideClick = true`，document 层只查这个标记 —— 不碰 `ev.target`。
   *
   * ### ⚠️ 时序：置标记用**捕获**、document 判标记用**冒泡**
   *
   * `DOM 事件流`：捕获（外→内）→ 目标 → **冒泡（内→外）**。
   *
   * | 监听 | 阶段 | 为什么 |
   * | --- | --- | --- |
   * | `panel` 置标记 | **捕获** | 必须**早于**内部元素的 `stopPropagation()` —— 否则它拦下冒泡，标记根本置不上 |
   * | `document` 判标记 | **冒泡** | 必须**晚于** panel 置标记 |
   *
   * ⚠️ 第一版把置标记写成冒泡阶段，结果：内部元素 `stopPropagation()` 后
   * 事件到不了 panel 的冒泡监听 → 标记永远置不上 → **和没修一样**。
   * 捕获阶段在从外往里经过 panel 时就触发，早于任何子元素的拦截。
   *
   * ### ⚠️ 标记必须**同步消费**
   *
   * 不能只靠 `setTimeout(0)` 复位：那是**宏任务**，而"点完面板内部、
   * 紧接着点页面别处"可能发生在同一个宏任务批次里 —— 那时标记还是 `true`
   * → **外部点击被误放过**，面板收不起来。
   *
   * 所以 `onDocumentClick` **读完立刻置回 `false`**。
   * 定时器只兜"没人消费"的情况（内部元素 stopPropagation 时 document 收不到）。
   */
  let insideClick = false;

  /**
   * 面板内部的 click —— **捕获阶段**置标记（理由见上方表格）。
   *
   * 不调 `stopPropagation`：只置标记，不改变事件传播
   * （真正拦冒泡的是各交互点自己的 `stopPropagation`）。
   */
  panel.addEventListener(
    'click',
    () => {
      insideClick = true;
      setTimeout(() => {
        insideClick = false;
      }, 0);
    },
    true,
  );

  /**
   * **点击面板内任何地方 → 钉住**。
   *
   * ## ⚠️ 必须用**捕获阶段**（与上面那个置标记的监听是两回事）
   *
   * 面板里每个交互点（Tab、开关、`▸` 入口）都调了 `ev.stopPropagation()`
   * —— 那是为了阻止冒泡到 B站 页面（首页推荐卡片会跳走）。
   *
   * 但那个 `stopPropagation()` **也会拦住冒泡到 `.panel` 的这一层**。
   * 第一版写成冒泡阶段（`panel.addEventListener('click', pin)`），
   * 结果：点「诊断 ▸」→ `depth` 变成 1（面板内部处理了）但 `isPinned` 仍是 false
   * → 鼠标一离开面板就收起 → **用户看到的 bug 一模一样**。
   *
   * 捕获阶段在**从外往里**传递时触发，早于任何子元素的 `stopPropagation`，
   * 所以它一定能拿到这次点击。
   */
  panel.addEventListener(
    'click',
    () => {
      pin();
    },
    true,
  );

  /**
   * 点**面板外**的页面区域 → 退出钉住并收起。
   *
   * ⚠️ **冒泡阶段**（第三参 `false`），不是捕获 —— 理由见上面 `insideClick` 的注释：
   * 捕获时 document 会比 panel 先执行，标记还没置上，判断失效。
   *
   * ## ⚠️ 标记要**同步消费**（读完立刻清）
   *
   * 不能只靠 `setTimeout(0)` 复位：那是**宏任务**，而用户"点完面板内部、
   * 紧接着点页面别处"这两次点击可能在同一个宏任务批次里。
   * 那时标记还是 `true` → **外部点击被误放过**，面板收不起来。
   *
   * 所以这里读完就立刻置回 `false`。定时器只兜"没人消费"的情况
   * （面板内部元素 `stopPropagation()` 时 document 收不到事件链）。
   */
  const onDocumentClick = (): void => {
    if (insideClick) {
      insideClick = false; // 同步消费，见上方注释
      return;
    }
    if (!pinned) return;
    unpin();
    setOpen(false);
  };
  document.addEventListener('click', onDocumentClick, false);

  /**
   * 交互点。⚠️ 每个都要 `stopPropagation`：
   * 不拦的话点击会冒泡到 B站 页面，首页会直接跳走（推荐卡片自己在 body 层监听）。
   */
  strip.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setOpen(true);
  });
  // 键盘可达：只做角色不给行为，等于给读屏用户一个死控件
  strip.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    ev.stopPropagation();
    setOpen(true);
  });

  /**
   * 鼠标移入展开 —— 绑在 **strip 与 panel 两层**上。
   *
   * 绑 `mouseenter` 而不是 `mouseover`（见文件头）。绑在 panel 上是为了让
   * "从贴边条移进面板"这一段不触发 `mouseleave` 直接收回（两者是同一个父子链，
   * `mouseleave` 只在整个 panel 被离开时触发）。
   */
  panel.addEventListener('mouseenter', () => {
    setOpen(true);
  });
  panel.addEventListener('mouseleave', () => {
    /**
     * ## ⚠️ 钉住态下**不收起**（2026-11-10 真机 bug）
     *
     * 这是"点诊断后面板消失"的修复点。
     * 严格说：`mouseleave` 只在**预览态**才收起。
     */
    if (pinned) return;
    setOpen(false);
  });

  close.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // × 是**主动关闭**：无论预览还是钉住，都要退出并收起
    unpin();
    setOpen(false);
  });

  /**
   * 贴边条上的"有新版本"标记。
   *
   * ⚠️ `aria-label` 必须跟着切：那个 2px 的小点对**读屏用户没有任何信息量**，
   * 只改颜色等于对他们什么都没发生。
   */
  const setUpdateDot = (active: boolean): void => {
    strip.classList.toggle('has-update', active);
    strip.setAttribute('aria-label', active ? '打开 Pluma 面板（有新版本）' : '打开 Pluma 面板');
  };

  return {
    isOpen: () => panel.classList.contains('open'),
    /** 是否处于钉住态（诊断/单测用） */
    isPinned: () => pinned,
    open: () => {
      setOpen(true);
    },
    close: () => {
      unpin();
      setOpen(false);
    },
    /**
     * 摘掉 `document` 上的监听。
     *
     * ⚠️ **必须在面板销毁时调用**（`content-panel.content.ts` 的 `removePanelHost()`
     * 那一路）。不摘的话：用户关掉开关 → 宿主移除 → 但 document 上还挂着一个
     * 指向已删除 DOM 的监听器，每点一次页面就跑一次无用回调，长期累积。
     */
    dispose: () => {
      document.removeEventListener('click', onDocumentClick, false);
    },
    setUpdateDot,
  };
}
