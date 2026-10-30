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

## Ghost-Downloader-3（**仅设计参考，未使用任何代码**）

- 来源：<https://github.com/XiaoYouChR/Ghost-Downloader-3>
- 许可：**GPL-3.0**

**未使用其任何源代码**。参考的是**设计语言**（Fluent Design 的形态：
顶部标签页、极细描边分割、间距刻度、设计令牌化），
这些属于**思想**而非**表达**，不受版权保护。

Pluma 的 popup / options 技术栈是 **Preact + 原生 CSS 变量**，
与 Ghost-Downloader-3 的 React + Fluent UI 完全不同，**不存在代码级复用**。

---

## 其它致谢

设计思路还受益于：

- **Bili Dual Account Helper**（请求级身份代理思路）
- **BiliPai**（多账号设计思路）

这两者**均未使用其源代码**，仅借鉴设计思路。

---

## 维护约定

- 新增任何来自第三方的代码/选择器/文案，**必须**在本文件登记（来源 + 许可 + 原作者）
- 许可若不是 MIT/Apache/BSD 这类宽松许可（例如 GPL/AGPL/专有），**先停下来问用户** ——
  可能与本项目的分发方式冲突
- 本文件的登记有 `scripts/check-docs.mjs` 覆盖（它要求根目录 Markdown 达到篇幅与链接规范），
  但**没有**自动断言"代码用了第三方却没登记"。这条靠自觉
