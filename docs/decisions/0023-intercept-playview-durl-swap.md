# ADR 0023：SPA 切集拦截 `playview` 响应、换完整集 dash

- 状态：**已采纳**（2026-10-28 真机验证通过）
- **本文档已被自身修正过一次**：换流形态从 durl 改为 **dash**（durl 会把画质锁死在 720P）。
  正文写的**已经是修正后的方案**，旧方案收在文末「被放弃的方案」一节。
- 取代：ADR 0019 的「异步 playurl 注入」在 **SPA 切集**场景下的适用性
- 相关：ADR 0021（改试看标记）、ADR 0022（藏试看提示条）、
  [ADR 0020](./0020-pgc-sync-injection-and-reload.md)（P2 缓存 + 同步注入）

---

## 背景：整页加载与 SPA 切集是**两条完全不同的路**

这是本 ADR 的核心事实，之前一直被混为一谈。

| | 整页加载（首次进入 / 刷新） | SPA 切集（右侧选集 / 播放器内切集） |
| --- | --- | --- |
| 取流 | SSR 写死在 HTML 的 `__playinfo__` | **`GET /ogv/player/playview`**（页面自己发） |
| 流形态 | 试看 durl（4 组 × 6 分钟） | 试看 durl（同样 4 组） |
| `__playinfo__` | 会被赋值 → **setter 可拦** | **完全不动**（停在上一集的 cid） |
| 播放器 | `createPlayer` 读 `__playinfo__` | 用 `playview` 的响应重建 |

**`__playinfo__` 在 SPA 切集时不更新**，这是关键。真机实测（2026-10-28，ss34412 连续切 5 集）：

```
切到 ep341210 后：
  location.pathname = /bangumi/play/ep341210      ← URL 变了
  __playinfo__.result.arc.cid = <上一集的 cid>     ← 还是上一集的
  pluma:pgc-* 键                                   ← 一个都没产生
  video.duration = 360.151                        ← 试看
```

结论：[ADR 0020](./0020-pgc-sync-injection-and-reload.md)（P2 缓存 + `__playinfo__` setter 注入）
对 SPA 切集完全无效 —— 不是判定写错，是 setter 根本没被调用。

---

## 决定

**在页面侧（主世界）拦截 `/ogv/player/playview` 的响应，把 `data.video_info` 换成完整集的 dash。**

三条硬约束：

1. **换流用 `fnval=4048` 取 dash，并同步 `dash` / `type` / `format` / `quality` / `timelength` /
   `accept_quality` / `accept_description` / `support_formats`，同时 `delete durl / durls`。**
   原因有两层：① 有 `durl` 时播放器优先走 durl，会回到 720P；② `type` 字段在两种响应里**连类型都不同**
   （`"DASH"` 字符串 vs `3` 数字），播放器靠它选管道，不同步就等于把 dash 管道整条关掉。
   `durl` 只在"响应里确实没有 dash"时作为**降级**使用 —— 至少能看完整集。
2. **完整流从 `/pgc/player/web/playurl` 取**（已在 DNR 白名单里，Cookie 是播放账号的，拿到的就是完整集）。
3. **`playview` 本身不开 DNR 白名单**。开了服务端会返回 dash，形态一变就灰屏。换流必须由主世界在**响应已到手之后**做。

> ⚠️ **这里最初写的是"保持 durl 形态、用 `fnval=0` 取完整 durl"，那是错的**：
> 它能做到"切集能播完整集"，但把画质锁死在 720P，用户点 4K 就是"切换失败"。
> 同一个 cid 实测：`fnval=4048 → quality 120 / 19 轨 dash`，`fnval=0 → quality 64 / 单段 durl`。
> 旧方案收在文末「被放弃的方案」。

---

## 实测证据

### 一、`playview` 的响应结构

```json
{
  "code": 0,
  "data": {
    "arc": { "aid": 415131120, "cid": 253153139, "bvid": "…" },
    "play_video_type": "preview",
    "plugins": [{ "name": "OgvPayWall", … }, { "name": "PromptBar", … }],
    "video_info": {
      "timelength": 1440000,   ← 注意：这是**整集时长**，不是试看长度
      "quality": 80,
      "format": "mp4",
      "is_preview": 1,
      "durl":  [{ "length": …, "size": …, "order": 1, "url": … }],
      "durls": [ 4 组，每组 6 分钟 ]
    }
  }
}
```

`timelength` 骗人：它是整集元数据，而 `durls` 只有 4 × 360 秒。**不能用 `timelength` 判断能不能播完整集**（与 ADR 0020 里 `isStreamTruncated` 的教训同源）。

### 二、`playurl` 带 `fnval=4048` 拿到完整集 dash（`fnval=0` 只给 720P）

同一个 cid（`32547932835`）两次请求的对照：

```
fnval=4048 → quality 120, dash 19 轨, heights [2160,1080,720,480,360]   ✅
fnval=0    → quality 64,  durl 单段, url 后缀 "1-192"                    ❌
```

`1-192` 里的 **192 = 720P 的 qn 编码**。而且 `fnval=0` **无论 `qn` 传 80 还是 120，
都只返回 720P** —— 这是接口行为，不是参数没传对。

另一个关键差异在 `type` 字段：

| 参数 | `type` | `format` |
| --- | --- | --- |
| `fnval=4048` | `"DASH"`（**字符串**） | `"hdflv2"` |
| `fnval=0` | `3`（**数字**） | `"mp4720"` |

**`type` 连类型都不同**，播放器靠它选管道。当初换成 durl，等于把 dash 管道整条关掉。

### 三、换流后连续切 3 集，全部 4K（修正后真机，2026-10-28 22:00）

整页加载（ep3854820，`ssHit: true`、`dt: 2ms`）后逐档切画质：

| 切到 | UI | `realQ` | **`videoWidth × videoHeight`** |
| --- | --- | --- | --- |
| HDR | HDR 10 4K | 125 | **3840×2160** |
| 4K | 4K | 120 | **3840×2160** |
| 1080P 高码率 | 1080P 高码率 | 112 | **1920×1080** |
| 1080P 高清 | 1080P 高清 | 80 | **1920×1080** |

SPA 切集后连续切 3 集，全部 **3840×2160 / `realQ` 120 / `err: null`**：

```
ep3854818 → dur 1167, 3840×2160
ep3854817 → dur 1711, 3840×2160
ep3854816 → dur 1173, 3840×2160
```

`seekable: [0, 1173]`，可拖到整集任意位置；**没有出现灰屏**。
试看提示条 `.bpx-player-toast-item` 的 `display` 为 `none`（ADR 0022 的隐藏逻辑照常生效）。

### 判据教训

验证"画质切换成功"**只能看 `video.videoWidth × video.videoHeight`**。
`player.getQuality().realQ` 会变，但不代表画面真的换了 —— 实测出现过
`realQ` 从 64 变到 120、`videoWidth` 一直 1920 不动的情况。
`realQ` 只表示"播放器接受了这个档位"，不等于"这条轨真的在解"。

---

## 为什么不选「切集后自动 reload」

也验证过，能用，但体验差：

- reload 后 `duration 1421 / readyState 4`，确实能播
- 代价是每次切集都有 1–2 秒黑屏 + 播放器重建，且会打断「连看」的节奏
- 且需要额外维护 `sessionStorage` 护栏，防刷新循环

既然 durl 换流能做到**用户完全无感**，reload 方案降级为**兜底**：`playview` 换流失败时（比如接口变了）再考虑。

---

## 边界（不做什么）

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 改 `user_status.has_paid` | **不改** | 实测它与能否播放**无关**：整页加载后同样 `has_paid: false`，但能正常播 1421 秒 |
| 改 `arc` / `supplement` | **不改** | 与 ADR 0021 同一套边界 |
| 换 durl（`fnval=0`） | **不做** | 只能拿到 720P，用户在画质菜单点 4K 就是"切换失败"。~~原写"换 dash 不做"~~——那条是躲错方向的产物，见文末「被放弃的方案」 |
| 开 `playview` 的 DNR | **不做** | 开了服务端返回 dash，与播放器按 durl 准备好的管道冲突 → 灰屏 |
| 处理 `durls`（多段） | **删除** | 有 `durl` 时播放器走 `durl`；留着 `durls` 会让它按 4 段试看切片播 |

**能力边界不变**：流由播放账号自己的大会员权益换来，服务端没有被骗。改的只是「播放器本地拿哪条 URL、在哪一秒停」。

---

## 对既有代码的影响

| 位置 | 变化 |
| --- | --- |
| `src/content/main-world.js` | 新增 `playview` 响应拦截（`fetch` 包装）+ **dash** 换流（`pgcSwapPlayviewBody`） |
| `src/core/playinfo/pgc-merge.ts` | 承担 dash 形态的合并；`durl` 只在响应里没有 dash 时作降级 |
| `entrypoints/content.ts` | **SPA 切集路径不再依赖 `pgcHandledCid` / `pgcCacheTried`**；`orchestratePgc` 只在整页加载时跑 |
| `routes.ts` | `playview` 的 `note` 更正（仍 `enabled: false`），`ROUTES_REVISION` 不变（路径与开关都没动） |

ADR 0020 的 P2 缓存链路**保留**：整页加载仍然靠它在 `__playinfo__` setter 里同步注入
（实测 `patchedAt` 只比 `ssAt` 晚 2ms，有效）。

---
## 被放弃的方案：按 durl 形态换流（2026-10-28 上午）

> 收在这里只为**避免重犯**。它的动机是对的（躲灰屏），代价是画质锁死 720P。

最初为躲灰屏，换流用 `fnval=0` 取 **durl**：它能做到"切集能播完整集"，
但**把画质锁死在 720P**，用户在画质菜单里点 4K 时无轨可切 —— 表现为"切换失败"。
对照数据见上节「二」，`type` 的类型差异也在那里。

**当时为什么看起来是对的**：durl 形态确实能让播放器吃下这条流（`<video src>` 直放、`networkState: 1`），
而换成 dash 曾导致灰屏。但那次灰屏的真正原因是**在 `playview` 上开了 DNR** ——
服务端因此返回 dash，与播放器已按 durl 准备好的管道冲突，**不是"dash 装不进去"**。
定位错了，于是躲错了方向。

**教训**：两种流形态在同一播放器里并存时，判据必须是「播放器按哪个分支准备」，
而不是「哪种形态曾经灰过屏」。
