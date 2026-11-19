# 凭据与敏感数据处置说明

> 本文记录**哪些东西不能进仓库**、**已经发生过哪些泄露**、**怎么处置的**。
> 用途只有一个：下次有人想把"一份原始响应"提交进来时，先在这里看到代价。
>
> 这不是许可证或免责声明，那些在根 `README.md` 与 `NOTICE.md`。

---

## 一条判据：取流签名算凭据

B站 的 `.m4s` / `.mp4` 地址带 `upsig` + `uparams` 两个 query 参数。
`uparams` 列出被签名的参数名（实测 `e,os` 或 `e,oi`），`upsig` 是签名值。

**签名在有效期内可直接取流**，不需要任何 Cookie。所以：

| 东西 | 能不能进仓库 |
| --- | --- |
| 完整 `.m4s` URL（含 `upsig=`） | ❌ **不行** —— 等于把一次会话的取流凭据摊开 |
| 截断的示例（`upsig=7baa0aee…`） | ✅ 可以 —— 只说明格式，不可用 |
| 只含 host / path / 分类的统计 | ✅ 可以 —— 这是结论，不是凭据 |
| `last_play_time` / `cid` / `avid` 等业务字段 | ✅ 可以 —— 不含授权 |

同理不可入库的还有：`SESSDATA` / `bili_jct` / `DedeUserID` 的**值**
（字段名本身可以写，值不行），以及 `bsk` 产出的 `sync.json`（含 session_id）。

---

## 已发生的入库事件

一共 **4 个文件**，分两批入库。⚠️ 本文 2026-11-19 之前只记了后 3 个，
**`bg-ssr.json` 是漏记的** —— 那次排查只扫了 `poc/probe/`，没扫 `poc/verify/`。

| 文件（入库路径） | 完整 `upsig` | 入库提交 | 入库日期 | 移出索引 |
| --- | --- | --- | --- | --- |
| `poc/verify/bg-ssr.json` | **20** | `f257f9a` | **2026-10-25** | `9ead445`（10-27） |
| `poc/probe/logout-login-round2/raw/repro5/console-full-bili-home.json` | 14 | `4f75c1e` | 2026-11-15 | `362033f`（11-19） |
| `poc/probe/logout-login-round2/raw/repro5/console-full-video.json` | 22 | `4f75c1e` | 2026-11-15 | `362033f` |
| `poc/probe/logout-login-round2/raw/repro5/console-video-recheck.json` | 22 | `4f75c1e` | 2026-11-15 | `362033f` |

处置方式相同：`git rm --cached` 移出索引 + `.gitignore` 覆盖。
**⚠️ 历史里仍可取出** —— 见下节。

### 为什么这四个文件的实际可利用性为零

签名带 `deadline` 参数，过了时刻就无效。逐个核过：

| 文件 | `deadline` | 失效时刻 | 入库时刻 | 结论 |
| --- | --- | --- | --- | --- |
| `bg-ssr.json` | 1792871227 | 2026-10-24 19:47 UTC | 2026-10-25 | **入库前 4 小时已失效** |
| `repro5` 三份 | 1794470394 等 | 2026-11-12 07:59~08:51 UTC | 2026-11-15 | **入库前 3 天已失效** |

即：**签名在写进仓库时就已经取不出流了。** 这是巧合而非设计，不能当护身符 ——
下次若有人提交一份当天抓的响应，签名是活的。

`mid` 字段已脱敏（`{{主账号mid}}`），不含账号标识。

### 三、2026-11-19：一次误提交

发 1.4.0 时为了复现 pre-commit 钩子的报错，执行了 `git commit -m "test"`，
**结果钩子放行、71 个探针文件真的提交了**（其中含 `p2p-bypass.json` 的 164 处签名）。

发现后立即 `git reset --soft HEAD~1` 撤回，**该 commit 从未推送**（`git branch -r --contains` 为空），
所以历史里已不存在。

**教训**：不要让"验证钩子会不会拦"和"真的提交"用同一条命令。
要看钩子报错就故意改一个文件再 `git add` 它，别拿真实提交去试。

---

## 历史里的签名要不要洗掉

> **本节 2026-11-19 重写。** 上一版写的前提是"这个仓库不上架、不公开分发"，
> 而事实是 **GitHub 仓库从创建（2026-10-27）起就是 public**。前提不成立，
> 结论也就不能照抄 —— 那版结论本身没造成损失（签名都已过期），但它是错的。

**当前决定：暂不重写历史，但把它当成一件"有触发条件、随时能做"的事。**

### 现状核实（2026-11-19 实测，可复核）

| 项 | 读数 | 命令 |
| --- | --- | --- |
| 仓库可见性 | **public**（创建即 public） | `gh repo view --json visibility` |
| 泄露是否在远端 | **是**，`origin/main`（`caccbb8`）含两个提交 | `git merge-base --is-ancestor f257f9a origin/main` |
| fork / star / watcher | **0 / 0 / 0** | `gh api repos/... --jq '{forks,stars,watchers}'` |
| GitHub secret scanning 告警 | **0** | `gh api repos/.../secret-scanning/alerts` |
| 签名是否有效 | **全部失效**（见上表） | 读 `deadline` 与当前时间比 |

结论：**凭据形态的数据确实在公开仓库里，但取不出任何东西**，且曝光面（0 fork）接近于零。

### 触发条件（任一条成立就做）

1. **上架或镜像分发** —— 转 private 不用洗（洗了也白洗，反而丢 hash 稳定性）
2. **给第三方授权**（合作、审计、转交维护）
3. **有外部 PR / fork 出现** —— 说明真有人在读历史
4. **发现新的、未过期就被提交的签名** —— 那一次必须立刻做，不能等

不满足上述条件时不做，理由是成本高而收益为零（见下面的代价表）。

### 怎么做（已实测跑通，8 分 5 秒）

`git filter-repo` **未安装**（python 模块不可用，`pip show` 为空），用等价的
`filter-branch`。2026-11-19 在镜像克隆里完整跑过一遍，以下命令验证有效：

```bash
# 0. 备份（.git 23 MB，复制比后悔便宜）
cp -r .git .git.bak-$(date +%Y%m%d)

# 1. 重写
git filter-branch -f --index-filter '
git rm --cached --ignore-unmatch -q \
  "poc/verify/bg-ssr.json" \
  "poc/probe/logout-login-round2/raw/repro5/console-full-video.json" \
  "poc/probe/logout-login-round2/raw/repro5/console-full-bili-home.json" \
  "poc/probe/logout-login-round2/raw/repro5/console-video-recheck.json"
' --prune-empty --tag-name-filter cat -- --all

# 2. 校验（三条都必须为空）
git log --all --oneline -- 'poc/verify/bg-ssr.json'              # 应为 0 行
git rev-list main --objects | grep '\.json$' | while read -r h p; do
  git cat-file blob "$h" 2>/dev/null | grep -qE "upsig=[A-Za-z0-9_-]{20,}" && echo "⚠️ $p"
done                                                              # 应为 0 行
git for-each-ref --format='%(refname)' | grep 'refs/original'    # 用来确认旧 ref 还在

# 3. 清旧对象（否则 refs/original 仍能取回旧版本）
git for-each-ref --format='%(refname)' refs/original \
  | xargs -n1 git update-ref -d
git reflog expire --expire=now --all && git gc --prune=now --aggressive

# 4. 推送（见下面「推送前必须先做」）
git push origin --force --all && git push origin --force --tags
```

#### 两个实测踩到的坑

- **`--tag-name-filter cat` 不能省。** 不加时 `filter-branch` 会打印
  `Ref 'refs/tags/v1.3.0' was rewritten`，但 **tag 实际仍指向旧提交** —— 泄漏还在。
  第一遍我漏了这个参数，`git rev-parse v1.3.0^{commit}` 返回的还是 `caccbb8`。
- **验证必须显式排除 `refs/original`。** 重写后 `git log --all -- <path>` 仍能查到，
  因为 `refs/original/*` 保留了旧顶端。`--all` 包含它。用 `git log main -- <path>` 或先删 `refs/original`。

#### 实测结果（2026-11-19，镜像克隆）

| 项 | 结果 |
| --- | --- |
| 耗时 | **8 分 5 秒**（404 提交，Windows，机械盘） |
| 提交数 | 404 → **404**（`--prune-empty` 没吞提交） |
| HEAD 树 hash | `2d0e036…` **前后完全一致** —— 当前文件一个字节没变 |
| tag | 6 个全部跟随（`v1.3.0: caccbb8 → 52295ae`） |
| 泄漏路径 | `git log main -- <4 路径>` **0 命中** |
| 全历史 json blob | `upsig=[A-Za-z0-9_-]{20,}` **0 命中** |

### 代价（这是"暂不做"的全部理由）

| 项 | 影响 |
| --- | --- |
| 提交 hash | **393 / 404 全变**（只有最早 11 个不受影响，因为起点是 `f257f9a`，比 v0.9.0 还早） |
| tag | **6 个全重打** —— `v0.9.0` 就已含 `f257f9a` |
| GitHub Release | **6 个全要删了重建**，zip 资产需重新上传 |
| `dist/BUILD.md` | 记录的 commit 失效（该文件不入库、不在 zip 内，重新打包即连带生成） |
| 79 个未推送提交 | 无额外成本，本地重写天然带上 |
| 协作者 | 无（0 fork / 0 PR / issues 已关） |
| GitHub 侧残留 | `--force` 后旧对象仍可凭 SHA 临时访问，需开 ticket 让 Support 清缓存 |

**推送前必须先做**：确认 `dist/BUILD.md` 的 commit 与重写后的 HEAD 对得上，否则
"用户装的到底是哪一版"这条追溯链会断。做法是重写后重新 `node scripts/package.mjs`。

---

## 自动化防线

| 防线 | 位置 | 抓什么 |
| --- | --- | --- |
| pre-commit 钩子 | `.githooks/pre-commit` → `check-secrets.mjs --staged` | 暂存区里的凭据 + `upsig` 签名 |
| 发布时历史门 | `scripts/package.mjs` 的 **G6.5** → `check-secrets.mjs --history` | 增量 0.3–0.9s / 全量 29s（见下） |
| `verify` 静态项 | `scripts/verify.mjs` 的 `secrets` 项 → `check-secrets.mjs` | 当前索引里的已跟踪文件 |
| 忽略规则 | `.gitignore` 的「含真实取流签名的探针产物」一段 | 从源头挡住 |

⚠️ 钩子挡不住 `--no-verify`，也挡不住 `cherry-pick` / `merge` / `rebase`
（这四种都实测过，见下方「为什么不能只靠 pre-commit 钩子」）。
它只是第一道；真正的防线是**入库前想一下这份数据里有没有 `upsig`**。

### 2026-11-19：检查器本身三层都是坏的

这不是"检查器没覆盖到"，是**它的输出看起来是对的**。三层缺陷没有一层会报错：

| # | 缺陷 | 后果 |
| --- | --- | --- |
| 1 | **完全不认 `upsig`** | `CREDENTIAL_PATTERNS` 只认 `SESSDATA` / `bili_jct` / 私钥。未知形态的凭据 = 不存在 |
| 2 | `SKIP_PATH` 显式豁免 `bg-ssr.json` / `bg.html` | **已知有问题的文件反被保护**。那两个文件各含 20 处签名，检查器主动跳过它们 |
| 3 | `--all` 用 `--others --exclude-standard` | 被 gitignore 的抓包目录**根本不在扫描范围**，而签名最常躺在那里 |

修复后的判据（都在 `tests/unit/scripts/check-secrets.test.ts` 里，9 条）：

| 判据 | 门槛 | 为什么是这个数 |
| --- | --- | --- |
| `upsig` 完整签名 | `[A-Za-z0-9_-]{16,}` | 实测 98 处真签名**全是 32 位**；仓库里合法示例最长 11 位（`SECRETUPSIG`）。16 是两者之间的空档 |
| **不看 `FAKE_MARKER`** | — | 真实抓包 URL 里当然没有 `fake` 字样。放过截断示例靠长度门槛，不靠标记 |
| `--all` 含被忽略文件 | `--others` **不带** `--exclude-standard` | `.gitignore` 只挡 `git add`，不是"从此免检" |
| 二进制跳过 | 含 NUL 字节 | Chrome profile 的 SQLite 无扩展名，解码成乱码后会**凑出假签名**（实测 12 处误报） |
| 输出分组 | 「已在版本控制内」优先 | `--all` 报 2188 处，**全部在本地**。不分组的话人只会去改容易改的，把真正入库的漏掉 |

### `--history` 已经重写：29 秒（原来 40 分钟跑不完）

旧实现逐提交 `ls-tree` + `git show`，**实测 40 分钟没结束** —— 也就是说
"发布前扫一遍历史"这条防线**实际上不存在**，发版时只能手工绕过它。

重写后按 **blob 去重** + `cat-file --batch` 单进程批量读：

| 实现 | 耗时 | 结果 |
| --- | --- | --- |
| 逐提交 `git show` | **40 分钟未完成** | 无结论 |
| 逐 blob 起进程 | 6 分钟未完成 | 无结论 |
| **`cat-file --batch` 批量** | **29 秒** | 91 处（全部在基线内） |
| **增量（水印 `w..HEAD`）** | **0.3–0.9 秒** | 扫到的都是新提交 |

同一个 blob 在 400 个提交里只会被检查一次 —— 旧实现每个提交都重跑一遍。

### 增量水印：把「重复劳动」也去掉

29 秒仍然是每次发版都在做同一件事：那 91 处是**静态**的既有基线，
文件内容一个字没变，重扫只是把它们原样再报一次。

于是加了水印机制：把「上次已验证的提交」记进
`.git/pluma-secrets-watermark`，之后只扫 `水印..HEAD`。

| 场景 | 范围 | 实测 |
| --- | --- | --- |
| 有水印，无新提交 | `w..HEAD` = 0 对象 | **0.34 秒** |
| 有水印，1 个新提交 | 3–9 个对象 | **0.55 秒** |
| 无水印 / 历史被 rewrite | 全量 5098 对象 | 29 秒 |

**为什么增量不会漏**：`git rev-list w..HEAD --objects` 能捞到「加了又删」的 blob。
专门验过，因为那正是本次事故的形态（`bg-ssr.json` 10-25 入库、10-27 移出）：

```
$ git rev-list <watermark>..HEAD --objects | grep leak
911bcc9… leak.json        ← 加了又删，照样能捞到
```

**保守降级**：水印缺失、或水印不是 HEAD 的祖先（历史被 rewrite / force-push），
一律退回全量并在输出里说明原因。宁可白跑 29 秒，不能静默漏扫。

**为什么水印不放版本控制**：它是本地验证状态，不该随 clone 传播 ——
每个 clone 各自扫自己的全量、打自己的水印，谁也不替别人担保。
强制全量：`--full`。

### 基线：已确认并接受的历史泄漏

`--history` 现在**不再永久红**。历史里那 91 处命中已登记为基线
（`check-secrets.mjs` 的 `HISTORY_BASELINE`），打印为 ⚠️ 并放行；
**基线外**的命中仍然 ❌ 硬红。

⚠️ **增量模式下基线一律不生效**。理由：水印是在「历史已知」的前提下打的，
那之后出现的任何命中都是新的。反例（实测过）：`poc/verify/bg-ssr.json` 在基线里，
若有人在新提交里**又把它加回去**，按路径匹配会被判成「已知」而放过 ——
那恰恰是最该报的一次。

为什么必须这样：一个永远红的检查项**等于没有检查项**，它迟早被
`--no-verify` 或改代码绕过，那之后就什么也拦不住了。

⚠️ 基线**只增不减** —— 洗了历史之后才能删对应条目。基线不是"安全"，
是"知道并接受"。

### 为什么不能只靠 pre-commit 钩子

钩子是最快的一道，但它**不是全覆盖**的。实测四个绕过路径：

| 操作 | 跑 pre-commit？ | 实测 |
| --- | --- | --- |
| `git commit`（正常） | ✅ 跑 | 含签名 json → 270 处，`exit 1` |
| `git commit --amend` | ✅ 跑 | 同样拦住 |
| `git cherry-pick <含泄漏的提交>` | ❌ **不跑** | `leak.txt` 静默进 main |
| `git merge --no-ff <分支>` | ❌ **不跑** | `leak.txt` 静默进 main |
| `git rebase <分支>` | ❌ **不跑** | 泄漏跟着进了新提交 |
| 新 `git clone` 之后 | ❌ **一个钩子都没有** | `core.hooksPath` 是空的 |

最后一行是根因：`core.hooksPath` 是**本地配置，不进版本控制**
（见 `.githooks/README.md:12`），换机器 / 重 clone 都要重设。
`README.md:70` 与 `AGENTS.md:222` 都写着"clone 后跑一次"——**靠自觉**。

所以打包门不能省：它是这条链上唯一**跟着代码走**、且**没有 `--no-verify` 后门**的一环。
钩子管"未来的每一次提交"，打包门管"这一次要发出去的东西连同它的历史"。

---

## 复核某条结论时怎么办

报告（`REPORT-*.md`）里已经有数字与判据，那是要留的证据。
需要复核时**重跑探针**，不要把旧响应从 `.tmp/` 或回收站捞回来入库：

```bash
node poc/probe/pcdn-diag/probe.mjs        # 重新抓，输出仍在本地
```

新抓的 json 会被 `.gitignore` 挡住 —— 这是设计，不是故障。