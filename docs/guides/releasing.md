# 发布流程

> 分发方式见 [ADR 0018](../decisions/0018-ship-built-artifacts.md)：**不上架商店、不发 crx、可以发 zip
> 但必须同时提供带源码的版本**。本文负责**怎么发**（命名、结构、步骤、文案），
> 为什么这么发归 ADR 0018，不在这里复述。

---

## 红线（在任何情况下都不要越过）

| 红线 | 原因 |
| --- | --- |
| **不上架 Chrome / Edge 商店** | B站投诉后必下架；且"修改请求头"类扩展审核本就严格。详见 Q16 |
| **不发 crx** | 商店签名的 crx 才是可安装的；自己签的浏览器直接拒绝，发了只会制造"下载了装不上"。见 [ADR 0018](../decisions/0018-ship-built-artifacts.md) |
| **发 zip 必须同时发 `-with-source` 版** | 让产物可被独立重建比对。**这是唯一能区分"构建产物"与"黑盒分发"的凭证** |
| **不提供跳过付费墙的能力** | 这是能否站住的分界线，也是免责声明里"不绕过付费墙"这句话的前提（见 Q4） |
| **不做任何形式商业化** | 收钱会把性质从"个人工具"变成"商业服务"（见 Q10） |
| **不主动做 SEO / 推广** | 降低被发现概率（但别指望有效） |
| **不在 README 宣传许可证** | 放显眼位置会给用户"这是正经商业项目"的错觉，放大风险感知 |

---

## 产物命名（唯一规范）

```
pluma-<版本>.zip              构建产物，解压后可在开发者模式加载
pluma-<版本>-with-source.zip  同上 + 完整源码
```

例：`pluma-0.9.0.zip`、`pluma-0.9.0-with-source.zip`

| 规则 | 理由 |
| --- | --- |
| `版本` **取自 `manifest.version`**，不手写 | 手写必然与 `wxt.config.ts` 漂移。脚本自动读 |
| **不带浏览器名**（不写 `-edge` / `-chrome`） | 写了会让用户以为要区分下载。本项目只支持 Chrome+Edge，产物**同一份** |
| **不带日期** | 同版本重打包必须覆盖，不允许两个文件并存（否则用户会问"哪个新"） |
| **不带 `v` 前缀** | `v0.9.0` 是 git tag 的写法，文件名不用，避免两种写法混用 |
| GitHub 自动生成的 `Source code (zip)` **不要重命名** | 名字固定，不会与上面两个冲突 |

---

## zip 内结构（唯一规范）

### `pluma-<版本>.zip` — 扁平，`manifest.json` 在**根**

```
manifest.json          ← 必须在根，浏览器靠它识别
background.js
main-world.js
popup.html
options.html
login-window.html
need-incognito.html
content-scripts/       ← 目录，内含 content.js
chunks/                ← 目录，内含各页面 chunk
assets/                ← 目录，内含 CSS
安装说明.txt            ← 脚本自动生成
```

⚠️ **不许包一层顶层目录**。套一层会解压出 `pluma-0.9.0/manifest.json`，
用户选上层就报「清单文件缺失或不可读取」—— 这是最高频的安装失败原因。

### `pluma-<版本>-with-source.zip` — 产物在子目录

```
extension/             ← 构建产物放这里（结构与上面完全相同）
src/
entrypoints/
public/
scripts/
docs/
tests/
package.json
pnpm-lock.yaml
wxt.config.ts
tsconfig.json
README.md
LICENSE
ADDITIONAL-TERMS.md
```

⚠️ **这个 zip 里不放 `安装说明.txt`**：它里面有源码，放进说明会诱导用户
去加载整个目录（会失败）。安装说明只属于能直接加载的那一份。

### 两个 zip 都不含

`.git/` · `node_modules/` · `.output/chrome-mv3-dev/`（HMR 产物） · `.workbuddy-ai/` ·
`coverage/` · `dist/` · `*.log`

---

## 安装说明.txt（轻量版专用，全文）

> 由脚本生成，标题里的版本号自动替换。**改文案就改这里**，别在脚本里另存一份。

```
Pluma <版本> — 安装说明

一、必须先解压
   不能直接在压缩包里选文件夹。请先右键 → 全部解压到当前文件夹。

二、加载扩展（Edge / Chrome 都一样）
   1. 地址栏输入  edge://extensions  （Chrome 用 chrome://extensions）
   2. 打开左下角「开发者模式」
   3. 点「加载解压缩的扩展」
   4. 选择解压出来的这个文件夹 —— 里面有 manifest.json

   ⚠️ 最常见的错误：选了上一级目录，或者选进了某个子文件夹。
      只要报「清单文件缺失或不可读取」，就是选错了层级。
      正确的层级是「选中 manifest.json 所在的那个文件夹」。

三、第一次使用
   1. 点工具栏的 Pluma 图标
   2. 按提示扫码登录你的大会员账号（会开一个独立窗口，不会动你当前登录的号）
   3. 打开任意 B站视频，画质菜单里应该出现 4K / 1080P60

四、本扩展不做什么
   · 不绕过付费墙（会员专享番剧、电影仍需购买）
   · 不伪装会员标识（界面显示你的真实状态）
   · 不解锁地区限制

五、出问题怎么办
   · 画质没变：确认总开关是开的，并且刷新过页面
   · 提示凭据失效：重新扫码登录播放账号
   · 其他：设置页 →「诊断」分区可以导出诊断信息

许可证：GPL-3.0-only + 附加条款，完整文本见仓库根目录。
本项目与哔哩哔哩官方无任何关联，仅供学习交流使用。
```

---

## 发布流程

### 1. 版本号

规范在 **[versioning.md](./versioning.md)** —— 含为什么是 0.9.0、分段怎么涨、两个硬限制。

只需记住：同步改 `wxt.config.ts` 的 `manifest.version` 与 `package.json` 的 `version`。

### 2. 发布前检查

```bash
# 全部通过才能发
npm run typecheck      # tsc --noEmit
npm run lint           # eslint，含依赖方向规则
npm run check:boundaries   # scripts/check-boundaries.ts
npm test               # vitest，core 层单测
npm run build          # 打包，检查产物体积
```

### 3. 打包

```bash
node scripts/package.mjs
```

产出 `dist/pluma-<版本>.zip` 与 `dist/pluma-<版本>-with-source.zip`。
脚本会自检：`manifest.json` 在根、版本号一致、不含被排除的目录。任一不符直接报错退出。

### 4. 人工冒烟测试（**硬性，不可省**）

这是唯一无法自动化的环节 —— 它验的是"用户拿到 zip 之后能不能装上"。

**必须用 zip 本身验，不能直接加载 `.output/`**：

```bash
# 解压到临时目录（模拟用户操作）
```

- [ ] 解压 `pluma-<版本>.zip` → 打开 `edge://extensions` → 加载解压缩的扩展 → **能装上**
- [ ] 装完 badge 出现小圆点 → popup 显示"未配置"
- [ ] 扫码登录播放账号 → popup 显示"已接管"
- [ ] 打开 4K 视频 → 画质菜单出现 4K/1080P60 → 实际播放 ≥2160p
- [ ] 点赞一条视频 → 记在主账号
- [ ] 播放 30 秒 → 历史出现在主账号
- [ ] 关掉总开关 → 刷新 → 画质回落到 1080P（判据见验收清单 §5）
- [ ] 打开非视频页 → popup 显示"未生效"

### 5. 更新 CHANGELOG.md

格式见 [release-notes-template.md](./release-notes-template.md)。**不要写"修复了某某接口破解"
这种措辞**，全部用中性描述。

### 6. 打 Tag 并发布

```bash
git tag -a v0.9.0 -m "v0.9.0"
git push origin main --tags

gh release create v0.9.0 \
  dist/pluma-0.9.0.zip \
  dist/pluma-0.9.0-with-source.zip \
  --title "Pluma 0.9.0" \
  --notes-file dist/release-notes.md
```

**Release 说明按 [release-notes-template.md](./release-notes-template.md) 写**，
脚本会把模板填好版本号落在 `dist/release-notes.md`。

⚠️ 只上传这两个 zip。GitHub 自动生成的 `Source code (zip)` 保留，不要删也不要改名。

---

## 收到律师函怎么办

这件事的预案写在 [03-open-questions.md](../03-open-questions.md) 的 Q16。这里只列动作要点：

1. **不要慌，不要公开发泄。** 前几个项目的作者都很克制，反而保留了社区同情。
2. **archived，而不是删除。** 删除会被解读为心虚，归档是体面的处理。
3. **README 换成一封说明**："因收到权利方通知，本项目停止维护"，保留原代码。
4. **不要在 issue 区号召"大家快去 fork"**——这会让事情升级。
5. **区分对方主张**：是不正当竞争（性质较轻）还是著作权侵权（需认真对待）。

**准备这句模板，需要时直接改：**

> 本项目已于 [日期] 收到权利方委托律师事务所的通知，即日起停止维护。
> 仓库代码保持原样供已下载者参考，不再更新，也不提供任何形式的技术支持。
> 感谢所有使用者与贡献者。

---

## 如果将来要改分发方式

> 现状：**发 zip（含源码版）已由 [ADR 0018](../decisions/0018-ship-built-artifacts.md) 授权**。
> 本节是「再往下放宽」（比如上架商店）时要过的关。

**先问自己三个问题**：

1. 这么做能带来什么，是用户真的需要，还是我想让项目"看起来更正式"？
2. 风险增加的部分，我是否愿意承担？
3. 出事了，我能不能承受这个后果？

**任何一条答不上来，就不要改。**

如果确实要上架商店，至少做到：

- 上架前咨询一次法律意见（哪怕只是付费咨询半小时）
- 准备一份"下架就归档"的预案
- 不要在 README 里用"官方""正版"之类的字眼
- 不要用 B 站品牌色（粉色）做图标，避免被误认为官方插件

---

## 相关

- 分发方式决策：[decisions/0018](../decisions/0018-ship-built-artifacts.md)
- Release 说明模板：[release-notes-template.md](./release-notes-template.md)
- 待确认问题 Q16（分发与预案）：[03-open-questions.md](../03-open-questions.md)
- 协议决策：[decisions/0003](../decisions/0003-gplv3-with-additional-terms.md)
- 合规表述：同文档 Q10
