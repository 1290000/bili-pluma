# 页面侧接口：读状态 / 拨开关（bsk 自动化用）

> **给谁看**：接手本项目的 AI 代理。**要在真机上验证 Pluma 行为时，直接照抄本文的片段**，
> 不要去翻 `content.ts` 从 2000 行里找调用方式。
>
> **权威位置**：实现见 `entrypoints/content.ts` 的两条 `postMessage` 桥
> （`snapshot` / `set-proxy`）。本文只写**怎么调**，不复制实现。

---

## 0. 为什么需要这两条桥

Pluma 的 popup / options 是 `chrome-extension://` 页面，**bsk 沙箱读不到**
（见 `browser-skill-setup.md` §7b）。而主世界又没有 `chrome.storage`。

所以 content script 开了两条 **页面 → content** 的 `postMessage` 桥：

| 桥 | 方向 | 能力 |
| --- | --- | --- |
| `snapshot` | 读 | 返回 popup 会渲染的完整快照（**不含凭据**） |
| `set-proxy` | 写 | 切换**总开关**（只允许布尔值，不开放其它键） |

---

## 1. ⚠️ 调用方式：必须用 `async IIFE` + 内部 `await`

**这是最容易踩的坑。** `bsk evaluate` 的 `--await-promise` 虽然默认为 `true`，
但那只 await **表达式的最终值**——`JSON.stringify(somePromise)` 会在 await **之前**就执行，
得到一个空对象 `{}`（实测过，两条桥都返回 `{}`，看起来"成功"其实什么都没拿到）。

**正确形态**：整个表达式是一个 async IIFE，**内部 await 完再 stringify**。

```js
(async () => {
  const r = await <Promise>;
  return JSON.stringify(r);
})()
```

---

## 2. 读：`snapshot`

```js
(async () => {
  const snap = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('snapshot-reply 超时')), 4000);
    const h = (e) => {
      if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply') {
        clearTimeout(t);
        window.removeEventListener('message', h);
        resolve(e.data.snapshot);
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
  });
  return JSON.stringify(snap);
})()
```

**返回的字段**（实测 566 字节）：

| 字段 | 内容 |
| --- | --- |
| `view` | 本页取流数据（轨道、画质对比） |
| `primary` | 主账号摘要（uname / mid / vipLabel / expireAt / healthy） |
| `playbackAccount` | 播放账号摘要（同上五项，**不含凭据**） |
| `unlock` | 解锁判定文案 |
| `page` | pageKey / p / 页面类型 |
| `proxy` | 总开关状态 |
| `texts` | 渲染文案 |

> ⚠️ `page/snapshot:ok` 里**没有任何凭据字段**（`AGENTS.md` §5.2），
> 序列化后 grep 的断言在 `tests/unit/core/ui/page-snapshot.test.ts`。

### 完整命令

```bash
# 1) 拿 session 和 tab
bsk session start --no-focus --json                        # → session_id
bsk navigate --session <sid> "https://www.bilibili.com/bangumi/play/ep341217"
#                                                          → "tab=<数字>"

# 2) 等页面稳定（番剧页约 9-10 秒播放器才起）
bsk wait-ms 9000

# 3) 读（把上面那段表达式整个传进去）
bsk evaluate --session <sid> --tab-id <tab> "(async () => { ... })()"
```

---

## 3. 写：`set-proxy`（切换总开关）

```js
(async () => {
  const r = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('set-proxy-reply 超时')), 5000);
    const h = (e) => {
      if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'set-proxy-reply') {
        clearTimeout(t);
        window.removeEventListener('message', h);
        resolve(e.data);
      }
    };
    window.addEventListener('message', h);
    // enabled 必须是**布尔值**：字符串 "false" / 1 / null 一律拒绝
    window.postMessage({ __ns: '__PLUMA__', type: 'set-proxy', enabled: false }, '*');
  });
  return JSON.stringify(r);
})()
```

**应答**（实测）：

```json
{"__ns":"__PLUMA__","type":"set-proxy-reply","ok":true,"enabled":false}
```

失败时带 `ok:false` 与 `error`（例如 `enabled 必须是布尔值`）。

### 安全边界（**别扩大**）

这条通道被硬限制在：

- **只有一个目标**：总开关（`pluma:proxy-enabled`），**不开放任意 key**
- **只接受 `true` / `false`**（严格 `===` 判断）
- 走与 popup 完全相同的 `proxy/set` 消息，所以"关开关 → 删两类 DNR 规则"的语义不变

即使页面脚本伪造，最坏效果是**帮用户点了一下总开关** —— 用户本来就能点。
**不能借此读凭据、改白名单、改账号。**

> ⚠️ **不要**用 token 给这条通道加防护：`CHANNEL_TOKEN` 会 `postMessage` 到 `'*'`，
> 页面脚本加个监听器就能拿到。拿页面能读到的值当权限凭证是自欺。

---

## 4. 典型验证流程（关开关 → 刷新 → 画质回落）

这是验收第 5 条的脚本骨架：

```bash
# 1) 读当前快照，确认既在生效（proxy.enabled = true）
bsk evaluate --session <sid> --tab-id <tab> "<snapshot 表达式>"

# 2) 关总开关
bsk evaluate --session <sid> --tab-id <tab> "<set-proxy false 表达式>"

# 3) 刷新页面，等播放器起来
bsk reload --session <sid> --tab-id <tab>
bsk wait-ms 12000

# 4) 读画质：应该回落到主账号上限（1080P）
node poc/probe/verify-pgc-by-snapshot.mjs <sid>          # 时长判据
#   或用 snapshot 读画质按钮文案

# 5) 恢复开关
bsk evaluate --session <sid> --tab-id <tab> "<set-proxy true 表达式>"
```

> ⚠️ **第 3 步要注意**：关开关后刷新，`pageState` 是**新页面重新建立的**，
> 旧的 `tab` 号可能失效（SPA 不失效，整页 reload 不变）。
> 拿不到就读 `bsk tab list --session <sid>` 重新对。

---

## 5. 另外两条不用桥的读法

有时**不需要**碰扩展的内部状态，只用页面可见事实就够了 —— 这两种更稳（passive read）：

| 手段 | 命令 | 用途 |
| --- | --- | --- |
| 播放时长判据 | `node poc/probe/verify-pgc-by-snapshot.mjs <sid>` | 总时长 > 180s = 完整集（**跨 bsk 版本可用**） |
| 原始语义树 | `bsk snapshot --session <sid> --json` | 看画质按钮、播放进度等 DOM 文本 |

**优先用这两个**：它们不执行脚本、没有副作用，且不依赖扩展的内部对象。

---

## 6. 不适合用桥的场景

| 场景 | 为什么 | 用什么 |
| --- | --- | --- |
| 读 `window.__PLUMA_PGC__`（主世界诊断） | 它在 MAIN world，桥在 ISOLATED world，够不到 | `evaluate` 直接读 |
| 读 `swapCount` / `swapSkip` | 同上 | 同上 |
| 改白名单 / 改账号 | **桥刻意不支持** | 只能改代码或走 popup |

`window.__PLUMA_PGC__` 与 `__PLUMA_HANDSHAKE__` 是主世界挂在 `window` 上的诊断对象，
**`evaluate` 能直接读**（实测在 bsk 0.3.3 下 B站动态页也可用）。例：

```
bsk evaluate --session <sid> --tab-id <tab> "JSON.stringify(window.__PLUMA_PGC__)"
```
