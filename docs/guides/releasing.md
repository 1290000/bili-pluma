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

### `pluma-<版本>.zip` — **平铺**，`manifest.json` 在 zip 根

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

**必须是平铺的。** 这条在 2026-10-27 反复过一次，记录如下。

### 为什么不能包顶层目录（实测结论）

我曾加过一层 `pluma-<版本>/`，想的是"解压后只有一个文件夹可选中"。
**实测发现那是错的。**

Windows 资源管理器「全部解压」时**总是先用 zip 文件名建一层目录**，
再按 zip 内结构展开。所以：

| zip 内结构 | Windows 解压结果 | 结果 |
| --- | --- | --- |
| `pluma-0.9.0/manifest.json` | `pluma-0.9.0/pluma-0.9.0/manifest.json` | **两层**，选外层报「清单文件缺失」❌ |
| `manifest.json`（平铺） | `pluma-0.9.0/manifest.json` | **一层**，直接选 ✅ |

**"解压后的层级"不由 zip 内结构决定，由解压工具决定。**
包里再套一层只会**叠加**，不会替换。

平铺的代价是"用户若选『解压到当前文件夹』会把文件散开"——
但那是用户主动选择，且安装说明给了判据（那层应能看到 `manifest.json`）。
相比之下"每个用 Windows 的人都踩两层"是必然而非偶然。

⚠️ **不要试图用 zip 内目录名去控制解压后的层级。**

### `pluma-<版本>-with-source.zip` — 产物在子目录

同样**平铺在 zip 根**（规则与上面一致）：

```
BUILD.md               ← 构建凭证（package.mjs 生成：commit / Node / wxt / 逐文件 sha256）
extension/             ← 构建产物放这里（manifest.json 在这层）
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

Windows 解压后得到 `pluma-0.9.0/extension/manifest.json`，
用户加载 `pluma-0.9.0/extension`。—— 这个 zip 本来就需要多一层
`extension/`，因为源码要和产物分开摆。

⚠️ **这个 zip 里不放 `安装说明.txt`**：它里面有源码，放进说明会诱导用户
去加载整个目录（会失败）。安装说明只属于能直接加载的那一份。

### 两个 zip 都不含

`.git/` · `node_modules/` · `.output/chrome-mv3-dev/`（HMR 产物） · `.workbuddy-ai/` ·
`coverage/` · `dist/` · `*.log`

---

## 安装说明.txt（轻量版专用）

**全文在 [`assets/install-readme.txt`](../../assets/install-readme.txt)，这是唯一真相源。**

`scripts/package.mjs` 直接读那个文件，把 `{{VERSION}}` 替换成实际版本号后放进 `pluma-<版本>.zip` 的根目录。

| 规则 | 说明 |
| --- | --- |
| 改文案 | **只改 `assets/install-readme.txt`**，本文不复制内容 |
| 版本号 | 用 `{{VERSION}}` 占位符，别写死（写死了必然过期） |
| 只放轻量版 | `-with-source` 版**不放**它 —— 那个包里含源码，放说明会诱导用户去加载整个目录 |
| 编码 | UTF-8 无 BOM，换行 LF（`check-docs` 会拦） |

> ⚠️ 这条规则曾是「把全文写在本文里，脚本去抄」。**已废弃** ——
> 2026-10-27 实测发现改文档不影响产物，因为文案在脚本里另存了一份。
> 现在只有一个文件。

---

## 发布流程：准备

> 打完 tag 之前的所有事。执行部分见下一节。

### 1. 版本号

规范在 **[versioning.md](./versioning.md)** —— 含为什么是 0.9.0、分段怎么涨、两个硬限制。

只需记住：同步改 `wxt.config.ts` 的 `manifest.version` 与 `package.json` 的 `version`。

### 2. 发布前检查

```bash
node scripts/verify.mjs     # 十一项，全绿才能继续
```

`verify.mjs` 已含下面这些，**不要分别手跑**（会漏）：

`typecheck` · `format` · `lint` · `boundaries` · `messages` · `design` ·
`docs` · **`secrets`** · `patch` · `test`

#### ⚠️ `secrets` 这一项是 2026-10-27 补的，起因是真实事故

准备发 0.9.0 时才发现：**测试用的主账号 mid、播放账号 mid、两个昵称**
散落在 11 个文件里（docs 的验证记录、tests 的夹具、poc 的脚本），
而它们**已经被推到了公开仓库**。

当时我做过 `.env` / `SESSDATA` 检查 —— 但**没想到要查 mid**。
mid 不是密钥，可它能直接打开一个人的 B 站主页。

`scripts/check-secrets.mjs` 检查三类：

| 类别 | 例子 |
| --- | --- |
| 禁用的字面量 | 真实账号的 mid / 昵称（**这张表只增不减**，泄露过的值永远留着） |
| 凭据形态 | `SESSDATA=<长值>` / `bili_jct=<32位hex>` / 私钥头 |
| 本机路径 | `C:\Users\<真实用户名>\` |

**假值不算**：带 `fake` / `deadbeef` / `example` 等标记的样例放行
（测试夹具需要真结构，比如 SESSDATA 必须含逗号才测得出分割逻辑）。

#### 发布前还要人眼过的两项（脚本查不了）

- [ ] **提交历史**：`git log -S "<敏感值>" --oneline --all`，确认历史里也没有
  —— 只改文件不够，旧值仍能从历史翻出来
- [ ] **抓包产物**：`poc/verify/` 下的 `bg-ssr.json`、`result-*.json` 不进仓库
  （已在 `.gitignore` 里，但新增文件时容易漏）

---

## 发布流程：执行

### 3. 打包

> ⚠️ **打包前必须先完成 §5（更新 CHANGELOG）并提交。**
> `package.mjs` 有 clean-tree 门：工作区不干净（含未跟踪的新文件）会直接拒绝打包 ——
> 因为 `BUILD.md` 要记录 commit，脏工作区意味着 zip 里的源码不等于任何 commit。
> 同时 `.output` 必须比源码新，否则拒绝（先 build 再打包）。

```bash
node scripts/package.mjs
```

产出 `dist/pluma-<版本>.zip` 与 `dist/pluma-<版本>-with-source.zip`。
脚本会自检：`manifest.json` 在根、版本号一致、不含被排除的目录、工作区干净、
`.output` 不比源码旧。任一不符直接报错退出。

源码版根目录会多一个 **`BUILD.md`**：记录版本、commit、构建命令、Node/wxt/lockfile、
以及 `extension/**` 逐文件 sha256。`verify` 的 `artifact` 项会逐条核对它与 zip 内实际字节；
凭证对不上时 `verify` 会红。

### 4. 人工冒烟测试（**硬性，不可省**）

这是唯一无法自动化的环节 —— 它验的是"用户拿到 zip 之后能不能装上"。

**必须用 zip 本身验，不能直接加载 `.output/`**。

---

#### 分工（2026-10-30 定，**别再自己想办法自动化前两步**）

| 步骤 | 谁做 | 为什么 |
| --- | --- | --- |
| ① 解压 zip 到一个**正式目录** | **Agent** | 纯文件操作 |
| ② 在 `edge://extensions` **手工加载解压缩的扩展** | **人** | 只有 UI 能做，见下 |
| ③ **扫码登录播放账号** | **人** | 凭据换 ID 后必然失效，见下 |
| ④ 跑下面的自动化验收清单 | **Agent** | 用 `bsk` 读真实状态 |

> ⚠️ **`edge://extensions` 必须人来做。** 三条自动化路径都试过、全部失败：
>
> | 办法 | 结果 |
> | --- | --- |
> | `bsk` 操作 `edge://extensions/` | ❌ 沙箱按 URL 白名单挡掉，连截图都拿不到 |
> | 直接改 `Secure Preferences` 的 `path` | ❌ **2026-10-30 实测：扩展注册项被 Edge 整个丢弃** —— 该文件有 `protection.macs` 覆盖 `extensions` 字段，手改后 MAC 校验失败，Edge 判定被篡改 |
> | 复用 `reload-extension.mjs` | ❌ 它的目标目录**写死 `.output/chrome-mv3`**，不能指向 zip 解压目录；且它只重启浏览器，**不负责新增注册项** |

> ⚠️ **凭据搬运不可靠，默认按"要重扫"安排。** 切换加载目录 → 扩展 ID 变 →
> `Local Extension Settings/<id>/` 换目录。虽然 AES 密钥是随机生成、**不绑定扩展 ID**
> （`src/core/vault/vault.ts` 的 `saveCredential`），理论上整目录复制即可解密，
> 但 2026-10-30 实测**复制后扩展仍读不到**（`hasCredential: false`）——
> Edge 在扩展加载时就绑定了存储路径，复制到已打开目录不生效。
> 所以**不要指望搬运**，直接让用户扫码，最省事也最可靠。

---

#### ① Agent 准备（解压到正式目录）

解压到 `dist/smoke-<版本>/`，**不要解压到 `.tmp/`**（隐藏目录，且是临时语义）：

```bash
# 目录必须在 zip 里 manifest.json 的同一层（平铺）
mkdir -p dist/smoke-<版本>
# 用你手边的解压工具解到该目录，确认 dist/smoke-<版本>/manifest.json 存在
node -e "console.log(require('./dist/smoke-<版本>/manifest.json').version)"   # 必须等于发布版本
```

#### ② 人：手工加载

1. 打开 `edge://extensions`，确认「开发人员模式」已开
2. 点「加载解压缩的扩展」→ 选 **`dist/smoke-<版本>`**（不是 `.output/chrome-mv3`）
3. 记下新扩展 ID（页面上能看到）

#### ③ 人：扫码登录播放账号

点扩展图标 → 「扫码登录播放账号」→ 用大会员账号扫。

> 加载路径变了 → 扩展 ID 变了 → 旧凭据一定读不到（这是设计，不是 bug）。
> **不要试图从旧 ID 目录搬 storage**，见上面的实测记录。

#### ④ Agent：自动化验收

装好并登录后，用 `bsk` 跑下面清单。**判据必须看播放器的 `video.duration`，不要看 UI 总时长**：

```js
// ✅ 正确判据：播放器真实时长（试看 = 360 秒左右，完整集 = 片长）
document.querySelector('video').duration
```

> ⚠️ **2026-10-30 实测踩过**：`poc/probe/verify-pgc-by-snapshot.mjs` 读的是**进度条上显示的总时长**
> （B站 UI 值，可能是 `24:01`），而 `video.duration` 可能仍是 `360.109`（试看）。
> **两者不一致时，以 `video.duration` 为准** —— 那才是"实际能播多长"。

- [ ] 解压 `pluma-<版本>.zip` → 打开 `edge://extensions` → 加载解压缩的扩展 → **能装上**
- [ ] 装完 badge 出现小圆点 → popup 显示"未配置"
- [ ] 扫码登录播放账号 → popup 显示"已接管"
- [ ] 打开 4K 视频 → 画质菜单出现 4K/1080P60 → 实际播放 ≥2160p
- [ ] 点赞一条视频 → 记在主账号
- [ ] 播放 30 秒 → 历史出现在主账号
- [ ] 关掉总开关 → 刷新 → 画质回落到 1080P（判据见验收清单 §5）
- [ ] 打开非视频页 → popup 显示"未生效"

#### ⑤ 收尾：切回开发目录

冒烟完把扩展切回 `.output/chrome-mv3`（同样要人手工做：`edge://extensions` 里移除 smoke 版，
再加载 `.output/chrome-mv3`）。否则下次开发时改代码不生效。

---

#### 实测记录（2026-10-30 · 1.0.1）

第一次按上面的分工跑通，留档供下次对照：

| # | 项 | 原始读数 |
| --- | --- | --- |
| 1 | 扩展加载且已接管 | `state=active` `credential=true` `rules=3` |
| 2 | 播放账号已登录且健康 | `vip=annual` `healthy=true` |
| 3 | **播的是完整集** | **`video.duration=1441`** |
| 4 | 解锁档位已取得 | `已取得 HDR` `badges=[HDR,1080P+]` |
| 5 | **关开关 → 刷新 → 回落** | `duration=360.109`（试看） |
| 6 | 开关恢复后重新接管 | `duration=1441` |
| 7 | 非视频页不注入 | `hasMainHook=false`（`matches` 只含 `/video/*` 与 `/bangumi/play/*`） |

**两项未验**（如实留档，不要写成通过）：
- 点赞 / 播放历史记在主账号 —— 自动化读不到，需人为主账号侧确认
- 4K/2160p 实际播放 —— 该样本最高 1080P，4K 场景由 1.0.0 验收覆盖


### 5. 更新 CHANGELOG.md（**必须在 §3 打包之前完成**）

**Release 正文的「本版内容」直接从这里提取**，所以这一步不是可选项 ——
找不到 `## <版本号>` 那一节，打包会硬失败（退出码 2）。

写法（子节怎么选、条目怎么写、需要用户操作时怎么说）见
[release-notes-template.md](./release-notes-template.md#怎么写-changelogmd-里的本版内容)。

三条底线：

- **只写会随版本变的东西**。产品常量（不绕过付费墙、许可证、地区限制）归 `README.md`
- **中性动词**，不写「破解」「解锁会员」「一键安装」「开箱即用」
- **不写内部实现**：「重构了 DNR 规则管理」用户看不懂，写「修复关闭总开关后画质不回落」

### 6. 打 Tag 并发布

```bash
V=1.0.1        # ← 改成当前版本号（与 package.json / wxt.config.ts 一致）

git tag -a "v$V" -m "v$V"
git push origin "v$V"          # 只推这个 tag，不要 --tags（会连历史 tag 一起推）

gh release create "v$V" \
  "dist/pluma-$V.zip" \
  "dist/pluma-$V-with-source.zip" \
  --title "Pluma $V" \
  --notes-file dist/release-notes.md
```

**Release 标题是 `Pluma <版本>`，不带 `v`**；**tag 是 `v<版本>`，带 `v`** ——
两者不同是有意的，见 `releasing.md`「产物命名」与 `versioning.md`。

**Release 说明由 `package.mjs` 生成**（CHANGELOG 的「本版内容」+ 固定的下载/用法/边界）。

⚠️ 只上传这两个 zip。GitHub 自动生成的 `Source code (zip)` 保留，不要删也不要改名。

### 7. 发布后核对（**新增，2026-10-27**）

发布完立刻验三件事，不要把第一次验证留到用户下载之后：

```bash
# 1. 附件对不对
gh release view v1.0.1 --json assets --jq '.assets[].name'

# 2. 正文与本地生成物是否一致（差一个尾部空行属正常）
gh release view v1.0.1 --json body --jq '.body' | diff - dist/release-notes.md

# 3. tag 是否指向预期的提交
git ls-remote --tags origin | grep v1.0.1
```

> ⚠️ **2026-10-30 删掉了原来的第 4 项**（「附件 sha256 与 release notes 的校验和一致」）——
> Release 正文已不再有「校验和」一节（见 `release-notes-template.md`）。
> 产物一致性由 `BUILD.md` + `verify` 的 `artifact` 项保证，发布后无需再手工比对。
> 若确实想核验下载到的文件，用 `Get-FileHash -Algorithm SHA256` 与**本地 `dist/` 里的同名文件**比对即可。

### 8. 自动转发到 Telegram 群

Release 发布后自动把**精简版** zip 发到指定群组。实现、一次性配置步骤与失败排查都在
[`.github/workflows/release-telegram.yml`](../../.github/workflows/release-telegram.yml) 的文件头注释里，本文不复述。

只发 `pluma-<版本>.zip`，不发 `-with-source` 版 —— 想拿源码的人点 Release 链接即可。

**当前形态：公开频道 + 关联讨论群。** bot 作为频道管理员发布，频道自动同步到关联群，
群里署名是频道而不是 bot。`TELEGRAM_CHAT_ID` 填**频道自己的** `@用户名`，不是 bot 的。

代价是频道可被全局搜索到，与「降低暴露面」（[ADR 0018](../decisions/0018-ship-built-artifacts.md)）
有张力 —— 这是已知取舍，不是疏漏。

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
