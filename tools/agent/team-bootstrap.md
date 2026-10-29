# Pluma 团队启动包（Team Bootstrap）

> **用途**：新会话里把「Lead + 工程师 + 验证者」和任务板拉起来，约 30–60 秒。
> **不写重构做什么**——那份方案在新会话里单独谈。这里只写**怎么组队、按什么规矩干**。
> 规则以 `AGENTS.md` 为准，本文只做“启动动作”，不复制规则内容。

---

## 0. 什么时候用

| 场景 | 用不用 |
| --- | --- |
| 新会话接手一个**里程碑**（发版、重构、大功能） | ✅ 用 |
| 同一会话内的连续小任务 | ❌ 不用，复用现有成员 |
| 单文件修 bug / 改文档 / 发版收尾 | ❌ 不用，Lead 自己做 |

团队**按里程碑 spawn 一次**，不按任务反复 spawn（成员名在同队内不可复用，`maxMembers` 有上限）。

---

## 1. 默认阵容

| 角色 | 成员 | 职责 | 写权限 |
| --- | --- | --- | --- |
| Lead | 你（当前 Agent） | 范围、任务板、ADR、最终 verify、发版决策 | 全局，但按任务分派 |
| 工程师 | teammate `engineer`（fresh） | 实现 + 测试 + 反例 | 只碰任务写域 |
| 验证者 | teammate `verifier`（fresh） | 独立复跑、反例、产物核对 | **只读**（证据只写 `.tmp/`） |

- 重构/高风险期：**不要**加第二个工程师，热文件会撞车。
- 需要第二个实现者时，必须两个工作流**不写同一文件**。

---

## 2. 开场预检（Lead 做，约 2 分钟）

```bash
git rev-parse --show-toplevel      # 必须是 Pluma 仓库
git status --short                 # 必须干净；不干净先问用户
git log --oneline -5
node scripts/verify.mjs            # 13 项全绿才开局
node --check src/content/main-world.js
```

- node 不在 PATH 时先加：`$env:PATH = "C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;" + $env:PATH`
- 改过 `dnr.ts` → 两个 DNR 脚本；改过 `main-world.js` → 真机日志（`AGENTS.md` §4.3）
- 真机用 `bsk`：先 `bsk doctor` 8/8；活动 `BSK_HOME=~/.bsk`（不是 `.bsk-agent`）

---

## 3. spawn 模板

### 3.1 engineer

```text
你是 Pluma 的工程师。工作区 D:\Projects\Pluma。

开工前必读：AGENTS.md §0/§1.5/§3/§4.3/§5.5/§7/§8。

任务：<task-id>「<subject>」。先 team_task_get 读取完整描述，claim 后执行。

硬约束：
- 只改任务写域内的文件；写域外需要改，先停下报告
- 不加新依赖、加新路径/主机、加新检查项、改 ADR（§7：不确定就停，转交用户）
- 改 main-world.js 后必须 node --check；涉及轨道/角标要向用户要真机日志
- 报告用 send_message 给 lead：改了什么 / 命令与输出 / 反例验证 / 未验证项；完成后 complete
```

### 3.2 verifier

```text
你是 Pluma 的独立验证者。工作区 D:\Projects\Pluma。**只读**。

开工前必读：AGENTS.md §0/§1.5/§3/§7/§8。

任务：<task-id>「<subject>」。先 team_task_get，claim 后执行。

硬约束：
- 不许用 write/edit，不许 git add/commit；证据只写 .tmp/
- 独立复跑：verify、相关回归、反例（把关键判据改回去必须变红）
- 找反例与覆盖缺口；判不了的写「未验证」，不猜
- 报告 send_message 给 lead：逐项 ✅/❌ + 文件:行/命令输出 + 未验证项；完成后 complete
```

---

## 4. 任务卡模板

每条任务必须写清这五项，否则不许开工：

```text
subject: <一句话>
write_scopes: [<文件或目录前缀>]        # verifier 用 [".tmp/"]
blocked_by: [<前置任务 id>]             # 验收任务必须 blocked_by 实现任务
description:
  目标：<用户可感知 / 行为不变？>
  验收：<能复跑的判据>
  回归：<要跑的测试/脚本>
  反例：<把哪个判断改回去，哪个测试必须红>
```

---

## 5. 验收门（每个实现任务收尾都跑）

- [ ] `node scripts/verify.mjs` 13 项全绿
- [ ] 改 `dnr.ts` → `poc/verify/run-q2-auto.cjs` + `dnr-disable-clears-tab-rules.cjs`
- [ ] 改 `main-world.js` → `node --check` + 真机日志
- [ ] 反例验证：关键判据改回去，相关测试必须红
- [ ] `git status` 干净；提交前 `check-secrets` 绿（pre-commit 钩子会自动跑）
- [ ] 结构性改动先有 ADR；行为变化先改 `AGENTS.md` §3 或 ADR

---

## 6. 协作规则

1. **一文件一 writer**；热文件串行：`main-world.js`、`dnr.ts`、`content.ts`、`messages.ts`、`routes.ts`、`tokens.css`
2. **报告是声明，不是事实**：Lead 必须自己 `git status` / `git diff` / 跑 verify
3. **真机单点**：同一时间只有一个 tester 驱动 `bsk`/浏览器；任务板加互斥
4. **文档单 owner**：`docs/**` 的改动由 Lead 统一收口，避免“两份权威”
5. **成员按里程碑 spawn 一次**；成员 inactive 时用 `send_message` 唤醒，不重建

---

## 7. 禁止项（违反即停）

- 改 §3 的 12 条决策、未授权的新改写路径/主机（§5.5）
- 加依赖、加检查项、改命令入口（§7）
- 在脏工作区上打包（G6 clean-tree 门会拒）
- 把真实 mid/昵称/凭据写进任何文件或提交信息（`check-secrets`）
- 并行改同一热文件、多人同时驱动同一个浏览器

---

## 8. 会话与团队生命周期

- **按阶段切会话**：发布完成、重构开始、大功能阶段切换才新开
- **同一阶段续用**：团队与任务板随会话保留，不要每任务新建
- **新会话开场**：读 `AGENTS.md` → `docs/03-open-questions.md` §0 → `.workbuddy-ai/HANDOFF.md`（若有）→ 本节
- **会话丢失/上下文太脏**：新会话按本 kit 重建，团队名册不跨会话

---

## 9. 收尾

- 每个里程碑结束：把状态/证据/未完成项写回 `.workbuddy-ai/`（或用户指定的交接文件）
- 团队完成即 inactive，不保留“常驻组织”
- 下次新会话从 §2 重新预检，不凭旧会话记忆断言
