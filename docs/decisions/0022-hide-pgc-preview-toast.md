# ADR 0022. 允许隐藏 PGC 播放器里的「试看中」提示条

日期：2026-10-28
状态：已采纳（用户明确指示）
不推翻：[ADR 0021](./0021-patch-pgc-preview-flags.md)（只改播放数据里的三个标记，不碰 `user_status`）

---

## 背景

PGC 接管页在注入完整流之后，播放器左下角仍会显示一条提示：

```
.bpx-player-toast-text
  └ .PromptBar_container__dxyIw      （308×49，位于画面左下 (59, 363)）
      ├ .PromptBar_title__46RWS      「本片是大会员专享内容」
      ├ .PromptBar_subtitleText      「试看中·成为大会员免费看本片」
      └ .PromptBar_btnItemWrap       「成为大会员」按钮
```

这条提示的判据不在 `__playinfo__` 里（ADR 0021 实测改那三个字段对播放器无效），
而是播放器根据**账号权益**自行渲染的 —— 也就是 `user_status.has_paid` 那条线。

它会**遮挡画面左下角**，用户明确反馈"很影响观看体验"。

## 决策

**在 PGC 接管页隐藏「试看提示」那一条 toast 消息**，方式为 `display: none`。

### 必须先看清层级（2026-10-28 两次藏错之后实测出来的）

```
.bpx-player-toast-wrap                 透明        (43,386) 32×33
  └ .bpx-player-toast-row.bpx-player-toast-un
      └ .bpx-player-toast-item          ★ 黑底在这里  rgba(25,25,25,0.88)
          └ .bpx-player-toast-text      透明（只有文字）
              └ div
                  └ .PromptBar_container__dxyIw   透明
                      ├ .PromptBar_title      「本片是大会员专享内容」
                      ├ .PromptBar_subtitle   「试看中·成为大会员免费看本片」
                      └ .PromptBar_btnItemWrap「成为大会员」
```

**两次都藏错了层，各有一个后果：**

| 藏哪 | 后果 |
| --- | --- |
| `.bpx-player-toast-text`（第一版） | **黑底还在**（黑底在更外一层 `.toast-item` 上），且会把同一父容器下的其它消息一起藏掉 |
| `.PromptBar_container`（第二版） | 文字没了，但黑底仍在 —— 因为 `.toast-item` 才是背景层 |

### 正确策略

`.bpx-player-toast-item` 是**逐条消息**的容器：试看提示、跳过片头、**续播提示**、
「从头开始播放」都会各自生成一个 item。

所以：

```js
// 遍历所有 toast-item，只藏"内部含 PromptBar"的那些
for (const el of document.querySelectorAll('.bpx-player-toast-item')) {
  if (!el.querySelector('[class*="PromptBar"]')) continue;  // ← 关键筛选
  el.style.display = 'none';
}
```

**这个筛选条件必须保留**，它同时保证了三类消息不被误伤 —— 用户明确点名过：

1. **跳过片头 / 片尾**（位置因集而异，有些集根本没有）
2. **续播提示**（"上次看到 xx:xx，是否继续"）
3. **从头开始播放**

它们的 item 里**没有** `PromptBar`，所以天然不被碰。
（2026-10-28 实测：人为构造这四种 item，跑同一套筛选逻辑，结果只有试看那条被隐藏，
其余三条 `display` 仍是 `inline-flex`。）

### 三条硬边界（不满足就不许隐藏）

1. **只在 PGC 播放页**（`IS_PGC`）。普通视频页的 toast 是正常功能提示，一律不动。
2. **只在真的注入了完整流之后**才隐藏。
   没注入就隐藏 = 用户看不到"这是试看"、却只能看 6 分钟 —— 那比显示更难排查。
3. **只操作用 `.bpx-player-toast-item` + `PromptBar` 筛出来的节点**。
   不扩大到 `.bpx-player-*` 的其它层，也不改父容器的样式（父容器里还有别的消息）。

## 为什么这不是「伪造权益」

判别标准仍然沿用 ADR 0021 的那一条：**流是服务端按谁的权益发的？**

- 流由 `/pgc/player/web/playurl` 发出、Cookie 被 DNR 换成**播放账号**的
  —— 是它自己的大会员权益换来的，服务端一点没被骗。
- `user_status.has_paid` **仍然保持 `false`**，任何接口响应都没有被伪装。
- 隐藏的只是一个**本地渲染的提示条**，不产生任何取流能力：
  如果播放账号没有该集权益，服务端照样只给 6 分钟试看，把提示藏起来也播不动。

**与 ADR 0021 的区别**：那一份改的是"这份数据是不是试看"（数据层），
这一份只是"不要把已经过时的那句提示显示出来"（渲染层）。
两者都**不改服务端的权益陈述**。

## 明确不做的

| 不做 | 理由 |
| --- | --- |
| 改 `user_status.has_paid` / `vip_info` | 那是服务端对账号权益的陈述，改了是纯谎报 |
| 隐藏整个 `.bpx-player-*` 提示层 | 会连带吃掉真实错误提示（网络、解码、画质） |
| 在没有注入完整流的页面上隐藏 | 用户会以为能看，实际还是 6 分钟 —— 更坏的欺骗 |
| 用 CSS 注入到页面的样式表 | 必须走 `src/content/main-world.js` 自己的 `<style>` 标签，随开关可拆，且不污染页面样式表 |

## 后果

- `src/content/main-world.js` 新增 `PGC_TOAST_SELECTOR = '.bpx-player-toast-text'` 常量，
  与 `PATCH_PATHS` / `PROGRESS_PATCH_PATHS` / `PGC_PREVIEW_FLAGS` **并列不合并**
  （四份清单授权四类不同的改写，合并后就分不清哪条为了什么）
- `scripts/check-patch-scope.mjs` 增加第四组校验：选择器必须与本文档一致
- 新增测试：只在注入成功后隐藏 / 没注入不隐藏 / 普通视频页不隐藏
- **已知副作用**：如果 B 站改版把这个类名换掉，隐藏会静默失效
  —— 表现为"提示又出现了"，不影响播放。这是可接受的退化方向

## 相关

- 路线与实测记录：`.workbuddy-ai/analysis/PGC-STATUS.md`
- 提示条的 DOM 结构来自 2026-10-28 在 `ss34412` 上的现场抓取
