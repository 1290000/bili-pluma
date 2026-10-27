# git 钩子

> 这两个钩子在**提交那一刻**拦截敏感信息。仓库自带的，但 git 默认不用 ——
> 需要每个克隆的人执行一次下面这条命令。

## 启用（每个克隆都要做一次）

```bash
git config core.hooksPath .githooks
```

`core.hooksPath` 是**本地配置**，不进版本控制，所以换机器 / 重新 clone 都要重设。
**没有自动化的办法**，这是 git 的设计 —— 钩子若能被仓库自动启用，
任何人 clone 一个仓库就等于让代码在自己机器上执行，风险更大。

## 两个钩子各管什么

| 钩子 | 检查 | 拦什么 |
| --- | --- | --- |
| `pre-commit` | `check-secrets --staged` | 暂存区**文件内容**里的敏感值 |
| `commit-msg` | `check-secrets --commit-msg` | **提交信息**里的敏感值 |

### 为什么要两个

2026-10-27 一天内返工三次，其中一次是
**「修复泄露」的提交，其提交信息里又把值列了一遍**。

文件内容的检查拦不住这个 —— 提交信息不在文件里。所以必须单独一个钩子。

## 绕过

```bash
git commit --no-verify
```

允许绕过。但**发布前**跑 `node scripts/check-secrets.mjs --history`
仍会查出来（发布流程 `docs/guides/releasing.md` §2 有这一项）。

## 误报怎么办

在触发误报的那一行加注释：

```js
const fakeMid = 1000001; // secrets-ok: 测试用假 mid
```

`secrets-ok` 这个标记会让检查器跳过该行。**必须写理由**，
否则下一个看到的人不知道这是豁免还是疏忽。

## 加新的禁止值

编辑 `scripts/check-secrets.mjs` 的 `BANNED_HASHES`。**只存哈希，不存明文**：

```bash
node -e "const c=require('crypto');
         console.log(c.createHash('sha256').update('pluma-secrets-v1:<值>').digest('hex').slice(0,32))"
```

⚠️ **永远不要把明文写进那个文件。** 检查器自己泄露过一次，用户原话：
「不要闹出来检查用的代码反而露出了敏感数据这种笑话」。

## 在 CI 里跑（可选，但推荐）

钩子能被 `--no-verify` 绕过。真正的强制闸门在 CI：

```yaml
# .github/workflows/verify.yml 里加一步
- run: node scripts/check-secrets.mjs
- run: node scripts/check-secrets.mjs --commit-msg   # commit-msg 钩子的 CI 兜底
```

`--history` 太慢（本项目 76 提交约 40 秒），只在发布前本地跑，不进 CI。
