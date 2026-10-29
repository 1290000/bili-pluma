/**
 * Popup —— 只回答一个问题："现在生效了吗？"
 *
 * 规范（docs/02-ui-spec.md §0）：popup 是**查看器**，不是操作台。
 * 每个元素都必须能回答"我现在应该担心吗"。不能回答的，全部移出 popup。
 *
 * 两条硬约束：
 *   1. **失焦即销毁** —— 不放二维码、不跑长任务。扫码走独立窗口。
 *   2. **无固定高度** —— 内容撑开会"抖动"，所以主容器设 min-height。
 *
 * ## 状态判定不在本文件
 *
 * 状态判定在 `src/core/ui/popup-state.ts`（纯函数 + 单测）。
 * 这里只负责取数据、渲染、处理点击。这样"该显示哪种状态"能被测，
 * 而不是靠肉眼看 TSX。
 *
 * 规范里还有「未生效（当前页不是播放页）」，那需要 popup 知道当前活动标签页 ——
 * 由下面的 `readPageView()` 承担。
 */

import { barStates, summarize } from '@core/playinfo/stats';
import { describeUnlock, isVideoPage } from '@core/playinfo/summary-view';
import {
  describePopup,
  describeExpiry,
  type PopupAccount,
  type PopupSnapshot,
} from '@core/ui/popup-state';
import { readPrimaryProfile } from '@platform/storage/primary-profile-store';
import type { PageTracksView } from '@shared/types/playinfo';
import { primaryPlaceholder, resolvePrimaryCard } from '@shared/utils/primary-card';
import { parsePlayPage } from '@shared/utils/video-page';
import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import '@/src/design/tokens.css';
import './style.css';

type LoadState =
  { kind: 'loading' } | { kind: 'ok'; snap: PopupSnapshot } | { kind: 'error'; detail: string };

type LoginHint = null | 'incognito-disabled' | 'opened' | 'failed';

/**
 * 当前标签页是不是受支持的播放页，以及 content 报来的取流数据。
 *
 * popup 自己没有页面上下文，只能查活动标签页 —— **popup 不会变成标签页**，
 * 所以这里的 `active: true` 拿到的确实是用户正在看的那个页面
 * （诊断页不同：它是 `open_in_tab`，会把自己变成活动标签页，见那个文件的注释）。
 *
 * ⚠️ 判据是 `parsePlayPage()`，**不是** `/video/` 正则。曾经用
 * `/^https?:\/\/(www\.)?bilibili\.com\/video\//` 当闸门，番剧页（`/bangumi/play/ep…`）
 * 直接被判成 `other` → popup 显示「未生效」，且 `page/summary:get` 根本不会发出，
 * §2.3「当前页解锁画质」在番剧/电影页永远不显示（2026-10-28 审查发现）。
 */
type PageView = { kind: 'play'; view: PageTracksView | null } | { kind: 'other' };

/** 会员类型的短标签（副标题里已经有到期日，这里只放类型，避免重复） */
const VIP_TAG: Record<'none' | 'monthly' | 'annual', string> = {
  none: '非会员',
  monthly: '大会员',
  annual: '年度大会员',
};

/**
 * 主账号卡片的原料。
 *
 * ## 两个来源，优先级不同
 *
 * | 当前页 | 来源 | 是否实时 |
 * | --- | --- | --- |
 * | 播放页（`/video` · `/bangumi/play`） | content 直连应答 | 实时 |
 * | 其他页（首页 / 空间 / 收藏夹） | `storage.local` 里的显示档案（ADR 0025） | 上次在播放页看到的 |
 *
 * 非播放页没有 content script，实时拿不到——这是决策 4（扩展不读主账号凭据）的
 * 直接后果，不是缺功能。所以退一步读缓存，**并且不标注时间**（用户明确不要
 * "3 天前看到"这种句子：它既不占价值，又在提醒用户"这信息可能不准"）。
 *
 * ⚠️ **"该从哪读"的判据在 `shared/utils/primary-card.ts`**（纯函数 + 单测）。
 * 播放页现在也会在实时拿不到时退到缓存兜底（问题 2/3），但**确认未登录时仍然不读**——
 * 那条纪律的完整说明与分支表都在那个文件里，改之前先读它。
 * 本文件只负责"真去读"。
 */
type PrimaryCard = import('@shared/utils/primary-card').PrimaryCard;

/** 打开设置页；`hash` 用来深链到某个分区（`#/quality` 等，见 options/main.tsx 的路由） */
function openOptions(hash = ''): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${hash}`) });
}

async function readPageView(): Promise<PageView> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== 'number' || !parsePlayPage(tab.url ?? '')) return { kind: 'other' };

    try {
      const reply = (await chrome.tabs.sendMessage(tab.id, { type: 'page/summary:get' })) as
        { type?: string; view?: PageTracksView } | undefined;
      if (reply?.type === 'page/summary:ok' && reply.view)
        return { kind: 'play', view: reply.view };
      // content 在但还没报到（刚注入 / 页面还没解析出 bvid）
      return { kind: 'play', view: null };
    } catch {
      // 没有 content script：页面在扩展安装/更新之前就打开了
      return { kind: 'play', view: null };
    }
  } catch {
    return { kind: 'other' };
  }
}

/**
 * 读主账号卡片的原料 —— **只负责取数，"该从哪读"的判据在纯函数里**。
 *
 * `resolvePrimaryCard()`（`shared/utils/primary-card.ts`）决定：
 *   - 播放页有实时昵称 → 用实时
 *   - 播放页确认未登录 → **不读缓存**，如实报未登录（原纪律，防游客显示成别人）
 *   - 播放页 `unknown` / `yes` 但没昵称 → 缓存兜底（修问题 2 番剧页、问题 3 刚进页面）
 *   - 非播放页 → 缓存（无 content script，ADR 0025）
 *
 * 这里只做两件事：把实时片段取出来、按需读一次缓存。判据本身有单测
 * （`tests/unit/shared/primary-card.test.ts`），所以本文件不需要为它写测试。
 */
async function readPrimaryCard(page: PageView): Promise<PrimaryCard> {
  const live =
    page.kind === 'play'
      ? {
          kind: 'play' as const,
          primary: page.view?.primary
            ? {
                uname: page.view.primary.user?.uname ?? null,
                level: page.view.primary.user?.level ?? null,
                loggedIn: page.view.primary.loggedIn,
              }
            : null,
        }
      : { kind: 'other' as const };

  /**
   * 只在**真的可能用到缓存**时才去读 —— `readPrimaryProfile()` 是一次
   * `chrome.storage.local.get`，popup 的生命以秒计，能省就省。
   */
  const needsCache = live.kind === 'other' || !live.primary?.uname;
  const cached = needsCache ? ((await readPrimaryProfile()) ?? null) : null;

  return resolvePrimaryCard(live, cached);
}

function App() {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [loginHint, setLoginHint] = useState<LoginHint>(null);
  const [error, setError] = useState<string | null>(null);
  /** 切换后被锁定旧画质的标签页。空数组表示不用提示 */
  const [affected, setAffected] = useState<number[]>([]);
  /** 「播放账号」就地展开的菜单 */
  const [menuOpen, setMenuOpen] = useState(false);
  /** 退出是两步：点一次变成"确认退出"，再点一次才执行（不用 confirm，见 02 §7） */
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** 当前页的取流数据（主账号基线 + 播放账号实际拿到的） */
  const [page, setPage] = useState<PageView>({ kind: 'other' });
  /** 主账号卡片原料：播放页读实时，其他页读缓存（ADR 0025） */
  const [primary, setPrimary] = useState<PrimaryCard>({
    uname: null,
    level: null,
    loggedIn: 'unknown',
    source: 'none',
  });
  /** 到期日的相对描述依赖"现在"，渲染期取一次即可 */
  const [now] = useState(() => Date.now());

  /**
   * 读一次完整快照。
   *
   * 三个消息**并行**发：proxy/status、account/summary、stats/recent。
   * 串行会让 popup 慢三倍，而 popup 的生命以秒计。
   *
   * @param recheckSummary 是否强制重探凭据。只在用户点「重新检查」时为 true，
   *   正常打开靠 6 小时窗口挡着（见 docs/04-project-structure.md §6）
   */
  const refresh = useCallback(async (recheckSummary = false) => {
    try {
      const [proxyRes, acctRes, statsRes, pageView] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'proxy/status' }).catch(() => null),
        chrome.runtime
          .sendMessage({ type: 'account/summary', recheck: recheckSummary })
          .catch(() => null),
        chrome.runtime.sendMessage({ type: 'stats/recent' }).catch(() => null),
        // 直连 content，不经 SW：数据只对当前页有意义（docs/protocols/messages.md 通道 D）
        readPageView(),
      ]);

      setPage(pageView);
      // 依赖 pageView，所以不能放进上面的 Promise.all（那会自己引用自己）
      setPrimary(await readPrimaryCard(pageView));

      if (proxyRes?.type !== 'proxy/status:ok') {
        setLoad({ kind: 'error', detail: '状态读取失败' });
        return;
      }

      const account: PopupAccount | null =
        acctRes?.type === 'account/summary:ok' && acctRes.account
          ? {
              uname: acctRes.account.profile.uname,
              mid: acctRes.account.profile.mid,
              vipLabel: acctRes.account.vipLabel,
              expireAt: acctRes.account.expireAt,
              healthy: acctRes.account.health.healthy,
              checkedAt: acctRes.account.health.checkedAt,
              reason: acctRes.account.health.reason,
            }
          : null;

      const acctOk = acctRes?.type === 'account/summary:ok';

      setLoad({
        kind: 'ok',
        snap: {
          proxy: {
            enabled: proxyRes.enabled,
            hasCredential: proxyRes.hasCredential,
            ruleCount: proxyRes.ruleCount,
          },
          // 两个来源任一为真就算已配置：proxy/status 看密文在不在，
          // account/summary 看凭据能不能读出来。两个都 false 才是真未配置
          configured: (acctOk && acctRes.configured) || proxyRes.hasCredential,
          account,
          buckets: statsRes?.type === 'stats/recent:ok' ? statsRes.buckets : [],
          page: pageView.kind === 'play' ? { kind: 'play' } : { kind: 'other' },
        },
      });
    } catch (e) {
      setLoad({ kind: 'error', detail: e instanceof Error ? e.message.slice(0, 60) : '未知错误' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 切换总开关。
   *
   * **乐观更新**：先动 UI 给即时反馈，失败再回滚。
   *
   * 理由：popup 失焦即销毁，而消息往返在 SW 冷启动时可能要上百毫秒。
   * 等往返再动 UI，用户会以为没点中而反复点。回滚比"卡着不动"诚实。
   */
  const toggle = useCallback(
    async (next: boolean) => {
      if (load.kind !== 'ok' || busy) return;

      setBusy(true);
      setError(null);
      setAffected([]);

      const prevSnap = load.snap;
      setLoad({ kind: 'ok', snap: { ...prevSnap, proxy: { ...prevSnap.proxy, enabled: next } } });

      try {
        const res = await chrome.runtime.sendMessage({ type: 'proxy/set', enabled: next });

        if (res?.type === 'proxy/set:ok') {
          await refresh();

          // 已打开的视频页不会因为改规则而变——playurl 只在加载时调一次。
          const tabs = await chrome.runtime
            .sendMessage({ type: 'proxy/affected-tabs' })
            .catch(() => null);
          if (tabs?.type === 'proxy/affected-tabs:ok' && tabs.count > 0) {
            setAffected(tabs.tabIds);
          }
        } else {
          setLoad({ kind: 'ok', snap: prevSnap });
          setError(res?.detail ?? '切换失败');
        }
      } catch (e) {
        setLoad({ kind: 'ok', snap: prevSnap });
        setError(e instanceof Error ? e.message.slice(0, 60) : '切换失败');
      } finally {
        setBusy(false);
      }
    },
    [load, busy, refresh],
  );

  const reloadAffected = useCallback(async () => {
    if (affected.length === 0) return;
    await chrome.runtime.sendMessage({ type: 'tabs/reload', tabIds: affected }).catch(() => {});
    setAffected([]);
  }, [affected]);

  const openLogin = useCallback(async () => {
    setBusy(true);
    setLoginHint(null);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'login/open' });
      if (res?.type === 'login/open:ok') {
        setLoginHint(
          res.opened
            ? 'opened'
            : res.reason === 'incognito-disabled'
              ? 'incognito-disabled'
              : 'failed',
        );
      } else {
        setLoginHint('failed');
      }
    } catch {
      setLoginHint('failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const recheck = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await refresh(true);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  /**
   * 退出播放账号。
   *
   * 退出会清凭据 + 关代理 + 清健康与统计（background 里一次做完），
   * 所以刷新一次状态就够，不需要额外动作。
   */
  const removeAccount = useCallback(async () => {
    setBusy(true);
    setError(null);
    const res = await chrome.runtime.sendMessage({ type: 'account/remove' }).catch(() => null);
    setBusy(false);
    setConfirmRemove(false);
    setMenuOpen(false);

    if (res?.type === 'account/remove:ok') {
      await refresh();
    } else {
      setError(res?.detail ?? '退出失败');
    }
  }, [refresh]);

  const snap = load.kind === 'ok' ? load.snap : null;
  const view = snap ? describePopup(snap) : null;
  /**
   * §2.3 的视图模型（纯函数在 core，可单测）。
   *
   * ⚠️ **总开关关着时传 `false`** —— `describeUnlock` 会返回 `null`，
   * 整块画质区不渲染（2026-10-29 用户要求）。没开代理时显示
   * 「主账号基线未知 · 1080P」描述的是一件不存在的事。
   */
  const unlock = describeUnlock(
    page.kind === 'play' ? page.view : null,
    snap?.proxy.enabled !== false,
  );

  /**
   * 成功率条形图的数据。
   *
   * **只在"有失败"时显示**（规格原写"只在已降级态显示"，这里放宽了一点）：
   * 用户说"没效果"时，1 次失败 / 3 次请求 = 67% 成功率，够不上 0.6 的降级阈值，
   * 但那种情况恰恰最需要这张图。全绿时不画 —— 那是噪音。
   */
  const bars = snap ? barStates(snap.buckets, now) : [];
  const stats = snap ? summarize(snap.buckets) : { total: 0, ok: 0, rate: null };
  const hasTrouble = bars.some((s) => s === 'partial' || s === 'fail');

  /**
   * §2.4 主账号卡片的原料。
   *
   * 播放页来自 content 实时应答；其他页来自 `storage.local` 的显示档案（ADR 0025）。
   * 两条来源在 `readPrimaryCard()` 里已经选好，这里只取。
   */
  const { uname: primaryUname, level: primaryLevel, loggedIn: primaryLoggedIn } = primary;

  const pillCls = load.kind === 'loading' ? 'pill-idle' : `pill-${view?.tone ?? 'danger'}`;
  const pillText = load.kind === 'loading' ? '读取中' : (view?.pill ?? '异常');

  return (
    <div class="popup">
      <header class="bar">
        <span class="brand">
          <img class="brand-logo" src={chrome.runtime.getURL('icon/128.png')} alt="" />
          Pluma
        </span>
        <span class={`pill ${pillCls}`}>{pillText}</span>
      </header>

      <main class="body">
        {load.kind === 'loading' && <p class="placeholder">正在读取状态…</p>}

        {load.kind === 'error' && <p class="placeholder error">读取失败：{load.detail}</p>}

        {load.kind === 'ok' && snap && view && (
          <div class="content">
            {/* 「已解锁」已经说明结果时不再重复一句话，避免 popup 变啰嗦 */}
            {/* 「已解锁」已经说明结果时不再重复一句话，避免 popup 变啰嗦。
                `view.line` 现在是可选的 —— 已接管/已停用/未生效这几种
                都不再写解释（胶囊已经回答了"生效了吗"，见 popup-state.ts）。 */}
            {!unlock?.improved && view.line && <p class={`line ${view.tone}`}>{view.line}</p>}

            {/* ── §2.3 当前页解锁画质（核心价值区）──
                规范原文："整个 popup 唯一不能省的部分"。
                必须有对比锚点 —— 没有"主账号仅可用 1080P"这行，
                用户感受不到这个插件做了什么。

                ⚠️ 开关关着时 `unlock` 是 `null`，这一块**什么都不渲染**（问题 5）。
                不能退回「正在读取本页取流数据…」—— 那是在开关关着、
                根本没有取流的情况下撒谎。 */}
            {page.kind === 'play' && snap?.proxy.enabled !== false ? (
              unlock && page.view ? (
                <div class="unlock">
                  {/* pageKey 在 PGC 页是 `ep:3854821`，前面加「番剧页 · 」比
                      「当前页面 · ep:3854821」读得通。判据与 summary-view 同一个。 */}
                  <p class="unlock-bv">
                    {isVideoPage(page.view.pageKey)
                      ? `当前页面 · ${page.view.pageKey}`
                      : `番剧页 · ${page.view.pageKey}`}
                  </p>
                  <div class="unlock-card">
                    <div class="unlock-head">
                      <span class={`unlock-title ${unlock.improved ? 'good' : 'muted'}`}>
                        {unlock.title}
                      </span>
                      <span class="unlock-anchor">{unlock.anchor}</span>
                    </div>
                    {unlock.badges.length > 0 && (
                      <div class="badges">
                        {unlock.badges.map((b) => (
                          <span class="badge" key={b}>
                            {b}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <p class="unlock-empty">正在读取本页取流数据…</p>
              )
            ) : /**
             * ## 非播放页：这一段整块不渲染（2026-10-29 用户要求）
             *
             * 曾经这里是「打开任意视频页查看效果」，后来改成
             * 「打开视频或番剧后，这里会显示该页已解锁的画质」——
             * 用户两次都要求删掉，理由一致：**他已经知道自己在首页**。
             *
             * 删掉之后这一段是 `null`，popup 在非播放页由
             * 胶囊 + 两张账号卡 + 开关构成，不再有一块空占位。
             */
            null}

            {/* ── 成功率条形图（§3 状态 4）──
                颜色是唯一编码：绿=全成功、琥珀=有失败、红=全失败、灰=这段时间没请求。
                灰色必须画灰：playurl 一小时里大部分桶本来就是空的，画红等于谎报。 */}
            {hasTrouble && (
              <div class="rate-wrap">
                <div class="rate-bars" role="img" aria-label="最近一小时的取流成功率">
                  {bars.map((state, i) => (
                    <span class={`rate-bar ${state}`} key={`${String(i)}-${state}`} />
                  ))}
                </div>
                <p class="rate-note">
                  最近 1 小时取流 {stats.ok}/{stats.total} 成功 · 灰格表示这段时间没有请求
                </p>
              </div>
            )}

            {/* ── §2.4 双账号卡片（信任建立区）──
                视觉层级刻意拉开：A 灰、B 信息色。目的是让 B 看起来像"受控的工具"，
                而不是"另一个活跃账号" —— 用户的潜在恐惧是"我的号会不会被切走"。
                B 可点击（就地展开菜单，不跳转），与 §2.6 的「播放账号」是同一个菜单。 */}
            <div class="pair">
              <div class="p-row">
                <span class="p-avatar">主</span>
                <span class="p-main">
                  <span class="p-name">
                    {primaryUname || primaryPlaceholder(page.kind, primaryLoggedIn)}
                  </span>
                  <span class="p-sub">收藏 · 点赞 · 评论 · 历史</span>
                </span>
                {/* 等级拿不到就写「只读」—— 不编一个 LV 数字 */}
                <span class="p-tag">{primaryLevel ? `LV${String(primaryLevel)}` : '只读'}</span>
              </div>

              {/* ⚠️ 只要**凭据在**就渲染这一行，哪怕读不出资料。
                  原来只判 `snap.account`，而它可能为 null（探测不确定 / 缓存没写过），
                  于是播放账号整行静默消失，用户会以为账号没了。 */}
              {(snap.account || snap.proxy.hasCredential) && (
                <button
                  class={`p-row playback ${menuOpen ? 'open' : ''}`}
                  onClick={() => {
                    setMenuOpen((v) => !v);
                    setConfirmRemove(false);
                  }}
                >
                  <span class="p-avatar accent">播</span>
                  <span class="p-main">
                    <span class="p-name">{snap.account?.uname ?? '播放账号已配置'}</span>
                    <span class="p-sub">
                      {snap.account
                        ? `仅取流 · ${describeExpiry(snap.account.expireAt, now) || '无到期日'}`
                        : '读不出账号资料 · 点开可重新登录'}
                    </span>
                  </span>
                  <span class="p-tag accent">
                    {snap.account ? VIP_TAG[snap.account.vipLabel] : '已配置'}
                  </span>
                </button>
              )}
            </div>

            {view.needsLogin ? (
              <>
                <button class="primary" disabled={busy} onClick={() => void openLogin()}>
                  {busy
                    ? '正在打开…'
                    : view.state === 'not-configured'
                      ? '扫码登录播放账号'
                      : '重新扫码'}
                </button>
                {view.state === 'not-configured' && (
                  <p class="note">主账号无需配置，自动沿用浏览器当前登录状态</p>
                )}
              </>
            ) : (
              <>
                <label class="row">
                  <span class="row-label">
                    自动接管取流
                    <span class="row-hint">只替换取流接口的身份，收藏/点赞/历史不受影响</span>
                  </span>
                  <span class={`switch ${snap.proxy.enabled ? 'on' : ''} ${busy ? 'busy' : ''}`}>
                    <input
                      type="checkbox"
                      checked={snap.proxy.enabled}
                      disabled={busy}
                      onChange={(e) => void toggle((e.target as HTMLInputElement).checked)}
                    />
                    <span class="knob" />
                  </span>
                </label>

                {affected.length > 0 && (
                  <div class="affected">
                    <p class="affected-text">
                      {affected.length} 个已打开的视频页仍是原画质，刷新后生效
                    </p>
                    <button class="ghost small" onClick={() => void reloadAffected()}>
                      全部刷新
                    </button>
                  </div>
                )}

                <div class="actions">
                  <button class="ghost small" disabled={busy} onClick={() => void recheck()}>
                    {busy ? '检查中…' : '重新检查'}
                  </button>
                </div>
              </>
            )}

            {error && <p class="hint danger">{error}</p>}
            {loginHint === 'incognito-disabled' && (
              <p class="hint danger">
                需要在扩展详情页打开「在 InPrivate 中允许」（Chrome 叫「在无痕模式下启用」）
              </p>
            )}
            {loginHint === 'opened' && <p class="hint">登录窗口已打开，请用手机扫码</p>}
            {loginHint === 'failed' && <p class="hint danger">登录窗口打不开，请重试</p>}
          </div>
        )}
      </main>

      {/* ── §2.6 底部操作 ──
          只有两个：「播放账号」就地展开（不跳转，避免丢掉上下文）、「设置」跳 options。
          「画质体检」按钮 2026-10-26 删除 —— 它指向的页面被砍了（ADR 0016），
          而那份对比数据本来就在上面的 §2.3 里。 */}
      <footer class="foot">
        {menuOpen && (
          <div class="foot-menu">
            <button class="ghost small" disabled={busy} onClick={() => void openLogin()}>
              重新登录
            </button>
            {confirmRemove ? (
              <button
                class="ghost small danger-text"
                disabled={busy}
                onClick={() => void removeAccount()}
              >
                确认退出
              </button>
            ) : (
              <button class="ghost small" disabled={busy} onClick={() => setConfirmRemove(true)}>
                退出播放账号
              </button>
            )}
            <button
              class="ghost small"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                setConfirmRemove(false);
              }}
            >
              取消
            </button>
          </div>
        )}

        <div class="foot-actions">
          <button
            class={`foot-btn ${menuOpen ? 'active' : ''}`}
            onClick={() => {
              setMenuOpen((v) => !v);
              setConfirmRemove(false);
            }}
          >
            播放账号
          </button>
          <button class="foot-btn" onClick={() => openOptions()}>
            设置
          </button>
        </div>
      </footer>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
