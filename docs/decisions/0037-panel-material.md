# ADR 0037：界面底板改用「半透明材质」

- 日期：2026-11-16
- 状态：**已采纳**（用户要求「以 DSH 子智能体面板为参考，能照搬就照搬，不要再自研」；
  A–F 六条裁决见 [方案](../plans/2026-11-16-ui-redesign-plan.md) §10）
- 影响文件：`src/design/tokens.css`、`src/content/panel/sidebar.ts`（`.sheet` / `.strip`）
- 相关：[ADR 0033](./0033-panel-first-interface.md)（面板是主界面）、
  [02-ui-spec](../02-ui-spec.md) §6（视觉规范）
- 外部参考：`deepseek-ai/deepseek-harness` 的
  `packages/client/ui-theme/src/styles/gradient-shadow-text.css` 与
  `packages/client/ui-primitives/src/MenuSurface.module.css`

---

## 背景

面板原来的底板是「实色白 + 0.5px 四边描边 + 一条投影」——一个标准卡片。
用户要求把它换成 DSH 面板的观感。

逐像素实测那张截图时我先得出过**错误结论**：因为整幅图 0% 纯白，我判断"这套界面没有白卡片、用的是灰底"。
去源码核对后才发现底板是**半透明材质压在压暗的遮罩上**，采样到的灰是被压暗的底色，不是面板自己的颜色。
（这条错误值得记：**只看截图无法区分"深色底"和"半透明压在什么东西上"**。）

## 决策

**照搬配方与三层结构，不自研。**

| 层 | 做法 | 出处 |
| --- | --- | --- |
| 材质 | `rgba(252,253,254,.7)`（深色 `rgba(48,49,54,.64)`）+ `blur(40px) saturate(150%)` | `--dsw-menu-surface-fill` / `--dsw-menu-backdrop-filter` |
| 承载 | 材质铺在**单独一层**（我们的 `.sheet::before`），不写在容器上 | `MenuSurface.module.css` 的 `.material` |
| 描边 | `0 0 0 0.5px` 作为 box-shadow 的**第一层**，组件 `border: 0` | `--dsw-elevation-stroke` |

## 代价（必须一起读）

1. **合成成本已实测**（2026-11-16，B站直播首页，1080p 正在播放，面板全展开）：

   | 场景 | rAF | p95 | 视频帧间隔抖动 |
   | --- | --- | --- | --- |
   | 面板收起（基线） | 165 fps | 6.2 ms | — |
   | 面板展开（材质生效） | 162~165 fps | 6.2 ms | — |
   | 面板展开 + 模糊置 `none`（对照） | 161~165 fps | 6.3 ms | — |
   | 808×455 材质直压直播画面 | 161~165 fps | 6.2 ms | 0.2 ms（无材质时 0.1~0.3） |
   | 同上 + 每帧滚动（强制重采样） | 158~165 fps | 6.2 ms | — |
   | 材质**首次合成**那一帧 | 5.9~6.2 ms | — | — |

   测法是两层：`requestAnimationFrame` 间隔（主线程节拍）+ `video.requestVideoFrameCallback`
   （合成链路对视频帧的呈现，rAF 看不到这一侧）。开 / 关模糊各测三轮取区间。

   **结论与环境强相关**：Edge 157 / RTX 3060 Ti / 20 核 / 32 GB / 165 Hz / DPR 1。
   在这台机器上 40px 模糊**没有可测成本**，包括"材质压在运动画面上、且每帧都要换背景"的最坏组合。
   但这是中高端独显 —— 集显与低端机**没有测过，不能外推**。
   ⇒ 降级开关保留（`data-surface="opaque"`），只是**当前没有触发条件**。该 CSS 分支尚未实现，
   真要做时必须与 setter 一起加（没有 setter 的死选择器就是下一个 `.primary-btn`）。
2. **两条回退是必需项，不是优化**：`@supports not (backdrop-filter)` 与
   `prefers-reduced-transparency: reduce` 都退回 `--pluma-canvas`。少了第一条，
   内核不认时面板只剩 70% 透明，等于能看见页面文字。
3. **白底页面上材质不可见**：实测条内 253 对页外 255。所以贴边条的"看得见"由
   **22% 描边 + 一层柔光**承担（`c05780e`），材质只负责在有内容/暗色页面上的质感。
4. **三条禁令**（违反任何一条都会静默降级）：材质必须在 `::before`（写容器上会让后代的
   `fixed` 包含块改变）；容器上不许有 `opacity`（材质会停止采样）；`border` 与 elevation 不许并存（会画成双线）。

## 后果

- 面板不再是"白卡片"，`docs/02-ui-spec.md` §6 从**值表**改成**角色表** —— 值只留在 `tokens.css`。
- 独立窗口（popup / 更新 / 登录 / 无痕页）**不套材质**：背后是空窗口，没有东西可采样。
- 卡片不再有"白底 + 描边"的默认形态，只保留 `--pluma-card`（半透明）+ 10% 发丝描边。
