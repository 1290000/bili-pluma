/**
 * 需要被**写入方**与**监听方**同时知道的 `chrome.storage.local` 键。
 *
 * ## 为什么集中在这里
 *
 * 键字面量散落时，"写入方改了名字、监听方还在听旧名"不会有任何报错 ——
 * 表现为"功能静默不生效"，而这类问题最难排查（没有异常、没有日志）。
 * 集中一处至少能在改的时候一眼看到有两个消费者。
 *
 * ## 为什么只放这几个
 *
 * 其余的键（`pluma:panel-entry-enabled` 等）目前只有一个消费方，
 * 就地定义反而更清楚。**只有需要跨模块共享的键才搬进来**，
 * 否则这里会变成一个什么都塞的杂物箱。
 *
 * 本文件是纯常量与纯函数，不碰 `chrome.*` —— `shared/` 层不许有 IO
 * （见 `scripts/check-boundaries.ts`）。
 */

/** 凭据密文（AES-GCM 加密后的 blob） */
export const VAULT_BLOB_KEY = 'pluma:vault:blob';

/** 解密密文用的随机密钥（base64） */
export const VAULT_KEY_KEY = 'pluma:vault:key';

/**
 * 一次 `storage.onChanged` 的变化集，是否意味着**取流凭据变了**。
 *
 * ## 用途：让已经打开的面板在扫码成功后自己刷新
 *
 * 扫码窗口在**无痕分区**（`incognito: 'split'`），那里是另一个 background 实例，
 * 没法给面板发消息。面板原来靠"登录窗口打开后轮询 `account/summary`"来等结果，
 * 而轮询会被"面板收起"掐掉 —— 用户点完「扫码登录」**必然**要把鼠标移开去扫码，
 * 面板一收起轮询就停了，于是登录成功后面板停在旧状态。
 *
 * 存储是两边唯一共享的东西，而登录成功的唯一可观测结果就是这两个键被写入
 * （退出账号则是被删除）。所以监听它们比轮询更直接：不依赖窗口存活、
 * 不依赖面板是否展开。
 *
 * ⚠️ **两个键都要判**：写凭据时的顺序是"先写密钥、再写密文"，
 * 只判 blob 会在时序边缘漏掉一次。
 */
export function isVaultChange(changedKeys: readonly string[]): boolean {
  return changedKeys.includes(VAULT_BLOB_KEY) || changedKeys.includes(VAULT_KEY_KEY);
}
