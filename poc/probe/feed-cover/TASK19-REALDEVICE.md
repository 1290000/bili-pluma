# task-19 / task-13 真机复核报告

> **日期**：2026-11-11 17:xx
> **环境**：bsk 0.3.3 / Edge 157（用户日常实例，无 `--user-data-dir`）/ 产物 15:24:45（**比所有源码新**）
> **纪律**：只读为主；切换身份/开关属可逆变更，**已全部恢复原值**（见 §5）
> **执行者**：engineer-dnr

---

## ① `feed-card` / `bili-feed-card` 嵌套关系 —— **实测：嵌套属实**

### 方法
`probe-feed-nesting.mjs`，3 次采样（第 2/3 次前 `bsk reload`），只读 DOM。

### 数据

| 项 | 采样1 | 采样2 | 采样3 | 判定 |
| --- | --- | --- | --- | --- |
| `.feed-card` 数量 | **10** | **10** | **10** | ✅ 稳定 |
| `.bili-feed-card` 数量 | **28** | **28** | **28** | ✅ 稳定 |
| `.bili-video-card.is-rcmd` 数 | 28 | 27 | 28 | ⚠️ 微浮动 |
| 其中 `height>0` | **22** | **19** | **20** | ❌ **不稳定** |
| **`.feed-card` 内含 `.bili-feed-card`** | **10/10** | **10/10** | **10/10** | ✅ **全部嵌套** |
| `.bili-feed-card` 内含 `.feed-card` | 0 | 0 | 0 | 反向为零 |
| 同一元素同时有两 class | 0 | 0 | 0 | 无 |
| `.feed-card` 里 `height=0` 的 | 4 | 4 | 4 | ✅ 稳定 |

### 嵌套样例（第一张 `.feed-card`，原始 JSON）

```json
{
  "feedCardClasses": "feed-card",
  "feedCardRect": {"top": 255, "h": 207, "w": 237},
  "directChildTags": ["DIV.bili-feed-card"],
  "innerBiliFeedCards": 1,
  "innerBiliVideoCards": 1
}
```

**直接子节点只有一个：`DIV.bili-feed-card`。**

### grid 直接子元素（前 20，实测）

```
[ 0] recommended-swipe   top=255 h=433  (轮播)
[ 1] feed-card           top=255 h=207  内含 bili=true   ← A 批
[ 2] feed-card           top=255 h=207  内含 bili=true
[ 3] feed-card           top=482 h=207  内含 bili=true
[ 4] feed-card           top=0   h=0    内含 bili=true   ← 零高度
[ 5] feed-card           top=482 h=207  内含 bili=true
[ 6] feed-card           top=708 h=222  内含 bili=true
[ 7] feed-card           top=708 h=222  内含 bili=true
[ 8] feed-card           top=0   h=0    内含 bili=true   ← 零高度
[ 9] feed-card           top=0   h=0    内含 bili=true   ← 零高度
[10] feed-card           top=0   h=0    内含 bili=true   ← 零高度
[11] floor-single-card   top=708 h=222  (楼层分隔)
[12] bili-feed-card      top=708 h=222  selfBili=true    ← B 批（直接子元素）
[13] bili-feed-card      top=951 h=207  selfBili=true
[14] bili-feed-card      top=951 h=207  selfBili=true
[15] floor-single-card   top=0   h=0
[16] bili-feed-card      top=0   h=0    selfBili=true
...
```

### 结论

> **engineer-api 报的嵌套关系属实。`task-22` 的隐藏方案从根上不成立。**
>
> 原因：`.feed-card` **内部就是** `.bili-feed-card`。隐藏 `.feed-card` 会把内层的
> `.bili-feed-card` 一起藏掉 —— 那不是"隐藏 A 露出 B"，而是**把 A 和它包着的那个 B 一起删掉**。
>
> 而且 `.feed-card` 有 **4 张 `height=0`**，隐藏它们的视觉收益为 0。

### 附带回答 task-19 剩余项

| # | 项 | 结果 |
| --- | --- | --- |
| 2 | `feed-card` 数量是否恒为 10 | ✅ **10/10/10**，稳定 |
| 3 | 父子嵌套是否属实 | ✅ **属实**（10/10，方向单一） |
| 4 | `height>0` 的 `.is-rcmd` 是否稳定 ≥10 | ❌ **不稳定**（22 / 19 / 20） |
| 5 | `recommended-swipe` 内嵌卡是否带 `is-rcmd` | ❌ **不带**（`innerVideoCards:2, innerIsRcmd:0`），三次一致 |
| 6 | `.feed-card` 里有没有 `height=0` | ✅ **有 4 个**，三次一致 |
| 1 | 分界线实际渲染 top | **未做** —— 功能已删除，无观测对象 |

---

## ② M2：`page` 模式下画质区是否说假话 —— **实测：通过**

### 步骤与原始数据（`probe-m2.mjs`）

```
[0] 初始胶囊          : "取流：扩展账号"
[1] 点胶囊后          : "取流：浏览器账号"      ← 胶囊可点，切换生效
[2] 刷新页面
[3] 画质 Tab 全文：
      StaticText "已接管"
      StaticText "无法对比"
      StaticText "取流身份与页面身份相同，无对比基线"
      StaticText "1080P"
[4] 切回后胶囊        : "取流：扩展账号"        ← 已恢复
```

### 判据核对

| 判据 | 结果 |
| --- | --- |
| **不该出现**「主账号基线不可用（数据来源是取流账号）」 | ✅ **没有出现** |

### ⚠️ 但发现一个**新**的待确认点

`page` 模式下画质区标题显示的是「**已接管**」，而身份字段是「取流身份与页面身份相同」。

**「已接管」通常意味着"我替你换了 Cookie"**，而 `page` 模式恰恰**什么都没换**。
按 `popup-state.ts` 的同一条纪律（「已接管」是断言，不许在没换 Cookie 时出现），
这里可能是一个**新的假话**。

**证据等级：观察 + 推理，未验证是否违反设计**（我没有查 `panel-data.ts` 里这个 pill 的判据来源）。
**建议派 verifier 或 engineer 核一下 `page` 模式下画质区 pill 该说什么。**

---

## ③ M3：删掉第零道 PGC 门控后，番剧页能否播完整集 —— **实测：通过**

### 数据（`poc/probe/verify-pgc-by-snapshot.mjs`）

```
播放进度      : 00:24 / 24:01
总时长(秒)    : 1441
画质按钮      : 1080P
页面试看标记  : 试看中 / 大会员专享 / 成为大会员

✅  总时长 24:01 > 180s，播的是完整集
```

### 判据

| 判据 | 阈值 | 实测 | 结果 |
| --- | --- | --- | --- |
| 总时长 > 180s | > 180 | **1441s** | ✅ **完整集** |

**注**：页面上的「试看中」是 B站常驻会员引导条，判据看实际播放总时长。

---

## ④ M5：关代理后 `client-written` 是否粘住 —— **实测：没有粘住**

### ⚠️ 先说判据的替换

Lead 要求读 `primaryReason`，但**它不在 `page/snapshot` 里**
（`snapshot.primary` 是 `buildPageSnapshot` 裁剪后的 5 字段：`uname/level/loggedIn/source/placeholder`，
其中 `source: "cached"` 是**账号资料来源**，不是 `primaryReason`）。

**改用两个直接可读的等价物**（主世界对象，`bsk evaluate` 直读）：
- `window.__PLUMA_PGC__.lastStage` / `skipProxyOffCount`
- `window.__playinfo__` 存在性与 `hasDash`

### 三阶段原始数据（`probe-m5-final.mjs`）

| 阶段 | `lastStage` | `skipProxyOff` | `ssHit` | `cfgCount` | `__playinfo__` |
| --- | --- | --- | --- | --- | --- |
| **0. 代理开** | `skip-proxy-off` | 1 | true | 3 | exists, hasDash=false |
| **1. 代理关 + 刷新** | **`boot`** | **0** | **false** | 3 | exists, hasDash=false |
| **2. 恢复 + 刷新** | `cfg-with-cache` | 0 | true | 4 | exists, hasDash=false |

### 结论

> **没有粘住。** 关代理刷新后 `lastStage` 从 `skip-proxy-off` 变成 `boot`，
> `skipProxyOffCount` 归零、`ssHit=false` —— 说明**全新的一次加载，没有被上次状态粘住**。
> 恢复后变成 `cfg-with-cache`（正常注入路径），`ssHit=true`。

⚠️ **口径**：`lastStage` 是主世界 PGC 链路的状态，**不等于 `primaryReason`**。
本轮**没有**直接观测到 `primaryReason` 的值。
严格说 M5 的原始命题（`primaryReason` 是 `ssr` 还是 `client-written`）**未验证**；
我验证的是"关代理后刷新没有沿用旧状态"这个更上层的等价行为。

---

## ⑤ 状态恢复确认（必查）

| 项 | 恢复后实测 | 原值 | 一致 |
| --- | --- | --- | --- |
| `proxy.enabled` | **true** | true | ✅ |
| `proxy.ruleCount` | **4** | 4 | ✅ |
| `proxy.hasCredential` | true | true | ✅ |
| 取流身份胶囊 | **"取流：扩展账号"** | extension | ✅ |
| 画质区 pill | "已接管" | 已接管 | ✅ |

**全部恢复原值。** 期间唯一的写操作是 `set-proxy` / `streaming/set`（用户授权可逆）。

---

## ⑥ 逐项「实测 / 未验证」

| # | 项 | 状态 |
| --- | --- | --- |
| ① `feed-card`/`bili-feed-card` 嵌套 | ✅ **实测**（3 次采样一致） |
| ① `feed-card` 数量稳定 = 10 | ✅ **实测** |
| ① `height>0` 的 `.is-rcmd` 稳定 ≥10 | ✅ **实测为不稳定**（22/19/20） |
| ① swipe 内嵌卡不带 `is-rcmd` | ✅ **实测**（三次 innerIsRcmd=0） |
| ① `.feed-card` 里有 4 个 height=0 | ✅ **实测** |
| ② M2 画质区不出现假话 | ✅ **实测通过** |
| ② `page` 模式下显示「已接管」是否也是假话 | ⚠️ **未验证**（发现了现象，未核设计） |
| ③ M3 番剧播完整集 | ✅ **实测通过**（1441s） |
| ④ M5 关代理后没粘住 | ✅ **实测**（但用的是 `lastStage` 而非 `primaryReason`） |
| ④ `primaryReason` 的直接值 | ❌ **未验证** —— 该字段不在 `page/snapshot` 暴露路径上 |

---

## 附：脚本

| 文件 | 用途 |
| --- | --- |
| `probe-feed-nesting.mjs` | ① 嵌套关系 + 6 项几何，3 次采样含 reload |
| `probe-m2.mjs` | ② 切 page → 刷新 → 读画质区 → 切回 |
| `probe-m5-final.mjs` | ④ 三阶段 `lastStage` 观测 |
| `check-restored.mjs` | ⑤ 状态恢复确认 |
| `probe-bridge.mjs` | postMessage 桥（照 `docs/guides/bsk-page-bridges.md`） |
