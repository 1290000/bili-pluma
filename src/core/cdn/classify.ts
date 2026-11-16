/**
 * CDN 主机名 → 线路分类。
 *
 * 分层：`core/` 纯函数，零 IO、零浏览器 API，可在 Node 里全覆盖
 * （`chrome` / `window` / `document` / `fetch(` 一律不许出现，ESLint 与
 * `scripts/check-boundaries.ts` 两道都会红）。
 *
 * ## 这个模块守的是什么
 *
 * 守的是**"屏蔽 PCDN"这个开关到底拦没拦**。判定错的代价不对称：
 *
 * - 把官方线路误判成 PCDN → 用户正常播放的镜像被拦 → 立刻能感知，会反馈；
 * - 把 PCDN 误判成官方 → **界面上一切正常**，开关看着开着，实际 PCDN 照跑。
 *
 * 第二种是"静默失败"，没有任何东西会报错，只能靠这里的判据正确。所以：
 *
 * 1. **先命中先返回，顺序即语义。** 下面 `classifyCdn()` 里的 if 顺序不是随意排的，
 *    改顺序 = 改行为。
 * 2. **域名匹配一律按标签边界**（`h === d || h.endsWith('.' + d)`），
 *    绝不用 `includes` / `endsWith(d)` 裸判 —— 否则 `evil-mcdn.attacker.test`
 *    会被当成 `mcdn`，攻击者只要注册个带关键词的域就能骗过屏蔽。
 * 3. **认不出就不猜。** 官方域里认不出机型时 `flavor` 返回 `null`，
 *    不编一个"服务商 CDN"给用户看 —— 用户会拿它去对照播放页右键的
 *    「视频统计信息 → Video Hosts」，说错就被抓。
 *
 * ## ⚠️ 顺序上最要命的一条：PCDN 判据必须排在"同域即官方"之前
 *
 * `mcdn.bilivideo.com` / `xy116x196x140x25xy.mcdn.bilivideo.cn` 实测都存在
 * （公共 DNS 对它们返回 `0.0.0.0`），而它们**就是 `bilivideo.com` 的子域**。
 *
 * 若把"`bilivideo.com` 子域 → official"提到前面，这批 PCDN 会全部被判成官方：
 * 开关开了也拦不住，**而且界面显示一切正常**（最坏的失败方向）。
 * 因此第 3/4 条（标签 / PCDN 供应商域）必须写在第 8 条（官方域兜底）之前。
 * `tests/unit/core/cdn/classify.test.ts` 的第一组用例就是钉这一条的。
 */

/** 线路大类。`pcdn` 是唯一会被屏蔽规则用到的值（其余三个只用于显示） */
export type CdnKind = 'official' | 'pcdn' | 'third-party' | 'unknown';

/**
 * `official` 的二级分类 —— **只用于显示，不参与过滤判断**。
 *
 * 屏蔽逻辑只问"是不是 pcdn"，从不问官方是哪一种；拆出来是为了让诊断页能说清
 * "官方镜像"还是"B站自建边缘"。非 `official` 时恒为 `null`。
 */
export type OfficialFlavor = 'partner' | 'self-built' | null;

/** `classifyCdn()` 的返回值 */
export interface CdnClass {
  /** 线路大类 */
  cls: CdnKind;
  /** 仅 `cls === 'official'` 时可能非 `null`；认不出机型时为 `null`（不猜） */
  flavor: OfficialFlavor;
}

/**
 * host 的**任一标签**等于这些词 → PCDN。
 *
 * 用标签相等而不是"包含"，是因为真实 PCDN 主机形如
 * `xy116x196x140x25xy.mcdn.bilivideo.cn`（`mcdn` 独立成标签），
 * 而 `includes('mcdn')` 会把 `evil-mcdn.attacker.test` 一起收进来。
 */
const PCDN_LABELS: readonly string[] = ['mcdn', 'pcdn', 'gotcha'];

/** PCDN 供应商自有域（后缀匹配，按标签边界） */
const PCDN_DOMAINS: readonly string[] = [
  'szbdyd.com',
  'mountaintoys.cn',
  'qrstuvwxyzab.com',
  'zhenidc.cn',
];

/** B站官方取流域（后缀匹配，按标签边界）。`flavor` 一律 `null` —— 认不出机型 */
const OFFICIAL_DOMAINS: readonly string[] = ['bilivideo.com', 'bilivideo.cn'];

/** 第三方 CDN（目前只实测到 Akamai 一家） */
const THIRD_PARTY_DOMAINS: readonly string[] = ['akamaized.net'];

/**
 * B站自建边缘：`cn-<地区>-<运营商>-<节点>` 形（播放页右键标为"自建 CDN"）。
 *
 * 实测全集（2026-11-17，`poc/probe/pcdn-diag/probe.mjs` 跑 20 个视频的 host 并集）：
 *
 * ```
 * cn-cq-gd-bcache-19.bilivideo.com     ← 重庆·广电，节点类型 bcache
 * cn-sccd-ct-02-13.bilivideo.com       ← 四川成都·电信，没有 bcache
 * cn-jsnt-ct-01-06.bilivideo.com       ← 江苏南通·电信，没有 bcache
 * ```
 *
 * ⚠️ **`bcache` 只是其中一种节点类型，不是自建的判据。**
 * 第一版正则写成 `^cn-[a-z0-9-]+-bcache-\d+\.`，只有第一种能命中，
 * 后两种掉到"官方域兜底" → `flavor: null` → 用户那块「（自建 CDN）」括号**大面积不显示**。
 * 它不会报错、不会拦错东西，只是少了一句说明 —— 属于只能靠实测全集发现的静默缺失。
 *
 * 所以判据只保留"行首 `cn-` + 单标签 + 官方域"，**不猜地区、不猜运营商、不猜节点类型**。
 * 行首锚定是必须的：`xvideos-cn-abc.bilivideo.com` 里的 `cn-` 出现在中间，不算自建。
 */
const SELF_BUILT_RE = /^cn-[a-z0-9-]+\.bilivideo\.(?:com|cn)$/;

/** 服务商镜像：`upos-sz-mirrorcos.bilivideo.com` 形（播放页右键标为"服务商 CDN"） */
const PARTNER_RE = /^upos-[a-z0-9-]+\.bilivideo\.(?:com|cn)$/;

/** 裸 IPv4 字面量 */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** IPv6 字面量的字符集（剥不出端口后只剩冒号形态时才用） */
const IPV6_CHARS_RE = /^[0-9a-f:.]+$/;

/** 单个 DNS 标签允许的字符（`_` 放过：内网/测试域偶见；IDN 的 `xn--` 也能过） */
const LABEL_RE = /^[a-z0-9_-]+$/;

/**
 * 明显不是主机名的 URL scheme 前缀。
 *
 * 实测 `<video src>` 上会出现 `blob:https://www.bilibili.com/...`，
 * 它既没有 host 也没有线路，必须落到 `unknown` 而不是被"含 `://` 里有点"骗着往下判。
 */
const SCHEME_PREFIXES: readonly string[] = [
  'blob:',
  'data:',
  'about:',
  'file:',
  'http:',
  'https:',
  'ws:',
  'wss:',
  'chrome-extension:',
  'moz-extension:',
];

/**
 * 剥掉端口，保留其余部分。
 *
 * `xy116x196x140x25xy.mcdn.bilivideo.cn:8082` 实测出现在资源条目里 ——
 * 带端口的 host 若不先剥，"`mcdn` 标签"仍能命中，但"`bilivideo.cn` 后缀"和
 * 那两条官方正则都会失效，于是同一台机器只因带了端口就换了个分类。
 *
 * @param value 已小写、已 trim 的输入
 * @returns 不含端口的 host；裸 IPv6 原样返回（它的冒号不是端口）
 */
function stripPort(value: string): string {
  if (value.startsWith('[')) {
    // `[::1]:8080` 形式
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }

  const colon = value.indexOf(':');
  if (colon < 0) return value;
  // 第二个冒号 → 裸 IPv6，不剥
  if (value.indexOf(':', colon + 1) >= 0) return value;

  const port = value.slice(colon + 1);
  return /^\d*$/.test(port) ? value.slice(0, colon) : value;
}

/**
 * 预处理：小写、剥端口、去尾点，并判定"这到底还算不算一个主机名"。
 *
 * @param raw 调用方给的原始 host（可能带端口 / 大小写 / 尾点）
 * @returns 可继续判定的小写 host；不可能是主机名时返回 `null`
 */
function normalizeHost(raw: string): string | null {
  const lowered = raw.trim().toLowerCase();
  if (lowered.length === 0) return null;
  if (SCHEME_PREFIXES.some((p) => lowered.startsWith(p))) return null;

  // 尾点（`mcdn.bilivideo.com.` 这种 FQDN 写法）不改变语义，去掉
  const host = stripPort(lowered).replace(/\.+$/, '');
  if (host.length === 0) return null;
  if (/[/\\?#@\s]/.test(host)) return null;

  if (host.includes(':')) {
    // 走到这里说明端口没剥掉：只接受 IPv6 字面量，其余当非法输入
    return IPV6_CHARS_RE.test(host) ? host : null;
  }

  if (!host.includes('.')) {
    // 单标签（`localhost` / `intranet`）：既不是域名也不是 IP，判不出线路
    return null;
  }

  return host.split('.').every((label) => LABEL_RE.test(label)) ? host : null;
}

/**
 * 按**标签边界**判断 `host` 是否属于 `domain` 或其子域。
 *
 * `h === d || h.endsWith('.' + d)` —— 这两条与 `includes(d)` 的区别就是
 * `evil-szbdyd.com` 与 `x.szbdyd.com.evil.test` 的判定方向。
 */
function matchDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** 任一供应商域命中即真 */
function matchAnyDomain(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => matchDomain(host, d));
}

/**
 * query 串里是否有**恰好等于** `os=mcdn` 的那一段。
 *
 * 判据对**任何 host** 生效：正规镜像也会代理 mcdn 资源，所以只看域名会漏判，
 * query 是唯一能暴露"这条地址其实指向 PCDN"的信号（与参考实现的
 * `isRiskyCdnUrl = 危险host || query含os=mcdn` 同口径）。
 *
 * ⚠️ **该判定不限定域名，且必须排在官方域兜底之前。**
 * 两件事都别"顺手修正"：收窄成只对 `bilivideo.*` 生效 → 第三方域里被代理的 mcdn 漏判；
 * 挪到兜底之后 → 官方域里的 `os=mcdn` 永远走不到这里（正是 `mcdn.bilivideo.com` 那个陷阱的同类）。
 *
 * ⚠️ 必须按 `&` 切段后**整段相等**：写成 `search.includes('os=mcdn')` 时
 * `os=mcdnx` / `xos=mcdn` 都会命中；写成 `includes('mcdn')` 则把 `os=cdn` 之外
 * 任何含 mcdn 的无关参数都收进来。误判的代价见文件头。
 *
 * @param search `location.search` / URL 的 query 串，可带前导 `?`
 */
function hasOsMcdn(search: string | undefined): boolean {
  if (search === undefined || search.length === 0) return false;
  const query = search.startsWith('?') ? search.slice(1) : search;
  return query
    .toLowerCase()
    .split('&')
    .some((seg) => seg.trim() === 'os=mcdn');
}

/**
 * 判定一个主机名（及其 query）属于哪条线路。
 *
 * **顺序即语义**：先命中先返回。特别是 `mcdn` 标签 / 供应商域必须排在
 * `bilivideo.*` 官方域兜底之前，否则 `mcdn.bilivideo.com` 会被官方域抢答。
 *
 * @param host 主机名，可带端口、可大写（内部会归一）；`<video src>` 的 `blob:` 串也可直接传
 * @param search 可选 query 串（含或含前导 `?` 均可）：任何 host 命中 `os=mcdn` 即判 PCDN
 * @returns 分类结果；`flavor` 只在 `cls === 'official'` 时可能非 `null`
 */
export function classifyCdn(host: string, search?: string): CdnClass {
  const h = normalizeHost(host);
  // 1. 不是主机名：没有线路可判，直接 unknown（不是 pcdn —— 别替用户拦来源不明的东西）
  if (h === null) return { cls: 'unknown', flavor: null };

  // 2. 裸 IP：PCDN 节点多是 IP 直连，域名层面没有任何可识别特征
  if (IPV4_RE.test(h) || h.includes(':')) return { cls: 'pcdn', flavor: null };

  // 3. 标签级关键词（`xy1.mcdn.bilivideo.cn` / `a.pcdn.foo`）—— 必须在第 8 条之前
  if (h.split('.').some((label) => PCDN_LABELS.includes(label))) {
    return { cls: 'pcdn', flavor: null };
  }

  // 4. 已知 PCDN 供应商自有域 —— 同样必须在第 8 条之前
  if (matchAnyDomain(h, PCDN_DOMAINS)) return { cls: 'pcdn', flavor: null };

  // 5. query 命中 `os=mcdn`（对任何 host 生效）：正规镜像也会代理 mcdn 资源，只看域名会漏判
  if (hasOsMcdn(search)) return { cls: 'pcdn', flavor: null };

  // 6. B站自建边缘
  if (SELF_BUILT_RE.test(h)) return { cls: 'official', flavor: 'self-built' };

  // 7. 服务商镜像
  if (PARTNER_RE.test(h)) return { cls: 'official', flavor: 'partner' };

  // 8. 官方域兜底：认不出机型就给 null，**不猜**
  if (matchAnyDomain(h, OFFICIAL_DOMAINS)) return { cls: 'official', flavor: null };

  // 9. 第三方 CDN
  if (matchAnyDomain(h, THIRD_PARTY_DOMAINS)) return { cls: 'third-party', flavor: null };

  // 10. 其余：没实测过的域一律 unknown（不擅自当成 pcdn 去拦）
  return { cls: 'unknown', flavor: null };
}
