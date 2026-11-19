# 第三方代码与素材声明（NOTICE）

Pluma 本身按 [GPL-3.0-only](./LICENSE) + [附加条款](./ADDITIONAL-TERMS.md) 发布。
本文件列出项目中**来自第三方**的部分，以及各自的许可与署名要求。

> 本文件是 [LICENSE](./LICENSE) 的补充信息，不是许可证。
> 它存在的理由是：GPL 允许把 MIT 等宽松许可的代码并进来，但**必须保留原作者的版权与许可声明**。

---

## Bilibili-Evolved

- 来源：<https://github.com/the1812/Bilibili-Evolved>
- 作者：the1812（及下列各文件各自的作者）
- 许可：**MIT**（`LICENCE.md` —— 注意是英式拼写，仓库里没有 `LICENSE`）

**MIT 许可原文**：

```text
MIT License

Copyright (c) 2018 the1812

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 关于上游的「附加限制」

Bilibili-Evolved 的 `LICENCE.md` 在 MIT 之外还有两条限制，但**适用范围被明确限定为
「发布本脚本的完整内容」**（例如直接分发 `.user.js` 直链、或导入 GreasyFork 等脚本托管站），
并**明文说明「只是指向本仓库的页面链接是没关系的」**。

**Pluma 是独立的 MV3 扩展，不发布、不打包、不转发 Bilibili-Evolved 的用户脚本**，
因此该附加限制**不适用**。上面的 MIT 原文仍然完整保留。

### 具体使用的部分

| 本仓库文件 | 来源 | 原作者 |
| --- | --- | --- |
| `src/content/live/live-clean.ts`（3 个 CSS 选择器） | `registry/lib/components/live/remove-watermark/remove-watermark.scss` | the1812 |
| `src/content/site-clean/ad-selectors.ts`（通用广告位选择器表） | `registry/lib/components/utils/remove-promotions/remove-promotions.scss` | the1812 |
| `src/content/site-clean/home-selectors.ts` + `home-clean.ts`（分类判据思路） | `registry/lib/components/style/clear-home/index.ts` | **RieN7**（<https://github.com/rien7>） |

### 我们**没有**使用的部分

以下这些在 Bilibili-Evolved 里存在，但 Pluma **未使用**，改用自研实现：

- `defineComponentMetadata` / `instantStyles` / 组件注册表（构建期魔法）
- `@/core/spin-query` 的轮询等待
- `@/ui` 的 Vue 2 组件（`OptionRadioGroup` 等）
- 其用户脚本运行时与 `GM_*` API

**选择器清单本身是"事实"，不是"表达"**（B站 的 DOM 类名属于客观事实）。
真正需要署名的是那些由上游作者**筛选与维护**的清单 —— 上表列出的即是。

---

## DSH / deepseek-harness（**配方照搬，非代码复用**）

- 来源：<https://github.com/deepseek-ai/deepseek-harness>
- 许可：**未核实**（本项目未复制其任何源码文件，故未触发许可声明义务；
  若将来要搬运其代码，**必须先核实许可**）

面板的底板与浮层材质是**照搬配方**，不是"看着像"：见
[ADR 0037](./docs/decisions/0037-panel-material.md) 与
[docs/plans/2026-11-16-ui-redesign-plan.md](./docs/plans/2026-11-16-ui-redesign-plan.md) §2.2。

| 本仓库 | 出处 | 落在哪 |
| --- | --- | --- |
| 材质 `rgba(252,253,254,.7)` + `blur(40px) saturate(150%)` | `--dsw-menu-surface-fill` / `--dsw-menu-backdrop-filter` | `--pluma-menu-fill` / `--pluma-menu-blur` |
| 材质铺在**单独一层**（`.sheet::before`），不写在容器上 | `MenuSurface.module.css` 的 `.material` | `sidebar.ts` 的 `.sheet::before` |
| `0 0 0 0.5px` 作为 box-shadow 第一层、组件 `border: 0` | `--dsw-elevation-stroke` | `--pluma-elevation-stroke` |
| `body, body *` 逐元素重绑自定义属性（`var()` 在本元素就替换完） | `ui-theme/src/styles/gradient-shadow-text.css` 的注释 | `tokens.css` 的规矩 3 |

> ⚠️ **这条登记以前漏了。** README 曾把"界面形态"记在 Ghost-Downloader-3 名下，
> 而 ADR 0037 写明的实际来源是 DSH。2026-11-19 更正并补登。

---

## Bettbox（**界面形态参考，未使用代码**）

- 来源：<https://github.com/appshubcc/Bettbox>
- 许可：见上游仓库

加载时间轴的**界面形态**参考：结论卡 + 时间轴 + 图例三层，逐条细节收进二级浮层
（我们的「本次加载」），主界面只留结论与时间轴。
`docs/plans/2026-11-17-pcdn-diag-plan.md` §4 记录了这次分层取舍。

**未使用其任何源代码。** 界面形态属于**表达之上的结构选择**，我们独立实现
（`src/content/panel/loading-pane.ts` 与 `src/core/loading/timeline.ts`）。

---

## SuperLyric（**界面形态参考，未使用代码**）

- 来源：<https://github.com/HChenX/SuperLyric>
- 许可：见上游仓库

加载**速览行**的信息层级参考其 API 实时数据面板：标题 + 状态胶囊 + 等宽计数
（`ApiPanelPeekHeader`）。我们的 `loadingQuickRow()` 用了同一分层办法。

**未使用其任何源代码**（上游是 Kotlin + Compose，本项目是原生 DOM）。

---

## bdFun（**设计参考，未使用代码**）

- 来源：bdFun（Kotlin，**GPL-3.0**）
- 与 BiliPai 并列，是「屏蔽 PCDN」一项的设计来源（[ADR 0039](./docs/decisions/0039-rewrite-pcdn-authority.md):7）

借鉴的是**设计思路**：给一批写死的官方镜像、`rewrite()` 只换 host（path / query 不动）。
**未使用其源代码。**

> ⚠️ 明确**没有**借鉴的部分：bdFun 的"自动测速"（逐 host 拉 1 MiB 比速度）。
> 扩展里做这个会产生真实流量、污染我们自己的时间轴、拖慢起播
> （[ADR 0039](./docs/decisions/0039-rewrite-pcdn-authority.md):362）。

---

## 其它致谢

- **Bili Dual Account Helper** —— 请求级身份代理思路。其代码**无许可证，不可抄**，
  本项目只借鉴思路。
- **BiliPai**（GPLv3，Kotlin）—— 多账号设计；另外「屏蔽 PCDN」的规则清单与其同源：
  `src/core/cdn/classify.ts` 的 `PCDN_LABELS`（mcdn / pcdn / gotcha）与 `PCDN_DOMAINS`
  （szbdyd / mountaintoys / qrstuvwxyzab / zhenidc）**与 BiliPai 的 `risky` 后缀逐字一致**
  （[ADR 0039](./docs/decisions/0039-rewrite-pcdn-authority.md):36）。
  **未使用其源代码。**
- **Bilibili-Evolved**（the1812、RieN7，MIT）—— 见上一节，**有代码级复用**。

> **项目立场（以前误记为 `pkg-verify/README.md`，该文件不在版本控制，已失效）：**
> 只借鉴设计，不使用竞品源代码。许可兼容（GPL）也不构成搬运的理由。

---

## 维护约定

- 新增任何来自第三方的代码/选择器/文案，**必须**在本文件登记（来源 + 许可 + 原作者）
- 许可若不是 MIT/Apache/BSD 这类宽松许可（例如 GPL/AGPL/专有），**先停下来问用户** ——
  可能与本项目的分发方式冲突
- 本文件的登记有 `scripts/check-docs.mjs` 覆盖（它要求根目录 Markdown 达到篇幅与链接规范），
  但**没有**自动断言"代码用了第三方却没登记"。这条靠自觉
