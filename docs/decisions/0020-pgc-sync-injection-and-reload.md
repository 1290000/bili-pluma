# ADR 0020. PGC 完整流：`sessionStorage` 同步注入 + 二次加载

- 日期：2026-10-28
- 状态：**已采纳**（整页加载路径，真机验证通过）
- 部分取代：[ADR 0019](./0019-pgc-async-playurl-injection.md) 的「hook 异步回调」路线
- 不适用于：**SPA 切集**（那条路 `__playinfo__` 根本不赋值，见
  [ADR 0023](./0023-intercept-playview-durl-swap.md)）

---

## 背景：ADR 0019 的路线被实测否掉

ADR 0019 的核心做法是 hook 播放器的 `requestConfig.reqHttpPlayUrlInfo` 回调，
在回调里异步喂完整流。它是基于 R3 那条实测设计的：

> 删掉 `config.prefetch.playUrl` 后，播放器会回退调用 `reqHttpPlayUrlInfo`（`hits=1` 且仍能播）

**但"会调用"和"会用返回值"是两件事。** 真机验证：

| # | 做法 | 结果 |
| --- | --- | --- |
| 1 | 用**页面自己的容器** + 完整集数据建播放器 | `cbCalled: 0`，`duration` 仍 360 |
| 2 | Proxy 记录属性访问 | 播放器只 `get prefetch` / `get requestConfig`，**一次都没读 `.playUrl`**，且有 `Symbol.toStringTag` 访问 → 它在做类型判断，手造对象被忽略 |
| 3 | 查 PGC 的 `video_info` 形状 | 里面有 `dash`（免费集）或 `durl`/`durls`（试看集），**回调只是装饰** |

**结论：回调这条路走不通。** 接口数据本身是对的（`timelength: 1440083`、`dashGroups: 16`），
问题在播放器不消费回调返回值。

---

## 决定：`sessionStorage` 同步注入 + 二次加载

```
第一趟：页面正常播试看
        ISOLATED 取完整流 /pgc/player/web/playurl → 写缓存 → location.reload()
第二趟：ISOLATED 预读缓存 → cfg.pgcVideoInfo → 主世界在 __playinfo__ 的 setter 里
        **同步**替换 video_info 的流字段 → 播放器读到的就是完整时长
```

### 为什么「同步」是硬要求

`createPlayer` 就在 `__playinfo__` 赋值后 **0~2ms** 被调用（实测 409ms 赋值、409ms 调用）。

而走异步通道的时间开销（真机 trace）：

```
chrome.storage 读 → postMessage 排队 → 106 KB 结构化克隆  ≈ 1.6 秒
```

**必然错过那个窗口。** `sessionStorage` 是同步 API，主世界在 setter 里直接
`getItem()`，微秒级完成。所以两份都要写：

| 存储 | 角色 |
| --- | --- |
| `storage.local` | 跨标签页、可清理、有 LRU（`PGC_CACHE_MAX = 8`） |
| `sessionStorage` | **同步读**，专供注入（`pluma:pgc-vi:{cid}`） |

真机对比（同一个 cid）：

| 趟次 | `sessionStorage` | `ssAt` | `patchedAt` | 差值 | `duration` |
| --- | --- | --- | --- | --- | --- |
| 第一趟 | 空 | 613 | 1842 | **1229ms** | 180（试看） |
| 第二趟 | 命中 | 476 | 478 | **2ms** | 1169（完整） |

**差 1.2 秒就是"能看完整集"和"只能看 6 分钟"的分界线。**

### 两个必须刷新的场景

| 场景 | 判据 | 为什么 |
| --- | --- | --- |
| `storage.local` 有缓存、但 `sessionStorage` 为空 | `hadSync === false` | 同步缓存刚写好，这一趟的注入已经错过了 |
| 完全无缓存（首访新集） | `loadCachedVideoInfo` 返回 `null` | 要先取流、写缓存，再进第二趟 |

**两者都要刷一次进第二趟。** 少了任何一个，用户就停在 180 秒试看，
而试看状态下切 4K 找不到轨 → 表现为"切换画质失败"。

---

## 三条护栏（`pgc-reload-plan.ts`，纯函数，有单测）

这条链路最危险的失败模式是**刷新循环**：取流失败 → 还是没缓存 → 再取 → 再刷。

```ts
shouldReload({ alreadyTried, hasStream })
```

| 护栏 | 作用 |
| --- | --- |
| `hasStream` | 取流结果里真的有流。没流还刷就是死循环（最危险的一条） |
| `alreadyTried` | 同一集同一会话只刷一次（`sessionStorage` 一次性标记 + 10 分钟 TTL） |

### ⚠️ 曾经有第三条 `active`，2026-10-28 移除

原来还有 `active`（`page/activate` 的异步回复，即 `badgeState.proxying`）。真机现场：

```
pluma:pgc-vi:{cid}     → 写入成功（19 轨 dash，含 2160p）
pluma:pgc-reload:{cid} → 从未写入
video.duration         → 180，观察 25 秒不动
页面角标                → 没画（badgeState.proxying === false）
```

`page/activate` 的回复晚到或失败就是 `false` → **明明取到了完整流却不刷新**。

而这条护栏**本来就是多余的**：能通过 `credentials: 'include'` 取到播放账号的
4K dash，本身就已经证明 DNR 换 Cookie 生效了 —— 那是取流成功的前提。
总开关关掉时取流会 `denied` 或降级，由 `fetchPgcPlayurl` 的 `kind !== 'ok'` 提前拦住。

---

## 边界

| 项 | 决定 |
| --- | --- |
| 改 `user_status.has_paid` | **不改**。实测与能否播放无关：整页加载同样 `has_paid: false`，但能正常播完整集 |
| 改 `arc` / `supplement` | **不改**（与 ADR 0013 同一套字段边界） |
| 试看标记 | **改**（ADR 0021 授权，`play_video_type` / `play_check.play_detail` / `is_preview`） |
| 试看提示条 | **隐藏**（ADR 0022 授权，只在注入成功之后） |
| 刷新前记播放位置 | 记，第二趟由 `restoreResumeTime` 拉回 |

**能力边界不变**：流由播放账号自己的大会员权益换来，服务端没有被骗。

---

## 真实代价

**用户会看到一次刷新。** 首访新集时：打开 → 闪一下（1~2 秒）→ 完整集。

比旧版好的是"立刻刷"：旧版要等 `currentTime > 2` 才判定，
用户会先看到试看、一直播到 6 分 01 秒才被弹窗打断。

---

## 相关

- 被取代：[ADR 0019](./0019-pgc-async-playurl-injection.md) 的 hook 回调路线
- 互补：[ADR 0023](./0023-intercept-playview-durl-swap.md) —— SPA 切集走响应层，不走本文这条
- 相关：[ADR 0021](./0021-patch-pgc-preview-flags.md)（试看标记）、
  [ADR 0022](./0022-hide-pgc-preview-toast.md)（隐藏提示条）
- 进度与实测数据：`.workbuddy-ai/analysis/PGC-STATUS.md`
