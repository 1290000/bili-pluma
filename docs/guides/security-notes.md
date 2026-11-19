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

## 已发生的两次入库

### 一、2026-11-19：`poc/probe/**/*.json` 的排查

清理时发现 **3 份已在历史里的** console 快照含完整签名：

| 文件 | 完整 `upsig` 处数 |
| --- | --- |
| `poc/probe/logout-login-round2/raw/repro5/console-full-bili-home.json` | 14 |
| `poc/probe/logout-login-round2/raw/repro5/console-full-video.json` | 22 |
| `poc/probe/logout-login-round2/raw/repro5/console-video-recheck.json` | 22 |

处置：`git rm --cached` 从索引移除 + `.gitignore` 覆盖。
**⚠️ 历史里仍可取出** —— 见下节。

### 二、2026-11-19：一次误提交

发 1.4.0 时为了复现 pre-commit 钩子的报错，执行了 `git commit -m "test"`，
**结果钩子放行、71 个探针文件真的提交了**（其中含 `p2p-bypass.json` 的 164 处签名）。

发现后立即 `git reset --soft HEAD~1` 撤回，**该 commit 从未推送**（`git branch -r --contains` 为空），
所以历史里已不存在。

**教训**：不要让"验证钩子会不会拦"和"真的提交"用同一条命令。
要看钩子报错就故意改一个文件再 `git add` 它，别拿真实提交去试。

---

## 历史里的签名要不要洗掉

**当前决定：不主动重写历史。**

理由三条：

1. **签名有时效**。B站 的 `upsig` 到 `deadline` 就失效（响应里带该字段），
   历史里的签名早就过了有效期，取不出东西。
2. **重写 402 个提交的成本与风险**远大于收益 —— 本地仓库没有远端副本可回退，
   出错只能靠 `reflog`，而且 `filter-repo` 未安装。
3. **这个仓库不上架、不公开分发**（[ADR 0018](../decisions/0018-ship-built-artifacts.md)），
   暴露面本来就只有仓库本身。

**但这条决定有前提**：一旦仓库要公开（转 public、镜像、给第三方），
**必须先洗历史**，否则上面的文件全都能被 `git show` 挖出来。
洗的工具是 `git filter-repo --path-glob 'poc/probe/**/*.json' --invert-paths`。

---

## 自动化防线

| 防线 | 位置 | 抓什么 |
| --- | --- | --- |
| pre-commit 钩子 | `.githooks/pre-commit` → `scripts/check-secrets.mjs --staged` | 暂存区里的凭据模式 |
| 发布前全历史扫描 | `node scripts/check-secrets.mjs --history` | 整个历史 |
| 忽略规则 | `.gitignore` 的「含真实取流签名的探针产物」一段 | 从源头挡住 |

⚠️ **钩子挡不住 `--no-verify`**，也挡不住 "先 commit 再发现" 这类。
它只是第一道；真正的防线是**入库前想一下这份数据里有没有 `upsig`**。

---

## 复核某条结论时怎么办

报告（`REPORT-*.md`）里已经有数字与判据，那是要留的证据。
需要复核时**重跑探针**，不要把旧响应从 `.tmp/` 或回收站捞回来入库：

```bash
node poc/probe/pcdn-diag/probe.mjs        # 重新抓，输出仍在本地
```

新抓的 json 会被 `.gitignore` 挡住 —— 这是设计，不是故障。