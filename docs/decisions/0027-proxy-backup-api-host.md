# ADR 0027：代理主机白名单必须包含 `api.biliapi.net`

- 状态：**已采纳**（2026-10-29，真机抓包确认）
- 影响文件：`src/shared/constants/routes.ts`（`BILI_API_HOSTS`）、
  `src/platform/http/dnr.ts`（`requestDomains`）、`src/content/main-world.js`（`PATCH_HOSTS`）
- 相关：ADR 0006（常驻规则、不用 nonce）、ADR 0013（会员字段改写）

---

## 事故：限免集切 4K 失败

用户报「限免和免费的集数切换大会员才能观看的画质会切换失败」。

现象很有误导性：**画质菜单显示已切到 4K，但画面仍是 1920×1080**，
并且弹出一个失败提示。既不是灰屏，也不是报错。

抓包（`bsk network`）抓到决定性证据：

```
200 api.bilibili.com/pgc/player/web/playurl?cid=…&qn=120&fnval=4048  → 返回 2160 ✅
200 api.biliapi.net/pgc/player/web/playurl?cid=…&qn=120&fnval=4048   → 返回 480  ❌
200 …/log/web…ctrlbar_quality|{"targetQn":120,"currentQn":1080}
200 …/log/web…quality_toast_show|{"TBD":3}                            ← 失败提示
```

单独复测两个域名（同一 cid、同一 `qn=120`、同一 `credentials: 'include'`）：

| 域名 | 返回最高高度 | 为什么 |
| --- | --- | --- |
| `api.bilibili.com` | **2160** | DNR 命中，Cookies 被换成播放账号 → 有大会员权益 |
| `api.biliapi.net` | **480** | DNR 的 `requestDomains` 不含它 → 主账号身份（无大会员） |

**播放器对同一次画质切换会向两个域名各发一条请求**，然后采用备选域名那条的结果。
于是：主域名拿到了 4K，备选域名只拿到 480，播放器用它 → 判定切换失败。

---

## 决定

把 `api.biliapi.net` 加进三处域名白名单：

| 位置 | 常量 | 作用 |
| --- | --- | --- |
| `src/shared/constants/routes.ts` | `BILI_API_HOSTS` | DNR 的 `requestDomains` |
| `src/platform/http/dnr.ts` | 引用上面那个 | 换 Cookie 的规则终于覆盖备选域名 |
| `src/content/main-world.js` | `PATCH_HOSTS` | 响应体改写（会员字段伪装） |

⚠️ **三处缺一不可**，而且失效方式是静默的：

- 只加 DNR 不加 `PATCH_HOSTS` → 备选域名换了 Cookie 但会员字段没伪装 → 播放器判「无权限」
- 只加 `PATCH_HOSTS` 不加 DNR → 伪装生效但 Cookie 还是主账号 → 根本拿不到 4K 轨
- 两个都加但 `currentFilter` 缓存判断用旧值 → 需要重新 enable 才生效（`refreshTabRule` 已有比对逻辑）

---

## 这不是扩大越权范围

这是本次 ADR 最需要说清的一点，因为「加域名」听起来像扩大代理面。

| 疑问 | 回答 |
| --- | --- |
| 会不会代理到别的接口？ | 不会。**路径白名单仍然限制着** —— `isProxyPath()` 只放行那几条 playurl，`requestDomains` 只是"域名条件"，两个条件是**与**关系 |
| 是不是同一个身份用途？ | 是。同一个接口（`/pgc/player/web/playurl`）、同一个用途（取流）、同一个身份（播放账号） |
| 会不会影响普通视频页？ | 不会。普通视频走 `/x/player/wbi/playurl`，那个路径在 `api.biliapi.net` 上是否出现未观测到；即使出现，代理它也是**正确**的 |

**唯一真正变化的是**：`api.biliapi.net` 上命中白名单路径的请求会以播放账号身份发出。
这与 `api.bilibili.com` 上的行为完全一致，没有新增"能做别的什么"。

---

## 为什么之前没发现

`poc/verify/RESULT.md` 与 Q2 的并发测试都只对 `api.bilibili.com` 造请求。
**测试用的是"我们以为的接口地址"，而不是"播放器实际会去的地址"。**

教训：代理类工具的验证必须**从真实流量里取域名**，不能从文档里取。
本次是用 `bsk network` 抓页面实际请求才发现的 —— 而那个清单里
`api.biliapi.net` 出现了，`api.biliapi.net` 上面的 playurl 请求也出现了。

---

## 验证

1. **单测**（`tests/unit/content/main-world-real.test.ts`）：读 `main-world.js` 源码，
   断言 `PATCH_HOSTS` ⊇ `BILI_API_HOSTS`。主世界是裸 JS，没法 import 常量，
   两边各写一份是必然的 —— 这条测试就是防它们漂移的。
   **反向验证**：把 `PATCH_HOSTS` 退回单域名 → 1 条红。
2. **DNR 并发回归**：`node poc/verify/run-q2-auto.cjs`（AGENTS.md §4.3 强制）
3. **真机**：需要在限免集上实际点 4K 确认画面变成 2160

⚠️ **第 3 条是这条 ADR 的真正验收，而它目前还没做。**
前两条只能证明"配置一致"，证明不了"播放器真的切换成功了"。
