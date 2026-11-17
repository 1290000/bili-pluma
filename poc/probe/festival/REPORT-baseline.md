# 活动页「主账号画质基线」可行性调查

> 调查人：probe-festival-baseline　日期：2026-11-18
> 环境：bsk **0.5.0（未升级）**、登录态真实 Edge（browser `f1405632`）、Pluma 1.3.0，`proxyEnabled=true` / `identity=extension`，`buildProof={probeVersion:2, swStartedAt:1794941633159}`。
> 为避免干扰同机的 `probe-sidebar-search`，本次用**独立会话 `yyev`**（agent window 1673242205），未碰它的 `mylo` 会话。
> 边界：**只读**。未改 `src/`、测试、守卫，未 commit；所有签名 URL / 凭据 / Cookie 一律脱敏。原始证据在 `.tmp/baseline-*.json`（gitignored），探针表达式在 `poc/probe/festival/expr/baseline-*.js`。

---

## 0. 一句话判断

> **不可行。** 死在三层，任意一层单独就足以否决：
> 1. **没有主账号专属数据源** —— 活动页 `__INITIAL_STATE__` 与 SSR HTML 里都找不到"主账号能看什么画质"的数据（只有视频源分辨率和大会员状态，二者都不是权益基线）；
> 2. **唯一可能的源需要越界动作** —— 只能用主账号身份再发一次 playurl，而 DNR 全局规则会把所有 playurl 的 Cookie 换成扩展账号；绕开它要么摘规则（ADR 0006/0014 明确否决、有竞态窗口），要么读主账号 httpOnly 的 SESSDATA（违反"不碰主账号"的核心承诺，ADR 0014/0024）；
> 3. **实测无区分度** —— 即便绕开 DNR 拿到主账号身份的响应，它与扩展账号的响应**逐字段相同**（两个号都是大会员）：COLMO 两侧都是 `quality=120` / 6 档含 4K；bnj 两侧都是 `quality=112` / 5 档。补上基线也只会得到"两侧相同"，不是用户想要的价值证明。
>
> **退而求其次**：把文案从"主账号基线未知（本页没有 SSR 数据）"改成更诚实、但不叫"补基线"的陈述（见 §5）。本调查**不实施任何改动**。

---

## 1. 调查对象与方法

| 页 | URL | 稿件 |
| --- | --- | --- |
| bnj2026 | `https://www.bilibili.com/festival/bnj2026?bvid=BV1eoZ7BnEGy` | 年年对对（拜年纪单品），cid=36059286363 |
| COLMO2026 | `https://www.bilibili.com/festival/COLMO2026?bvid=BV1ydeX65Edn` | 我造了一栋可以移动的房子…，cid=42141027046 |

方法：`bsk-eval.mjs` 走页面主世界只读表达式；`get-html` 抓原始 HTML 做字面量统计；A/B 实验用**页面播放器 performance entry 里现成的签名 URL**（`w_rid` / `wts` 原样复用，未伪造任何参数），通过面板总开关切换取流身份后各发一次只读 GET。

---

## 2. 逐项实测

### 2.1 `__INITIAL_STATE__` 里有没有画质字段？（问题 1）

**结论：没有。** 两页递归盘点命中的"画质相关"路径全部是**视频源属性或账号状态**，没有一条是权益基线：

| 命中类别 | 路径示例 | bnj 值 | COLMO 值 | 是不是基线 |
| --- | --- | --- | --- | --- |
| 视频源分辨率 | `videoInfo.pages[0].dimension.width/height` | `1920×1080` | `3840×2160` | ❌ 所有账号相同，是源分辨率 |
| 其他分 P 源分辨率 | `videoSections[].episodes[].pages[].dimension.*`、`sectionEpisodes[].pages[].dimension.*` | 多条 | 多条 | ❌ 同上 |
| 布局高度 | `videoSections[].height` | `156` | 有 | ❌ CSS 布局，不是画质 |
| 大会员状态 | `userInfo.vipStatus=1`、`vipType=1`、`vipDueDate`、`userInfo.vip.*` | 有 | 有 | ❌ 是"资格"，不是"这个视频能看哪几档" |
| 等级 | `userInfo.level_info.current_level` | `6` | 6 | ❌ 与画质档位无关 |

- 命中路径数：bnj **174** 条、COLMO **99** 条，逐条核完，无一例外。
- **完全搜不到** `quality` / `accept_quality` / `qn` / `fnval` / `dash` / `playurl` / `playinfo` / `format` / `upower` 这些键。
- `__playinfo__`：`typeof window.__playinfo__ === 'undefined'`，但 `Object.getOwnPropertyDescriptor` 是 `{get:function, set:function, configurable:true}` —— 这是 Pluma 主世界装的**空钩子**（页面从未赋值），不是数据。与旧 REPORT§2.2 记的"描述符为 null"不同，原因是本轮已实现 ADR 0040 注入面扩张；但**钩子下面依然没有 SSR 数据**，结论不变。

证据：`.tmp/baseline-state-bnj.json` / `.tmp/baseline-state-colmo.json`。

### 2.2 SSR HTML 有没有内联取流数据？（问题 2）

**结论：没有。** 两页原始 HTML（bnj 1,167,138 B / COLMO 1,076,969 B，UTF-16 字符数均约 524K）逐字面量统计：

| 字面量 | bnj | COLMO |
| --- | --- | --- |
| `__playinfo__` / `playinfo` / `playurl` | 0 / 0 / 0 | 0 / 0 / 0 |
| `accept_quality` / `acceptQuality` / `"quality"` / `"dash"` | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| `__INITIAL_STATE__` / `"fnval"` / `"qn"` | 0 / 0 / 0 | 0 / 0 / 0 |
| `upower` / `"vipStatus"` / `playurlSSRData` / `video_info` | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

页面数据是运行时 JS 填进 `window.__INITIAL_STATE__` 的，HTML 里连这个变量名都没有 —— 服务端没有把任何"主账号视角的取流结果"写进文档。

证据：`.tmp/baseline-html-bnj.json` / `.tmp/baseline-html-colmo.json`，统计脚本 `expr/count-html-markers.cjs`。

### 2.3 关键实验：主账号身份 vs 扩展账号身份的 playurl（问题 3）

**方法**：用页面自身发出的那条 `/x/player/wbi/playurl` 的签名 URL（performance entry，参数原样、不重算签）在页内 `fetch(..., {credentials:'include'})`。拨面板总开关切换身份，每页各取一次：

- 开关 OFF → 桥回 `proxyEnabled:false` → 浏览器（主账号）身份；
- 开关 ON → 桥回 `proxyEnabled:true` → DNR 把 Cookie 换成扩展账号。

**旁路尝试（如实记录）**：DNR 规则 `requestMethods:['get']`，所以试了 `method:'POST'` 同 URL —— 服务端返回 **405 Method Not Allowed**，旁路失败，未伪造参数。

**结果（脱敏摘要）**：

| 页 | 身份 | `code` | `quality` | `accept_quality` | `dash.video` ids | heights | 轨数 | 120 档 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bnj | 主（开关 OFF） | 0 | 112 | [112,80,64,32,16] | [112,80,64,32,16] | [1080,720,480,360] | 15 | 0 |
| bnj | 扩展（开关 ON） | 0 | 112 | [112,80,64,32,16] | [112,80,64,32,16] | [1080,720,480,360] | 15 | 0 |
| COLMO | 主（开关 OFF） | 0 | 120 | [120,112,80,64,32,16] | [120,112,80,64,32,16] | [2160,1080,720,480,360] | 18 | 3 |
| COLMO | 扩展（开关 ON） | 0 | 120 | [120,112,80,64,32,16] | [120,112,80,64,32,16] | [2160,1080,720,480,360] | 18 | 3 |

`format` 两侧都是 `hdflv2`；`durl` 都不存在；杜比视界 / Hi-Res / 杜比全景声两侧都是无。`quality` / `accept_quality` / `dash` 三处**逐字段相同**。

**为什么相同（不是接口不区分身份，而是这次两个号权益一样）**：

- 面板账号页实测：主账号卡（`LV6`、粉丝数已脱敏、`vipStatus=1`）与取流账号卡（昵称已脱敏，标签「取流：扩展账号 · 年度大会员 · 6 个月后到期 · 1 天前校验」）是**两个不同的号**；
- 两者都是大会员，所以顶档都到本片天花板（COLMO 4K / bnj 1080P+）。项目既有证据也表明接口**会**按身份区分 —— `REPORT-nano.md` 实测游客态 dash 最高只有 480P；只是本环境两个号都到顶，差值为 0。

**结论（对问题 3 的回答）**：

> 活动页的 playurl 响应**形状可用、但拿不到有区分度的主账号基线**：主账号身份的响应能拿到（需拨开关，见 §3 代价），但它和扩展账号的响应在这台机器上完全一样。即使把它当基线喂进对比，UI 也只会得到"没有提升 / 已是最高画质"，不是用户想要的「已解锁」。

**⚠️ 取证局限（不掩饰）**：

- bsk 把 Cookie 头固定显示为 `[redacted]`，无法直接读到 wire 上 DNR 换成的值；"主账号身份"的确认依据是 `proxyEnabled` 从 `true→false→true` 的实际翻转 + 面板开关点击，不是看到 Cookie 明文。
- 两账号均为大会员是**本次环境**的观测；不排除"主账号非会员 + 扩展会员"时响应会有区分度 —— 但那条路仍被 ADR 0014/0024 否决（§3），且本调查不能替用户制造那种账号组合。
- 实验结束时总开关已恢复为 ON（最后一次桥回 `proxyEnabled:true`、`identity:extension`），未留下配置改动。

证据：`.tmp/baseline-ab-bnj.json`、`.tmp/baseline-main-bnj.json`、`.tmp/baseline-main-colmo.json`、`.tmp/baseline-ext-colmo.json`。

### 2.4 对比展示需要哪些字段，活动页能满足吗？（问题 4）

**对比实际消费的字段**（不是注释里写的 `quality`/`accept_quality`，而是 `dash` 轨道）：

| 环节 | 代码 | 真正用到的字段 |
| --- | --- | --- |
| 解析 | `src/core/playinfo/parse.ts:177` `parsePlayurl` | `{code,data}` 形状；`data.dash.video[].id/height/bandwidth/frameRate`、`dash.flac.audio`、`dash.dolby.audio`、`dash.dolby.vision`；`quality`/`accept_quality` 解析了但**明确不当能力判据**（Q9：未登录时含 8K 假数组） |
| 能力归纳 | `src/core/playinfo/rank.ts:30` `capabilityOf` | 只用 `dash.video[].height/id/bandwidth/frameRate` + flac/dolby；返回 `null` 表示"不知道" |
| 差异 | `src/core/playinfo/rank.ts:106` `diffCapability` | `maxHeight`、`maxFrameRate`、`hasHiRes`、`hasDolbyAudio`、`providesDolbyVision`、`topQualityIds` |
| 展示 | `src/core/playinfo/summary-view.ts:342` `describeUnlock` / `:187` `anchorText` | `view.playback.capability`；`view.primary.reason/loggedIn/capability.topQualityIds/maxHeight`；`view.diff` |

活动页拿到的 playurl 响应**满足这个形状**（`data.dash.video[]` 有真实 id / height / bandwidth / frameRate，dolby/flac 字段齐全），所以**形状不是障碍**。缺的只有一样：**这份响应必须是主账号身份生成的** —— 而这正是 §2.1–2.3 证明拿不到的东西。

补充：当前面板文案落点 `summary-view.ts:326` 的 `case 'absent': '主账号基线未知（本页没有 SSR 数据）'` 与 `panel-data.ts:287` 的 `anchor:'主账号基线未知'` 就是活动页（`reason:'absent'`）如实显示的来源，与用户所见一致。

---

## 3. 为什么"硬补"代价不可接受

即使接受 §2.3 的越界动作，把它做成产品也要付四笔账（前两笔是 ADR 已裁决的红线）：

1. **摘/装 DNR 规则的竞态窗口** —— 要在同一标签页发主账号身份请求，只能"删规则 → 发请求 → 装回去"，窗口内该页任何 playurl 都用主账号身份；违反 ADR 0006「常驻规则、不每请求增删」，且 ADR 0014「被放弃的方案」第一条已否决。
2. **读主账号凭据越界** —— `SESSDATA` 是 httpOnly，自己拼主账号请求必须读它，直接违反"扩展不管理、不读取主账号"（决策 4 / README 首屏承诺），ADR 0014 第二条、ADR 0024 第二条已否决。
3. **一次以主账号身份对需权益内容的取流** —— 即便只读响应不播放，也让 README「不绕过付费墙」的措辞需要打补丁（ADR 0024 第三条）。
4. **收益为零** —— 本环境两号都是大会员，实测响应逐字段相同；补完基线 UI 仍显示"没有提升"。

一句话：**技术上"能发那个请求"，但产品上不能用，且用了也没有可见收益。**

---

## 4. 产出清单

仅在 `poc/probe/festival/` 下新增，未动产品代码 / 测试 / 守卫，未 commit：

- 报告：`REPORT-baseline.md`（本文）
- 表达式：`expr/baseline-state-inventory.js`、`expr/count-html-markers.cjs`、`expr/ab-identity-playurl.js`、`expr/fetch-signed-once.js`、`expr/account-identity-compare*.js`、`expr/open-panel-inspect.js`、`expr/panel-presence.js`、`expr/panel-host-dump.js`、`expr/toggle-proxy.sh`
- 证据：`.tmp/baseline-*.json`（gitignored，未入库）

---

## 5. 退而求其次（供 team-lead 决策，本文不实施）

若用户坚持"不要把这块显示成缺失"，可做的**只有诚实文案收敛**，而不是补基线：

- `summary-view.ts:326` `case 'absent'` 改为「本页不提供主账号画质对比」/「活动页无主账号基线」—— 去掉"未知（本页没有 SSR 数据）"这种像在加载、且暴露实现细节的措辞；语义不变（仍然是不对比）。
- 视频页那套 `已解锁 / 主账号最高 X` 保持不变。
- **不要**拿 `videoInfo.pages[].dimension.height`（源分辨率）冒充"主账号基线"：那对所有账号相同，会得出"主账号也有 4K"的静默谎报，违反"不许编数据"。
- 若将来真要对比，唯一合规路径是**等产品层面授权一次明确的主账号身份请求**（需要新 ADR 推翻 ADR 0014/0024 的相关条款），而不是在面板侧偷做。
