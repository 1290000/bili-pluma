/**
 * 主账号"显示档案"缓存（ADR 0025）。
 *
 * ## 它解决什么问题
 *
 * 主账号的昵称 / 等级**只存在于播放页的 `__INITIAL_STATE__.user` 里**
 * —— 扩展不读主账号凭据（决策 4），所以它没有别的来源。
 * 在首页 / 空间 / 收藏夹点开 popup 时，当前页没有任何内容脚本，
 * 于是 A 卡片只能写"打开视频页后可见"。
 *
 * 这里存一份**播放页看到过的**显示信息，供非播放页读。
 *
 * ## 存什么、不存什么（这是本文件最重要的部分）
 *
 * | 字段 | 存不存 | 理由 |
 * | --- | --- | --- |
 * | `uname` | 存 | A 卡片要显示 |
 * | `level` | 存 | A 卡的 LV 标签 |
 * | `face` | 存 | 头像 URL（B 站公开页面本来就展示） |
 * | `savedAt` | 存 | TTL 判据 |
 * | `midHash` | 存（散列） | 只为回答"还是同一个号吗"，**不可反推** |
 * | `mid` | **不存** | 账号唯一标识，能跨站对账；显示根本不需要它 |
 * | 页面 / 视频标题 | **禁止** | 那是"他在看什么"，与功能无关 |
 * | 任何凭据字段 | **禁止** | 见 AGENTS.md §5.2 |
 *
 * 加法门槛：**新增字段前必须先回答"这条字段泄露后能关联到什么"**。
 * 答不上来就不加（ADR 0025 §变更门槛）。
 *
 * ## 为什么不加密
 *
 * `chrome.storage.local` 落盘就是明文 LevelDB，同用户下的任何程序都能读。
 * 而同目录下的密钥也一样能读 —— vault 的注释早就写清了这个边界
 * （"能防网页脚本与扩展，不能防本机程序"）。
 *
 * 所以对这份缓存加密，**保密性的提升接近零**，代价是跨层依赖 + 异步解密 + 密钥生命周期。
 * 真正降低风险的作法是**少存东西**（不存 mid、不存页面信息），不是换一把锁。
 */

/** 缓存有效期：7 天。过期后当作没有 —— 宁可不说，也不给一个可能错了半年的名字 */
export const PRIMARY_PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CACHE_KEY = 'pluma:primary-profile';

/** 供 `storage.onChanged` 比对键名 */
export const PRIMARY_PROFILE_KEY = CACHE_KEY;

/**
 * 散列的 salt。
 *
 * ⚠️ 这是**固定字符串，不是秘密** —— 它能被任何读到源码的人看到。
 * 它的作用不是保密，而是**避免跨站彩虹表**：不加 salt 的话别人可以用
 * 一张预计算的 `sha256(mid)` 表反查出 mid。
 *
 * 换成随机 salt 需要额外存一份 salt，而那份 salt 同样能被读到，
 * 安全性没有实质提升 —— 所以固定值是有意的取舍，不是遗漏。
 */
const MID_HASH_SALT = 'pluma:primary-mid:v1';

/** 缓存内容。**字段增减必须先过 ADR 0025 的变更门槛** */
export interface PrimaryProfile {
  uname: string;
  face: string | null;
  /** 等级；读不到是 `null`（**绝不编一个数字**） */
  level: number | null;
  /** 写入时刻（毫秒时间戳） */
  savedAt: number;
  /** `DedeUserID` 的加盐散列，用于判断"还是不是同一个号"。不可反推 */
  midHash: string;
}

/**
 * 算 `DedeUserID` 的加盐散列。
 *
 * 用 SHA-256 而不是简单哈希：mid 是**纯数字且空间小**，凡是能被暴力枚举的哈希
 * 都等于没散列。SHA-256 + salt 让枚举成本变成"每个候选都要算一次 SHA-256"，
 * 单次很便宜，但它至少防住了"拿一张现成表直接查"。
 *
 * @returns 十六进制串；`crypto.subtle` 不可用时返回 `''`（调用方据此跳过比对）
 */
export async function hashMid(mid: string): Promise<string> {
  if (!mid) return '';
  try {
    const data = new TextEncoder().encode(MID_HASH_SALT + ':' + mid);
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    let out = '';
    for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
    return out;
  } catch {
    return '';
  }
}

/**
 * 读缓存。
 *
 * **任何一项不合格都返回 `null`** —— 形状损坏、缺字段、过期、空昵称。
 * 不抛异常：调用方是 UI，读不到就退化成"打开视频页后可见"，
 * 不该因为一份缓存坏掉而让 popup 报错。
 *
 * @param now 时间戳（注入以便测试）
 */
export async function readPrimaryProfile(now: number = Date.now()): Promise<PrimaryProfile | null> {
  try {
    const bag = await chrome.storage.local.get(CACHE_KEY);
    const raw = bag[CACHE_KEY] as unknown;
    if (!raw || typeof raw !== 'object') return null;

    const o = raw as Record<string, unknown>;
    if (typeof o.uname !== 'string' || o.uname === '') return null;
    if (typeof o.savedAt !== 'number' || !Number.isFinite(o.savedAt)) return null;
    if (now - o.savedAt > PRIMARY_PROFILE_TTL_MS) return null;
    // 时间戳在未来 = 时钟被改过或数据被篡改，不能信
    if (o.savedAt - now > 60_000) return null;

    return {
      uname: o.uname,
      face: typeof o.face === 'string' && o.face ? o.face : null,
      /**
       * ⚠️ 等级必须是**有限数字**才收。字符串 `"6"` 也不收 ——
       * 卡片上写 `LV6` 就必须真是 6，宁可退化成「只读」标签。
       */
      level:
        typeof o.level === 'number' && Number.isFinite(o.level) && o.level >= 0 ? o.level : null,
      savedAt: o.savedAt,
      midHash: typeof o.midHash === 'string' ? o.midHash : '',
    };
  } catch {
    return null;
  }
}

/**
 * 写缓存。
 *
 * ## 必须显式传 `mid`
 *
 * 这不是为了存 mid（我们不存），而是**强制调用方证明"此刻确实读到了真实登录态"**。
 * 设计上把门关在函数签名上：拿不到 `DedeUserID` 的调用点根本传不出这个参数，
 * 于是"页面伪造 `ssr-playinfo` 写进一个假昵称"和"游客态覆盖掉真实昵称"这两种情况
 * 在类型层就写不出来。
 *
 * @param profile 昵称 / 头像 / 等级
 * @param mid     当前页面 cookie 里的 `DedeUserID`。**空串或 null 直接拒绝写入**
 * @param now     时间戳（注入以便测试）
 * @returns 是否真的写了
 */
export async function savePrimaryProfile(
  profile: { uname: string; face: string | null; level: number | null },
  mid: string | null,
  now: number = Date.now(),
): Promise<boolean> {
  /**
   * ⚠️ 这三条守卫是**唯一能防住"页面注入假昵称"的地方**，不要为了让调用点更简单而放宽。
   *
   * `ssr-playinfo` 的 `user` 来自主世界，而 `entrypoints/content.ts` 的注释写明
   * 「本侧不校验 token」—— 因为「主世界上报的内容只影响画质显示」。
   * 一旦它被持久化成"用户的账号"，威胁模型就变了：页面脚本伪造一条消息，
   * 就能把一个假昵称**永久写进扩展存储**，而且之后每个非播放页都显示它。
   *
   * `mid` 由 ISOLATED 自己从 `document.cookie` 读，页面写不了 —— 所以
   * "必须同时拿到 mid"就是那条闸门。
   */
  if (!profile.uname) return false;
  if (!mid || !/^\d+$/.test(mid)) return false;

  const midHash = await hashMid(mid);
  // 散列算不出来（crypto 不可用）时不写：没有归属判据的缓存会跨账号串用
  if (!midHash) return false;

  try {
    /**
     * ## 同账号不重复写
     *
     * 视频页每次打开都会上报（hello + 两次延迟补报，见 `main-world.js`），
     * 不去重的话每看一个视频就 `set` 一次 `storage.local`。
     *
     * 比对用 `midHash` + `uname` + `level`：`savedAt` 不参与，
     * 否则"每次都更新 `savedAt`"就等于"永不过期"，TTL 形同虚设。
     */
    const prev = await readPrimaryProfile(now);
    if (
      prev &&
      prev.midHash === midHash &&
      prev.uname === profile.uname &&
      prev.level === profile.level &&
      prev.face === profile.face
    ) {
      return false;
    }

    const entry: PrimaryProfile = {
      uname: profile.uname,
      face: profile.face,
      level: profile.level,
      savedAt: now,
      midHash,
    };
    await chrome.storage.local.set({ [CACHE_KEY]: entry });
    return true;
  } catch {
    /* 写失败不影响任何功能，静默 */
    return false;
  }
}

/**
 * 清除缓存。
 *
 * 目前只有一个调用方：退出播放账号（`account/remove`）。
 *
 * 为什么退出播放账号要清**主账号**的信息 —— 因为用户点「退出」的心理预期是
 * "这个扩展我不用了"。此时还留着他的昵称，既说不通也解释不清。
 */
export async function clearPrimaryProfile(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY).catch(() => {});
}
