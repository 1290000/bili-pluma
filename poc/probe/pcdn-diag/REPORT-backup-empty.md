# `backup_url: []` 播放器接不接受（2026-11-17）

脚本：`poc/probe/pcdn-diag/backup-empty-acceptance.mjs`　原始数据：`backup-empty-acceptance.json`（gitignored）
样本：`BV1oFsW6oEs5`（2160×3840 竖屏 4K，三条 2160p 轨的 base 全是官方域），播放器实际在用
`id=120 / codecid=12(HEVC)` 那条，候选 3 条：`cn-cq-gd-bcache-22` + 2 条 backup。

| 项 | A 基线（不改造） | B `backup_url: []` | C 毒化对照（`base_url` → 不存在的 host） |
| --- | --- | --- | --- |
| `video.readyState` | **4** | **4** | **4** |
| `video.error` | `null` | `null` | `null` |
| `videoWidth×Height` | 2160×3840 | 2160×3840 | 2160×3840 |
| 该轨 base host 有没有发请求 | 有（`cn-cq-gd-bcache-22` …`-1-30121.m4s`） | **有**（同一个 base host，改写后 `backupBefore 2 → backupAfter 0`） | 有：先打 `pluma-probe-nx`（毒化生效）→ 再落 `upos-sz-mirrorzos`（backup） |
| 重连到 CAN_PLAY_THROUGH | — | **632ms**（`t0 68670 → t4 69302`） | 约 1.5s（先等毒化 host 失败再回落） |

**结论：接受。** 只剩 `base_url` 一条、`backup_url` 为 `[]` 的 2160p 轨，播放器照常播到
`readyState=4`、`2160×3840`、`error=null`。

## 这个结论为什么可信（Run C 的作用）

"改完还能播"本身证明不了什么 —— 也可能播放器根本没用改过的那份响应（吃的是旧 dash）。
Run C 把同一条轨的 `base_url` 换成 `pluma-probe-nx.bilivideo.com`，实测请求链是：

```
pluma-probe-nx.bilivideo.com/…-1-30121.m4s   ← 毒化 host 被真的请求了 ⇒ 新响应确实被采用
→ upos-sz-mirrorzos.bilivideo.com/…-1-30121.m4s   ← 失败后回落到 backup_url
```

⇒ 改写过的响应是权威的，所以 B 的"还能播"是「空数组被接受」，不是「没生效」。

## 顺带两条

1. **`backup_url` 是有效冗余**：C 里 base 挂掉后播放器自动落到 backup，也就是说
   过滤掉 PCDN 备份**确实降低了容错面**（这正是 15/24 条 4K 轨只剩 1 条官方候选的代价）。
2. 起播耗时**不可直接比**：A 是整页冷启动（8972ms，含页面加载），B 是热重连（632ms）。
   本次只有 `readyState`/`error`/分辨率三项可比。

## 复现

```bash
npx tsx poc/probe/pcdn-diag/backup-empty-acceptance.mjs
```

⚠️ 单次 `evaluate` 别阻塞太久：第一版把"等环境 + 拉 4K + 采样 20 秒"塞进一个 evaluate，
bsk daemon 直接报 `reaping unresponsive browser (no heartbeat within liveness window)`，
浏览器被判失联、会话全丢。现在改成**页面里 `setInterval` 采样 + Node 侧每 ~1.5 秒短读**。
