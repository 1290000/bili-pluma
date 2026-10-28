# ADR 0025：主账号"显示档案"缓存（非播放页可见昵称）

- 状态：**已采纳**（2026-10-29 决定并落地）
- 相关：决策 4（主账号不归扩展管理）、[ADR 0008](./0008-cookies-permission-for-playback-credential.md)（`cookies` 权限范围）
- 影响文件：`src/platform/storage/primary-profile-store.ts`（新）、`entrypoints/content.ts`、
  `entrypoints/popup/main.tsx`、`src/background/handlers/account-remove.handler.ts`

---

## 背景

主账号的昵称 / 等级**只有一个来源**：播放页的 `__INITIAL_STATE__.user`。
扩展不读主账号凭据（决策 4），不会发 `nav` 去问"我是谁"。

于是在首页 / 空间 / 收藏夹点开 popup 时，A 卡片只能写「打开视频页后可见」。
用户最初的反馈是：这一行占着位置、什么也没说，看起来像功能没做完。

**这里没有"免费"的解法。** 三个方向都试过并被排除：

| 方向 | 为什么不行 |
| --- | --- |
| popup 去读别的标签页（`pickVideoTab`） | 一个视频页都没开着时照样拿不到 |
| `sessionStorage` | 用户场景是"开浏览器 → 直接去首页 → 点扩展"，这是**新会话**，那里是空的 |
| 发 `nav` 请求问"我是谁" | 扩展以主账号身份发请求 = 越界（决策 4），且无痕分区下拿到的是播放账号 |

---

## 决定

**在 `chrome.storage.local` 存一份"上一次在播放页看到的主账号显示信息"，仅用于非播放页展示。**

写入点**只有一个**：`entrypoints/content.ts` 处理 `ssr-playinfo` 时。
读取点也只有一个：`entrypoints/popup/main.tsx` 的 `readPrimaryCard()`，且**只在非播放页读**。

### 字段边界（本 ADR 最重要的部分）

| 字段 | 存 | 理由 |
| --- | --- | --- |
| `uname` | ✅ | A 卡片要显示 |
| `level` | ✅ | A 卡的 LV 标签 |
| `face` | ✅ | 头像 URL（B 站公开页面本来就展示） |
| `savedAt` | ✅ | TTL 判据 |
| `midHash` | ✅（散列） | 只为回答"还是同一个号吗"，加载盐 SHA-256，**不可反推** |
| `mid` | ❌ | 账号唯一标识，能跨站对账；**显示根本不需要它** |
| 页面 / 视频标题 | ❌ **禁止** | 那是"他在看什么"，与功能无关 |
| 任何凭据字段 | ❌ **禁止** | AGENTS.md §5.2 |

设计上把 `mid` 的用途压缩到只剩"归属判定"，而归属判定不需要**存储**原文 ——
用加盐散列就够。额外收益：即便这份缓存被读走，攻击者拿到的是"某个昵称叫 X、等级 6"，
而不是"这个 mid 是谁"。

### 写入守卫：必须同时拿到真实 `DedeUserID`

`savePrimaryProfile()` 的签名**强制**调用方传 `mid`，且必须是纯数字，否则拒绝写入。

这不是为了存 mid（我们不存），而是**让调用点无法绕过**：

- `ssr-playinfo` 走跨 world 通道，`content.ts` 的注释写明**本侧不校验 token**，
  理由是"主世界上报的内容只影响画质显示"。
- 一旦这份数据被持久化成"用户的账号"，威胁模型就变了：页面脚本伪造一条消息，
  就能把一个假昵称**永久写进扩展存储**，之后每个非播放页都显示它。
- `mid` 由 ISOLATED 自己从 `document.cookie` 读，页面写不了 —— 它就是那条闸门。

顺带解决了另一半：**游客态不写缓存**，所以缓存里不会出现"空昵称覆盖掉真实昵称"。

### TTL：7 天，但不显示给用户

过期即视为没有，popup 回到「打开视频页后可见」。

**不显示"3 天前看到"**：那行字既不提供价值，又在提醒用户"这个信息可能不准"。
过期是扩展内部的卫生问题，不该变成 UI 上的疑虑。

### 退出播放账号时清除

`account/remove` 一并 `clearPrimaryProfile()`。

看起来这项不属于"播放账号"，但用户点「退出」的心理预期是"这个扩展我不用了"。
此时还留着主账号昵称，在**家用共用电脑**上不是体验问题，是泄露。

**不做"一键清除"入口。** 退出播放账号已经覆盖了绝大多数"我要清掉"的意图，
再开一个设置项反而让 options 变复杂（用户已确认不做）。

---

## 为什么不加密

`chrome.storage.local` 落盘就是明文 LevelDB，同用户下的任何程序都能读。
而密钥如果也放本地，**同一台机器上同样能读** —— `core/vault/crypto.ts` 的注释
早就写清了这个边界："能防网页脚本与扩展，不能防本机程序"。

所以对这份缓存加密，**保密性的提升接近零**，代价却是：
跨层依赖（`platform/storage` 要引 `core/vault`）、异步解密、密钥生命周期。

**降低风险的作法是少存东西，不是换一把锁。** 不存 mid、不存页面信息，
这两条比任何加密都有效。

---

## 已知弱点（如实记下）

**账号切换后、且没打开过任何播放页时，可能显示上一个账号的昵称。**

非播放页没有任何验证手段（读不到 `DedeUserID`，也没有 content script 可以问），
所以"缓存是不是当前账号的"这个问题在那一刻**无法回答**。

实际影响被三件事压小：
1. 一旦打开任意播放页，写入点会用 `midHash` 比对并覆盖；
2. 7 天 TTL 兜底；
3. 退出播放账号会清空。

**不能把它说成"账号永远对得上"。** 做不到的事不要写进 UI 或 README。

---

## 变更门槛

**往缓存里加任何字段之前，必须回答一句：这条字段泄露后能关联到什么？**

答不上来就不加。尤其禁止：

- 任何形式的账号标识原文（mid / SESSDATA / 手机号）
- 任何"用户在浏览什么"的信息（页面标题、视频标题、当前 URL、日志）

---

## 对既有代码的影响

| 位置 | 变化 |
| --- | --- |
| `src/platform/storage/primary-profile-store.ts` | 新增：`savePrimaryProfile` / `readPrimaryProfile` / `clearPrimaryProfile` / `hashMid` |
| `entrypoints/content.ts` | `ssr-playinfo` 分支加**唯一写入点**（`user` 非空时） |
| `entrypoints/popup/main.tsx` | 新增 `PrimaryCard` / `readPrimaryCard()`；A 卡片的原料与 `page.view` 解耦 |
| `account-remove.handler.ts` | 清五项变六项 |

**`PageTracksView` 与消息协议一处没改。** 缓存只在扩展页面内部读写，
不经 background、不进任何 `*:ok` 消息。

---

## 验证

`tests/unit/platform/primary-profile-store.test.ts`（20 条），分三组：

- **不存什么**：序列化后整份扫描，`mid` 原文不出现；只有约定的五个字段；调用方多塞的字段被丢弃
- **该拒的拒**：无 mid / mid 非纯数字 / uname 为空 → 都不写
- **该收的收**：TTL 内可读、超期不可读、`savedAt` 在未来不认、
  等级是字符串退化成 `null`、脏数据读不出来

**反向验证做过**（三处逐一关掉，各自变红后恢复）：
`mid` 守卫 → 1 红；TTL → 1 红；字段白名单（改成 `...profile` 展开）→ 1 红。

⚠️ **`readPrimaryCard()` 没有单测**：它在 `main.tsx` 里，依赖 `chrome.tabs` 与 Preact 组件树，
现有测试基建跑不动（仓库里所有 `platform/*` 测试都刻意绕开 `chrome.*`）。
它的判据很薄（播放页走实时、其他页走缓存），但"播放页不用缓存兜底"这条
**目前只有注释守着，没有断言**。这是已知缺口。
