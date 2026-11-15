# 修复后验收清单 · 1.2.0 步骤 1–5

> 用途：修复完成后**拿这份逐条点**，不重新做探索。
> 来源：`REPORT.md` 的 4 条 🔴 + 3 条 🟡 + 深挖 A/B 结论。
> 基线 `main` = `9d18154`。修复前工作区状态：27 改 + 12 增。

---

## 第一部分：4 条 🔴 的验收判据

### 🔴-1 · `run-q2-auto.cjs` 必须真跑过

| # | 核对项 | 怎么验 |
| --- | --- | --- |
| 1.1 | `.tmp/dnr-regression-stamp.json` 里**同时**有 `dnr-disable-clears-tab-rules` 和 `run-q2-auto` | 读该文件，`scripts` 对象应有两个键 |
| 1.2 | 两个脚本的 `fingerprint` **与当前 `dnr.ts` 一致** | 对比 stamp 里的 fingerprint 与脚本算出的当前值 |
| 1.3 | `node scripts/verify.mjs` **17/17 全绿** | 看退出码与 `1/17` 那行 |
| 1.4 | `run-q2-auto` 的 `passed` 数不是 0、不是 skip | stamp 里 `passed > 0` |

> ⚠️ **不接受**"脚本跑了但只在隔离副本里验过"。AGENTS.md §4.3 要求的是真实运行。

---

### 🔴-2 · `resolveBoundaryIdentity` 必须吃 `streamingIdentity`

| # | 核对项 | 怎么验 |
| --- | --- | --- |
| 2.1 | 函数签名含 `streamingIdentity: StreamingIdentity`（**必填**，不是可选） | 读 `feed-boundary.ts` 签名 |
| 2.2 | `'page'` 模式 + `credentialMid ≠ pageMid` → **返回不显示**（关键用例） | 单测：期望 `shouldShowBoundary(...) === false` |
| 2.3 | `'page'` 模式 + `credentialMid === pageMid` → 也不显示 | 单测 |
| 2.4 | `'extension'` 模式 + 不等 → `'ok'`（原行为不变） | 单测（防回归） |
| 2.5 | `probeIdentity()` 里真的读了 `readStreamingIdentity()` | 读 `content-feed-boundary.content.ts`，确认有读 + 传入 |
| 2.6 | **首页能拿到这个值**（不是"拿不到所以跳过"） | 确认 `readStreamingIdentity` 在 content script 分区可读 |

> ⚠️ 若实现方选择"`'page'` 模式返回 `'self'`"而不是新增 `'page-identity'`，2.2/2.3 仍必须成立；
> 但要在注释里写明它与 `self`（事实）的区别，否则下一次会有人改回去。

---

### 🔴-3 · 类型断链：4 处全部改为派生 + 具名类型

| # | 核对项 | 怎么验 |
| --- | --- | --- |
| 3.1 | `messages.ts` 有具名导出 `ProxyActivateReason` | grep `export type ProxyActivateReason` |
| 3.2 | `src/shared/types/playinfo.ts` 的 `proxyIdentity` 用派生/具名类型，**无手抄字面量** | 读该字段定义 |
| 3.3 | `src/core/ui/page-snapshot.ts:83-92` 同 | 读 |
| 3.4 | `src/content/isolated/page-state.ts` 的 `ProxyActivateReason` 改为 import 或派生 | 读 |
| 3.5 | `entrypoints/content.ts` 的**内联字面量断言**改为派生 | 读 `page/activate` 那段 |
| 3.6 | `src/background/handlers/page.handler.ts:44-47` 仍用派生（已对，防回归） | 读 |
| 3.7 | **`'same-account'` 旧名全部清除**（TODO 清理条件已满足） | grep 全仓，期望 0 处（注释里的历史说明可留） |

**3.7 附加**：清理时**必须同时删** `tests/unit/content/page-state-same-identity.test.ts` 里
"两个值都命中"那条断言（`page-state.ts:83-84` 的 TODO 明文要求）。

---

### 🔴-4 · 6 处用户可见字符串改名

| # | 位置 | 期望改成 |
| --- | --- | --- |
| 4.1 | `src/content/isolated/badge-content.ts:251` | `取流身份：取流账号 ｜ …` |
| 4.2 | `src/content/isolated/badge-content.ts:258` | `取流身份：取流账号。…` |
| 4.3 | `src/content/isolated/badge-content.ts:338` | `取流身份：取流账号 ｜ …` |
| 4.4 | `src/core/playinfo/summary-view.ts:69` | `PGC_ANCHOR = '取流账号提供'` |
| 4.5 | `src/platform/diagnostics/collect.ts:172` | `'取流账号（页面 playurl 响应）'` |
| 4.6 | `src/platform/diagnostics/collect.ts:456` | `put('取流账号凭据', …)` |

**复核命令**（期望只命中注释）：
```
Get-ChildItem -Recurse -Include *.ts,*.tsx -Path src,entrypoints |
  Select-String -Pattern "播放账号" |
  Where-Object { $_.Line -notmatch '^\s*(\*|//|/\*)' }
```

> ⚠️ 4.1–4.3 是**角标详情**，用户直接看。改完 `verify` 不会告诉你对不对（零兜底）。
> ⚠️ 注意别把"取流身份：取流账号"改成重复词读着别扭 —— 可考虑「身份：取流账号」。
> 这一条需要**人读一遍**，不是机械替换。

---

## 第二部分：3 条 🟡 的验收（可选，但要记录结论）

| # | 项 | 期望 |
| --- | --- | --- |
| 🟡-1 | `README.md:20` 的「解锁」 | 改为「可取得」/「画质上限」；`README.md:28`/`:30` 的「**不**解锁」**不动** |
| 🟡-2 | `tabs.ts` 注释残留（338/418/429/443/449/492/553/566/595） | 改；**特别** `:553` 注释与 `:562` 代码已不符 |
| 🟡-3 | `TODO(1.2.0-step2-merge)` | 已由 🔴-3 的 3.7 覆盖 |

---

## 第三部分：深挖 A 的验收（三处判据是否说同一件事）

**同一用户、同一时刻、三个位置**——用下表逐格核对：

| 场景 | `page.handler.ts` | `page-state.ts` | `feed-boundary.ts` | 三处一致？ |
| --- | --- | --- | --- | --- |
| ① 选 `extension`，mid 不等 | `ok` | 不产出 `same-identity`（基线可用） | `ok` → 显示线 | 应一致 |
| ② 选 `extension`，mid 相等 | `self` | `same-identity`（基线不可用） | `self` → 不显示 | 应一致 |
| ③ **选 `page`**，mid 不等 | `page-identity` | **？（修复前：什么都不改）** | **？（修复前：`ok` → 撒谎）** | **修复后必须一致** |
| ④ 选 `page`，mid 相等 | `page-identity` | ？ | ？ | 修复后必须一致 |
| ⑤ 游客（pageMid=null） | `ok`（继续代理） | 不产出 | `unknown` → 不显示 | **刻意不一致**（见下） |

**⑤ 为什么允许不一致**：`feed-boundary` 出于产品判断（游客没有"你的推荐"这个概念）返回 `unknown`，
而 `page.handler` 技术上仍在代理。**这是刻意的**，不是 bug —— 但**必须在三处注释里互相指认**，
否则下一个人会来"修复"这个不一致。

**③/④ 的期望**（我给的建议，实现方可另选但要写理由）：
- `page` 模式 = 用户不要第二个身份 → 三处应统一为「**不需要代理 / 无对比基线 / 不显示分界线**」
- 与 `self` 的**行为一致、话术不同**

---

## 第四部分：深挖 B 的结构性缺口（写进方案文档，不是修完就算）

`tsc` **无法保护**的 6 类（已由 `messages.ts:126-145` 记录，此处作为核对项）：

| # | 缺口 | 本轮是否有该类写法 |
| --- | --- | --- |
| B1 | 内联字面量断言 `as { reason?: 'ok'|... }` | ✅ 有（`content.ts`，🔴-3 要求改） |
| B2 | `as Type` 断言绕过 | 需人工复查 |
| B3 | `String(reason)` / 模板拼接 | 需人工复查 |
| B4 | `JSON.parse(...) as {...}` | 需人工复查 |
| B5 | 跨 world `postMessage`（主世界裸 JS） | **`main-world.js` 不受 `tsc` 管辖** |
| B6 | `Record<string, ...>` 宽容器 | `collect.ts` 的 `REASON_TEXT` 是**封闭键**（会报错），✅ 安全 |

**验收动作**：`grep -n "as {" entrypoints/content.ts src/platform/diagnostics/collect.ts` 确认无新增内联断言。

---

## 第五部分：最终门（AGENTS.md §8）

```bash
node scripts/verify.mjs          # 必须 21/21（或当前项数全绿）
node poc/verify/run-q2-auto.cjs  # dnr.ts 有改动，必跑
node poc/verify/dnr-disable-clears-tab-rules.cjs
```

- [ ] 全量 verify 绿
- [ ] 两个 DNR 脚本都跑过且 fingerprint 匹配
- [ ] 全量 vitest 绿（基线 1501 tests / 85 files，修复后应 ≥ 此数）
- [ ] 人工逐条审 `git diff` 的**所有字符串改动**
- [ ] `poc/probe/` 下 6 个目录的去留已由用户决定

---

## 附：我（verifier）本轮碰过的文件 —— 供 Lead 核对

**我修改过的文件（变异测试，均已恢复）**：

| 文件 | 改了什么 | 恢复方式 | 恢复后 `git hash-object` |
| --- | --- | --- | --- |
| `src/content/isolated/page-state.ts` | `SAME_IDENTITY_REASONS` 删 `'self'`；`ProxyActivateReason` 加/删 `'page-identity'` | 正则还原 | `d504603c…` |
| `src/content/feed-boundary/feed-boundary.ts` | `shouldShowBoundary` 改 `!== 'self'` | 正则还原 | `5174c932…` |

> ⚠️ **全仓 `git diff` SHA256 校验在并行改动环境下会失效**（本轮实测踩到：另一成员在我备份后改了
> `messages.ts` 等 5 个文件，导致哈希不符，但**不是我的变异残留**）。
> **修正方法：定向校验——只对"我碰过的文件"做 `git hash-object` 比对，并在报告里显式列出这些文件。**
> 这条方法论应记进 `docs/guides/methodology.md`。
