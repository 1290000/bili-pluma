/**
 * 代理路径白名单 —— **唯一真相源**。
 *
 * 所有匹配逻辑必须引用本文件，不许在别处硬编码路径字符串。
 * B站改路径时只改这一个文件。
 *
 * ⚠️ `enabled` 字段反映的是**实测结论**（最近一次 2026-10-28 真机重测），不是文档抄来的清单。
 * 来源：poc/verify/RESULT.md、docs/03-open-questions.md Q4、ADR 0007 / 0019 / 0023。
 */

export const BILI_API_HOST = 'api.bilibili.com';
export const BILI_WEB_HOST = 'www.bilibili.com';

/**
 * 取流接口可能出现的**全部**主机。
 *
 * ## 为什么必须有第二个（2026-10-29 真机）
 *
 * 用户报「限免/免费集切换大会员画质会切换失败」。抓包抓到决定性证据：
 *
 * ```
 * 200 api.bilibili.com/pgc/player/web/playurl?…qn=120…  → DNR 命中 → 2160 ✅
 * 200 api.biliapi.net/pgc/player/web/playurl?…qn=120…   → DNR 未命中 → 480  ❌
 * 200 …/log/web…quality_toast_show|{"TBD":3}            → 切换失败提示
 * ```
 *
 * **播放器对同一次画质切换会同时发两条请求**，一条到 `api.bilibili.com`、
 * 一条到 `api.biliapi.net`（B 站的备选 API 域名，用于容灾/灰度），
 * 然后采用后者返回的结果。只代理主域名 → 备选域名那条仍是主账号身份 →
 * 拿不到 4K → 播放器判定切换失败。
 *
 * ## 这不是扩大越权范围
 *
 * 同一个接口、同一个用途、同一个身份。**路径白名单仍然限制着**
 * （`isProxyPath()` 只放行那几条 playurl），这个域名上的其它接口不会被代理。
 *
 * ⚠️ 加主机必须同步三处，缺一处就会静默失效：
 *   1. 本常量（DNR 的 `requestDomains`）
 *   2. `src/content/main-world.js` 的 `PATCH_HOSTS`（响应体改写）
 *   3. 跑 `poc/verify/run-q2-auto.cjs`（DNR 并发回归）
 */
export const BILI_API_HOSTS = [BILI_API_HOST, 'api.biliapi.net'] as const;

/**
 * `nav` 接口 —— 用于探测播放账号凭据是否有效。
 *
 * ⚠️ **它不在代理白名单里**，也不需要：探活必须用**指定账号**的凭据，
 * 而白名单规则注入的是"全局那一个"。探活由 `platform/http/nav.ts`
 * 自己拼 Cookie 头（`credentials: 'omit'`）。
 *
 * 放在这里而不是散在别处，是为了和 B 站域名/路径变更保持单点维护。
 */
export const NAV_URL = `https://${BILI_API_HOST}/x/web-interface/nav`;

export interface ProxyRoute {
  path: string;
  method: 'GET' | 'POST';
  label: string;
  /** 只有 true 的路径会被代理 */
  enabled: boolean;
  /** 为什么启用/禁用，写实测依据而不是猜测 */
  note: string;
}

/**
 * 白名单修订号 —— **只在「路径字符串」或「enabled 开关」变化时 +1**。
 *
 * 改注释、改 note 文案、调整顺序都**不算**。规则不写死的话，这个号会失去意义。
 *
 * 它**不是发布版本号**：发布版本是 manifest 的 `version`（`wxt.config.ts`）。
 * 两者不同步变化 —— 改 UI 会升发布版本但白名单没变；补一条路径会升修订号但可以不发版。
 *
 * 用途只有一个：**用户报 bug 时能说清"我这份清单是哪一版"**。
 *
 * 修订记录：
 *   1 → 2026-10-26 普通视频两条
 *   2 → 2026-10-27 打开 `/pgc/player/web/playurl`（ADR 0019，实测接口有效）
 *   3 → 2026-10-28 打开 `/ogv/player/playview`（实测是 GET，SPA 切集时页面会调用）
 *
 * ⚠️ **2026-10-29 增加了域名 `api.biliapi.net`（ADR 0027），修订号不变。**
 * 规则是「只在**路径字符串**或 `enabled` 开关变化时 +1」——
 * 路径一条没动、开关一个没改，所以不 +1。
 * 域名变化体现在 `BILI_API_HOSTS`，它有自己的注释说明。
 */
export const ROUTES_REVISION = 3;

/**
 * 白名单最后一次**人工核对 B站 前端**的日期。
 *
 * ⚠️ **只做展示，不参与任何判断。**
 *
 * 曾经想用"超过 90 天就变琥珀色提示可能过期" —— 那是错的：B站 一年不改接口的话，
 * 白名单一年不需要动，而琥珀色会一直亮着。**假警报会训练用户忽略它**，
 * 等到真出问题时那个颜色已经没人看了。
 *
 * 正确的做法是**按证据报警**：只有真的出现取流失败时，才在诊断页提示"可能是接口变了"。
 * 日期本身回答的是"这份清单是哪天的"，不是"它过期了" —— 让人自己判断。
 */
export const ROUTES_CHECKED_AT = '2026-10-29';

export const PROXY_ROUTES = [
  {
    path: '/x/player/wbi/playurl',
    method: 'GET',
    label: '普通视频取流（当前）',
    enabled: true,
    note: 'Q8 已验证（2026-10-26）：普通视频 / 多 P / 互动视频 都走这条，均能拿到 2160p 以上',
  },
  {
    path: '/x/player/playurl',
    method: 'GET',
    label: '普通视频取流（旧版兜底）',
    enabled: true,
    note: '本次未观测到，保留兜底。启用前需重新确认仍可用',
  },
  {
    path: '/pgc/player/web/playurl',
    method: 'GET',
    label: '番剧 / 国创 / 电影取流（当前）',
    enabled: true,
    note: '2026-10-27 实测：**页面不调用它**（取流由 SSR 写进 HTML），但**接口本身有效** —— 只要 cid 就能调通，番剧返 dash、电影返 durl。由主世界主动调用（ADR 0019）',
  },
  {
    path: '/pgc/player/web/v2/playurl',
    method: 'GET',
    label: '番剧取流（v2）',
    enabled: false,
    note: '2026-10-27 实测：HTTP 200 + code 0 但 result 里既无 dash 也无 durl（空壳）。别顺手改 true',
  },
  {
    path: '/ogv/player/playview',
    method: 'GET',
    label: '番剧 OGV 播放器（SPA 切集时页面调用）',
    enabled: false,
    note: '**保持 false，但理由已更正**（2026-10-28 真机重测）。它是 GET，SPA 切集时页面必经此路取流。⚠️ **不能给它开 DNR**：一开 Cookie 就换成播放账号，服务端返回的流形态从「durl 4 组 × 6 分钟」变成「完整集 dash」，而播放器已按 durl 分支准备好 → 灰屏（两次实测）。**正确做法是在页面侧拦它的响应、把 durl 换成完整集 durl**（形态一致，ADR 0023）—— 那条路不需要它进白名单，因为换流由主世界做，取完整流走的是已在白名单里的 `/pgc/player/web/playurl`',
  },
  {
    path: '/xlive/web-room/v2/index/getRoomPlayInfo',
    method: 'GET',
    label: '直播取流（当前）',
    enabled: false,
    note: 'v1 不支持直播 —— 这是决定，不是遗漏（ADR 0007 / Q8）。别顺手改 true',
  },
  {
    path: '/room/v1/Room/playUrl',
    method: 'GET',
    label: '直播取流（旧版）',
    enabled: false,
    note: 'v1 不支持直播 —— 这是决定，不是遗漏（ADR 0007 / Q8）。别顺手改 true',
  },
] as const satisfies readonly ProxyRoute[];

/** 只有这些路径会被 DNR 规则命中 */
export const ENABLED_ROUTE_PATHS: readonly string[] = PROXY_ROUTES.filter((r) => r.enabled).map(
  (r) => r.path,
);

/**
 * 判断一个 pathname 是否在白名单内。
 *
 * 用 `===` 或 `startsWith(path + '/')` 而不是裸 `startsWith(path)`，
 * 否则 `/x/player/playurl` 会误匹配 `/x/player/playurlXxx`。
 */
export function isProxyPath(pathname: string): boolean {
  return ENABLED_ROUTE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
