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
 * 规范里还有「未生效（当前页不是视频页）」，那需要 popup 知道当前活动标签页，
 * 属于 P3 的范围，这里不做。
 */

import { describeUnlock } from '@core/playinfo/summary-view';
import {
  describePopup,
  describeVip,
  type PopupAccount,
  type PopupSnapshot,
} from '@core/ui/popup-state';
import type { PageTracksView } from '@shared/types/playinfo';
import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import '@/src/design/tokens.css';
import './style.css';

type LoadState =
  { kind: 'loading' } | { kind: 'ok'; snap: PopupSnapshot } | { kind: 'error'; detail: string };

type LoginHint = null | 'incognito-disabled' | 'opened' | 'failed';

/**
 * 当前标签页是不是视频页，以及 content 报来的取流数据。
 *
 * popup 自己没有页面上下文，只能查活动标签页 —— **popup 不会变成标签页**，
 * 所以这里的 `active: true` 拿到的确实是用户正在看的那个页面
 * （诊断页不同：它是 `open_in_tab`，会把自己变成活动标签页，见那个文件的注释）。
 */
type PageView = { kind: 'video'; view: PageTracksView | null } | { kind: 'other' };

const VIDEO_URL_RE = /^https?:\/\/(www\.)?bilibili\.com\/video\//;

async function readPageView(): Promise<PageView> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== 'number' || !VIDEO_URL_RE.test(tab.url ?? '')) return { kind: 'other' };

    try {
      const reply = (await chrome.tabs.sendMessage(tab.id, { type: 'page/summary:get' })) as
        { type?: string; view?: PageTracksView } | undefined;
      if (reply?.type === 'page/summary:ok' && reply.view)
        return { kind: 'video', view: reply.view };
      // content 在但还没报到（刚注入 / 页面还没解析出 bvid）
      return { kind: 'video', view: null };
    } catch {
      // 没有 content script：页面在扩展安装/更新之前就打开了
      return { kind: 'video', view: null };
    }
  } catch {
    return { kind: 'other' };
  }
}

function App() {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [loginHint, setLoginHint] = useState<LoginHint>(null);
  const [error, setError] = useState<string | null>(null);
  /** 切换后被锁定旧画质的标签页。空数组表示不用提示 */
  const [affected, setAffected] = useState<number[]>([]);
  /** 当前页的取流数据（主账号基线 + 播放账号实际拿到的） */
  const [page, setPage] = useState<PageView>({ kind: 'other' });
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
          page: pageView.kind === 'video' ? { kind: 'video' } : { kind: 'other' },
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

  const snap = load.kind === 'ok' ? load.snap : null;
  const view = snap ? describePopup(snap) : null;
  /** §2.3 的视图模型（纯函数在 core，可单测） */
  const unlock = describeUnlock(page.kind === 'video' ? page.view : null);

  const pillCls = load.kind === 'loading' ? 'pill-idle' : `pill-${view?.tone ?? 'danger'}`;
  const pillText = load.kind === 'loading' ? '读取中' : (view?.pill ?? '异常');

  return (
    <div class="popup">
      <header class="bar">
        <span class="brand">Pluma</span>
        <span class={`pill ${pillCls}`}>{pillText}</span>
      </header>

      <main class="body">
        {load.kind === 'loading' && <p class="placeholder">正在读取状态…</p>}

        {load.kind === 'error' && <p class="placeholder error">读取失败：{load.detail}</p>}

        {load.kind === 'ok' && snap && view && (
          <div class="content">
            {/* 「已解锁」已经说明结果时不再重复一句话，避免 popup 变啰嗦 */}
            {!unlock?.improved && <p class={`line ${view.tone}`}>{view.line}</p>}

            {/* ── §2.3 当前页解锁画质（核心价值区）──
                规范原文："整个 popup 唯一不能省的部分"。
                必须有对比锚点 —— 没有"主账号仅可用 1080P"这行，
                用户感受不到这个插件做了什么。 */}
            {page.kind === 'video' ? (
              unlock && page.view ? (
                <div class="unlock">
                  <p class="unlock-bv">当前页面 · {page.view.bvid}</p>
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
            ) : (
              <p class="unlock-empty">打开任意视频页查看效果</p>
            )}

            {/* 账号卡片：信任建立区。
                刻意做成"一行摘要"而不是头像卡片——让用户确信这只是
                一个受控的取流工具，不是又一个活跃账号。 */}
            {snap.account && (
              <div class="account">
                <span class="account-name">{snap.account.uname}</span>
                <span class="account-meta">{describeVip(snap.account, now)}</span>
                <span class="account-role">仅取流</span>
              </div>
            )}

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
                  <button class="ghost small" disabled={busy} onClick={() => void openLogin()}>
                    重新登录
                  </button>
                  <button class="ghost small" disabled={busy} onClick={() => void recheck()}>
                    {busy ? '检查中…' : '重新检查'}
                  </button>
                </div>
              </>
            )}

            {error && <p class="hint danger">{error}</p>}
            {loginHint === 'incognito-disabled' && (
              <p class="hint danger">需要在扩展详情页勾选「在 InPrivate 中允许」</p>
            )}
            {loginHint === 'opened' && <p class="hint">登录窗口已打开，请用手机扫码</p>}
            {loginHint === 'failed' && <p class="hint danger">登录窗口打不开，请重试</p>}
          </div>
        )}
      </main>

      <footer class="foot">
        <span>B站双账号画质助手</span>
      </footer>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
