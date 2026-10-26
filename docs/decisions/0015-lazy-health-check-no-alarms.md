# ADR 0015. 凭据健康只做惰性检查，不做定时保活，也不做 cookie 刷新

日期：2026-10-26
状态：已采纳（**终结 [01-architecture.md](../01-architecture.md) §5.4 与 [04-project-structure.md](../04-project-structure.md) §6 的长期矛盾**）

## 背景

两份文档对"凭据怎么保活"写了**两套互斥方案**，且都还留在仓库里：

| 位置 | 写的什么 |
| --- | --- |
| [01-architecture.md](../01-architecture.md) §5.4（v0.2 时期） | `chrome.alarms` 每 12 小时探活；每 6 小时查 `cookie/info`，`refresh=true` 就执行 `cookie/refresh`，并且要求"先写新版本 → nav 校验 → 成功才提交，失败回滚"的原子刷新 |
| [04-project-structure.md](../04-project-structure.md) §6（实装后） | **惰性检查，不用 alarms**。只在 popup 打开（`checkedAt` 超 6 小时）、`page/activate` 成功/失败、用户点"重新检查"三个时机触发 |

代码按后者实现：`src/background/handlers/account.handler.ts` 走 `needsRecheck()` + `HEALTH_TTL_MS`，
`wxt.config.ts` 的 `permissions` 里**没有** `alarms`。所以 01 §5.4 是过期描述。

## 决策

**以 04 §6 为准。P3 只做"惰性检查 + 用户手动重查"，不做定时保活，不做 `cookie/refresh`。**

具体地：

1. **不申请 `alarms` 权限**，不加任何定时任务。
2. **不实现 `cookie/refresh`**（也不做它的"原子刷新"配套）。
3. 失效的发现依赖三个既有信号：popup 打开时的 6 小时窗口、用户点"重新检查"、`page/activate` 的真实取流结果。

## 理由

### 为什么不能有定时任务

`incognito: "split"` 下普通/无痕是**两个独立 SW 实例**，只共享 `storage.local`。
定时任务跑在哪个实例不确定，两个实例会互相覆盖健康标记——**这是"状态自己打架"的经典成因**，
比"没检测到失效"更难排查。

### 为什么不做 cookie 刷新

`cookie/refresh` 的语义是**让旧 `SESSDATA` 立即失效**。一旦走到"写入新值 → 校验 → 失败回滚"，
失败路径的后果是把用户踢下线——而收益只是"凭据能多活一阵"。

权衡极不对称：

| | 不做刷新 | 做刷新 |
| --- | --- | --- |
| 正常情况 | 凭据到期后失效，用户重扫一次 | 凭据延寿，用户不用管 |
| 失败情况 | — | **用户被登出**，且需要重新扫码 |
| 出错时的可解释性 | "过期了，重扫" | "莫名其妙被登出" |

对一个"临时看个 4K"的工具来说，第二种失败体验远比第一种糟。
**而且这条路没有任何实测支撑**——`cookie/info` 的返回语义、刷新后的宽限期，全都没验过。

### 为什么"发现不了失效"可以接受

失效的真实后果是**画质回退**，不是数据错误。而画质回退本身有两个既有信号能反映：

- `page/activate` 的取流结果（`stats` 的环形缓冲，popup「已降级」状态用）
- 用户自己看到"怎么又只有 1080P 了"，打开 popup 就会触发 6 小时窗口检查

用户既不开 popup 也不看视频的时候，失效本来也不需要被发现——那种场景下没有任何请求会用到凭据。

## 被放弃的方案

| 方案 | 放弃原因 |
| --- | --- |
| `chrome.alarms` 定时探活 | split 下两个实例互相覆盖健康标记；且需要多申请一个权限 |
| `cookie/refresh` + 原子刷新 | 失败即踢下线；语义未实测；收益远小于风险 |
| 在 SW 启动时强制探活 | SW 启动很频繁（30s 休眠后随时醒），会把探活变成事实上的高频轮询 |

## 后果

- `01-architecture.md` §5.4 的保活策略段改为引用本文（已改）
- `01-architecture.md` §9 的 P3 清单删掉「cookie 保活 / 失效恢复 / 原子刷新」（已改）
- `wxt.config.ts` 的 `permissions` 保持不含 `alarms`，**不要为了"以后可能要用"提前加**
- 用户可能长期不知道凭据已失效——由 popup 的「凭据失效」态和成功率条形图承担告知责任

## 相关

- [04-project-structure.md](../04-project-structure.md) §6「凭据健康检查：惰性，不用 alarms」——本决策的落地描述
- `src/core/auth/health.ts`：`needsRecheck` / `FAILURE_THRESHOLD`（连续 2 次"无法确认"才降级为失效）
- `src/core/auth/account-info.ts`：`HEALTH_TTL_MS = 6h`，只有 `-101` 才算确定失效
