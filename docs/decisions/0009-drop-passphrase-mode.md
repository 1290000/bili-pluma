# 0008. 移除口令模式，也不做自动锁定

日期：2026-10-25
状态：已采纳

## 背景

[Q6](../03-open-questions.md) 原本决策为"方案 C：随机密钥 + 可选启动时解锁"，即给愿意付出成本的用户一条升级路径。

实装后重新评估，发现两个问题：

1. **口令模式防不住它想防的威胁**
2. 我一度顺手加了"闲置自动锁定"，它和口令模式是同一种问题

## 决策

**只保留一种模式：随机密钥 + AES-GCM。移除口令模式，也不做自动锁定。**

## 理由

### 1. 口令模式的威胁模型不成立

口令模式假设的攻击者是"拿到了 `storage.local` 的人"。但这个人如果已经能读扩展存储目录，他同样能：

- 读浏览器 cookie 数据库里的 `SESSDATA`（**这才是最直接的路径**）
- 读进程内存
- 调用 Windows DPAPI（`CryptUnprotectData`）解密 Chrome 的 cookie 文件——DPAPI 绑定当前用户，同用户下的程序直接可调

**所以口令模式防不住"本机程序"，只防住"用文本编辑器打开 JSON 看一眼"这一档——而默认模式（AES-GCM + 随机密钥）已经挡住了。**

它增加的是操作负担，不是安全强度。

### 2. 自动锁定同样没有效果

曾计划加"闲置 15 分钟调用 `lock()` 清空内存密钥"。但实现上：

```ts
lock()                        // cachedKey = null
loadCredential()              // 发现 cachedKey 为 null → 从 storage 读密钥 → 立即 import
```

`lock()` 只清内存缓存，下次读凭据会**自动从磁盘重新 import**。攻击者只要能执行 SW 代码，调一次 `loadCredential()` 就拿到明文，中间那 15 分钟毫无阻拦。

**这叫"锁定"但实际上是不可能锁住的锁定。** 有安全外观、无安全实质的机制，比没有更糟——它会误导用户以为受到了保护。

### 3. 没有 UI 的功能等于死代码

口令模式从未有过设置入口（P2 才做设置页），用户永远碰不到。留着就是死代码 + 死文档。

## 保留什么

`cachedKey` 保留，但明确定性为**纯性能缓存**，不是安全边界：

- 避免每次 `loadCredential` 都重新 `importKey`
- 在 `clearVault()` 时清空（退出账号后不该留着可用密钥）
- **不给它附加任何安全语义**，不加闲置计时器，不导出 `isUnlocked()`

## 诚实表述（README 必须这么说）

**能防**：其他网页脚本、其他扩展直接读到明文
**不能防**：本机程序——任何能读本机文件的程序都能同时拿到密文和密钥
**也不改变**：B站登录态本身以 cookie 形式存在浏览器里，本扩展的加密不影响那部分

**绝对不写**"军事级加密""银行级安全""等同于系统级保护"。

## 后果

- `core/vault/crypto.ts`：删 `deriveKeyFromPassphrase`、`PBKDF2_ITERATIONS`、`EncryptedBlob.salt`
- `core/vault/vault.ts`：删 `saveWithPassphrase` / `unlock` / `isLocked` / `isUnlocked`，`lock()` 降级为内部行为
- `platform/storage/vault-storage.ts`：删自动锁定的 alarm
- 已存数据里的 `salt: null` 是多余字段，JSON 反序列化时忽略，**不需要迁移**
- 保留 `EncryptedBlob.v`（版本号），将来换算法时靠它迁移

## 未来的正确方向

若要真正的系统级保护，正确做法是 **Native Messaging + Windows DPAPI**，让凭据绑定 Windows 用户账户。但那需要本地可执行程序，与 [ADR 0001](./0001-use-mv3-pure-extension.md)「纯 MV3 扩展」冲突，属于 v2 的范畴。

## 相关

- 原决策：[Q6](../03-open-questions.md)
- 实装：`src/core/vault/`
- 验证：`poc/verify/result-vault-e2e.json`
