# AGENTS.md

> 给所有接手本项目的 AI 代理（以及人类开发者）的**强制规则**。
>
> 本文件**不是建议，是约束**。违反其中任何一条，请停下来问，不要自行判断。

---

## 0. 三分钟认知

**Pluma**（`bili-pluma`）= B站双账号画质助手。纯 MV3 浏览器扩展。

**一句话原理**：浏览器全程保持主账号登录；扩展只在**白名单内的取流接口**上，用另一个（大会员）账号的凭据重发该请求。

**不是**破解，不是切 cookie，不是冒充会员。

**当前状态**：设计完成，Q2 已实测通过，**代码尚未开始**（只有 `poc/`）。下一步是 P1-a 脚手架。

---

## 1. 先读什么（按此顺序，不要跳）

| 顺序 | 文件 | 读它的目的 |
| --- | --- | --- |
| 1 | [README.md](./README.md) | 这是什么、边界在哪、为什么只发源码 |
| 2 | **本文件** | 硬约束 |
| 3 | [docs/03-open-questions.md](./docs/03-open-questions.md) §0 总览表 | **还剩几件事没定**，哪些已定不要翻案 |
| 4 | [docs/04-project-structure.md](./docs/04-project-structure.md) §〇 + §1 + §2 | 技术选型、目录、分层禁令 |
| 5 | [docs/decisions/](./docs/decisions/) | 5 条已定决策的理由 |
| 6 | [docs/01-architecture.md](./docs/01-architecture.md) | 需要理解原理时再读 |
| 7 | [docs/02-ui-spec.md](./docs/02-ui-spec.md) | 只在做 UI 时读 |

**不需要一次读完 `docs/`。** 按需查，但**决策清单（第 3 步）必须读**。

---

## 2. 不可翻案的决策（10 条）

以下决策已经过讨论并定稿。**没有用户明确指示，不得更改、不得"优化"、不得"顺便改进"。**

| # | 决策 | 违规示例（不要做） |
| --- | --- | --- |
| 1 | **纯 MV3 扩展，不做桌面端** | 提议"加个 Rust 后台进程会更稳" |
| 2 | **请求级代理，不切 cookie** | 提议"切一下 cookie 更简单" |
| 3 | **`declarativeNetRequest` 换 Cookie 头，不用 `chrome.debugger`** | 提议"用 debugger 能改响应体" |
| 4 | **主账号不归扩展管理**，就是浏览器当前登录态 | 提议"加个主账号管理页" |
| 5 | **不做伪装的会员标识**，连开关都不放 | 提议"让画质菜单看起来正常点" |
| 6 | **不做远程配置**，只本地版本号 + 升级提示 | 提议"加个远程白名单热更新" |
| 7 | **GPL-3.0-only + 第 7 条附加条款** | 提议"换成 MIT 更容易被采用" |
| 8 | **只发源码**，不上架商店、不发预编译包 | 提议"打包个 zip 方便用户" |
| 9 | **v1 只支持 Chrome + Edge** | 提议"顺手适配 Firefox" |
| 10 | **WXT 的 `entrypoints/` 约定** 优先于个人目录偏好 | 提议"把入口改回 `src/content/`" |

**如果你认为某条决策有问题**：不要直接改，也不要绕过它写代码。**先向用户说明你的理由和建议，由用户决定**。ADR 存在的意义是记录"为什么当时这么定"，不是让你重新讨论一遍。

---

## 3. 动手前必须知道的事

### 3.1 Q2 已实测通过，架构不再有阻塞项

**2026-10-25 实测结论：DNR 并发安全。** 180 个并发请求，串号 0，规则残留 0。更重要的发现是**不需要 per-request nonce** —— 白名单请求全都该用同一个播放账号，值全局一致。所以 `dnr.ts` 用**按路径的常驻 session 规则**，不要规则 ID 池、不要每请求 add/remove、不要在 URL 上加 nonce 参数。见 [ADR 0006](./docs/decisions/0006-no-per-request-nonce.md)。

**三条硬性配套**（不做就不算实现完）：总开关（凭据失效时能一键停用，否则所有 playurl 一起变未登录）、SW 启动自愈（`sessionRules` 重启即清空）、POST 例外（`/ogv/player/playview` 的 csrf 在 body 里，DNR 改不了，必须 JS 拦截重建）。

`poc/q2-dnr-concurrency/` **保留为常驻回归测试**，改 `dnr.ts` 必跑。它不用 WXT、不建 `src/`、零依赖，手写 `manifest.json` + `background.js` + `lab.html`/`lab.js`/`lab.css`（MV3 禁止内联 `<script>`）。

### 3.2 必须先读再动手的清单

开始任何编码任务前，确认你已经知道：

- [ ] 技术选型（WXT / TS `^5.9` / Preact 仅 UI / 原生 CSS 变量 / Vitest / pnpm）
- [ ] 目录分层（`entrypoints/` → `src/background` `src/content` → `src/core` → `src/shared`）
- [ ] `core/` 的禁令（不许 `chrome.` / `window.` / `document.` / 直接 `fetch(`）
- [ ] `platform/http/dnr.ts` 是整个项目风险最高的文件，且**无法用 Vitest 测**
- [ ] 路径白名单唯一真相源是 `src/shared/constants/routes.ts`
- [ ] 视觉令牌唯一真相源是 `src/design/tokens.css`
- [ ] 消息类型是 `src/shared/types/messages.ts` 的**判别联合**

---

## 4. 写代码的硬规则

### 4.1 依赖方向

```
entrypoints/*  →  src/background、src/content  →  src/core  →  src/shared
```

**反向一律禁止。** 如果 `core/` 里想用 `chrome.storage`，正确答案是给 `core` 注入一个接口，实现在 `platform/`。

### 4.2 三个"不许"

1. **`core/` 里不许出现 `chrome.` / `window.` / `document.` / `fetch(`**——CI 的 `check-boundaries.ts` 会拦。
2. **不许在 popup 里做长任务**——popup 失焦即销毁。扫码走独立窗口（`chrome.windows.create`）。
3. **不许把凭据下发给 UI**——UI 只能拿到 `{uname, mid, vipLabel, expireAt, healthy}`。

### 4.3 页内注入

- **必须用 Shadow DOM**（`mode: 'closed'`）隔离，否则和 B 站页面样式互相污染。
- **不用 Preact**，纯 DOM 20 行即可。
- `tokens.css` 必须能注入 shadow root——**CSS 变量不穿透 shadow 边界**。

### 4.4 DNR 相关

- 所有 DNR 代码只在 `platform/http/dnr.ts`，对外只暴露 `withCookieFor()`。
- **按白名单路径各建一条常驻 session 规则，不带 nonce。** 不要写成每请求 add/remove，也不要加规则 ID 池（ADR 0006）。
- 必须实现总开关 + SW 启动自愈重建，否则凭据失效时所有 playurl 一起变未登录。
- `/ogv/player/playview` 是 POST、csrf 在 body 里，DNR 改不了 —— 它走 JS 拦截重建，不走这里。
- 改动这个文件后**必须重跑 `poc/q2-dnr-concurrency/`**。

---

## 5. 改文档的硬规则

> 这一节是从一次「一次自检修出 11 处矛盾」的教训里来的。**违反它就会重现那些问题。**

### 5.1 每件事只有一个权威位置

| 内容 | 权威位置 | 其他地方怎么写 |
| --- | --- | --- |
| 技术选型与版本 | `docs/04-project-structure.md` §〇 | 只说"见 04 §〇" |
| 实施路线与阶段 | `docs/04-project-structure.md` §6 | `01` §9 只写验收标准 |
| 待确认问题状态 | `docs/03-open-questions.md` §0 总览表 | 正文各节与总览表**必须一致** |
| 决策理由 | `docs/decisions/` | 一句话结论 + 链接 |
| 合规/免责文案 | 根 `README.md` 首屏 + `docs/03` Q10 | 不复制到别处 |
| 目录结构 | `docs/04-project-structure.md` §1 / §2 | 不在 01/02 重画 |

**发现两处都写了同一件事 → 删掉一处，改成引用。** 不要"两边都更新，保持同步"——那必然漂移。

### 5.2 引用规则

- **必须写文件名**：`见 docs/04-project-structure.md §2`，不写"见 §6.2"。
- 原因：章节会重排，无锚点的相对位置一定会指错。

### 5.3 改完必跑检查

```bash
# 死链检查
for f in README.md ADDITIONAL-TERMS.md AGENTS.md docs/*.md docs/*/*.md; do
  dir=$(dirname "$f")
  grep -o "\](\.\.\?/[^)#]*)" "$f" 2>/dev/null | sed 's/](//;s/)$//' | while read -r link; do
    [ -e "$dir/$link" ] || echo "❌ $f → $link"
  done
done

# 章节编号连号检查（以 03 为例）
grep -n "^## [0-9]" docs/03-open-questions.md
```

**任何一项输出异常，先修完再交付。**

### 5.4 长度纪律

| 文件 | 上限 | 为什么 |
| --- | --- | --- |
| `README.md` 全文 | **80 行** | 它是门面，不是手册 |
| 任何文档的单节 | **80 行** | 超了考虑拆分 |
| `AGENTS.md` | **200 行** | 它必须一次读完，长了就没人读 |

**测试方法**：如果一段话删掉后，读者仍然知道"该做什么、不该做什么"，这段话就该删。

**不许把"解释为什么"写成流水账**。ADR 记理由，正文只记结论。

---

## 6. 遇到不确定时的处理

| 情况 | 正确做法 |
| --- | --- |
| 觉得某条决策有问题 | **停下来说明理由，由用户决定**，不要直接改 |
| 文档之间矛盾 | **先查 §5.1 的权威位置表**，改错误的那一份 |
| 接口行为不确定 | **抓官方前端**，不要猜；也不要依赖第三方文档（bilibili-API-collect 已关停） |
| 测试挂了 | 先判断是 `core/` 逻辑错还是 `platform/` 适配错，不要"改测试让它过" |
| 想加新依赖 | **先问**。当前依赖清单是封闭的，加任何一个都要有理由 |

---

## 7. 交付前自检清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm lint` 通过（含依赖方向规则）
- [ ] `pnpm check:boundaries` 通过
- [ ] `pnpm test` 通过（`core/` 层）
- [ ] 若改了 `dnr.ts` → 已重跑 `poc/q2-dnr-concurrency/`
- [ ] 若改了文档 → 已跑 §5.3 的检查
- [ ] 没有新增"两边都写同一件事"的重复
- [ ] 没有偷偷改 §2 的 10 条决策

---

## 8. 一句话总结

**这个项目不缺想法，缺的是"不擅自发挥"。**

所有该决定的都已决定，该记录的都已记录。你的任务是**按图施工**，遇到图有问题就报告，不要自己改图。
