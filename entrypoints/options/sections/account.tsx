/**
 * 账号页 —— 回答"两个身份分别是谁"。
 *
 * ## 两条数据来源完全不同，别混
 *
 * | 卡片 | 来源 | 为什么 |
 * | --- | --- | --- |
 * | 主账号 | 当前视频页的 content 数据（`__INITIAL_STATE__.user` + `DedeUserID`） | 扩展**不读**主账号凭据（决策 4），只能从页面借显示信息 |
 * | 播放账号 | `account/summary`（background 读 vault + 惰性 nav 探测） | 凭据在扩展自己的 vault 里 |
 *
 * ⚠️ 主账号的昵称**只在打开过视频页之后才有**。设置页独立打开时拿不到，
 * 这时要如实说"打开任意视频页后可见"，**不许自己发 nav 请求去猜**。
 *
 * ⚠️ 扫码必须走隔离窗口（`login/open` → `chrome.windows.create({incognito:true})`），
 * 不能在这里内嵌二维码 —— 理由见 ADR 0012（普通窗口登录会覆盖主账号登录态）。
 */

import { describeVip } from '@core/ui/popup-state';
import { queryPageState, type PageStateResult } from '@platform/page/page-state-client';
import type { AccountSummary } from '@shared/types/account';
import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { Card } from '../ui';

/** `account/summary` 的可读视图 */
interface AcctView {
  configured: boolean;
  account: AccountSummary | null;
}

/** 扫码后轮询：3 秒一次，最多 3 分钟（够慢的网络也能扫完） */
const POLL_MS = 3000;
const POLL_MAX = 60;

function send<T>(msg: unknown): Promise<T | null> {
  return chrome.runtime.sendMessage(msg).catch(() => null) as Promise<T | null>;
}

/** `checkedAt` → 人话。0 表示从未成功校验 */
function sinceText(checkedAt: number, now: number): string {
  if (!checkedAt) return '从未校验';
  const mins = Math.floor((now - checkedAt) / 60_000);
  if (mins < 1) return '刚刚校验';
  if (mins < 60) return `${String(mins)} 分钟前校验`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)} 小时前校验`;
  return `${String(Math.floor(hours / 24))} 天前校验`;
}

export function AccountSection(): JSX.Element {
  const [acct, setAcct] = useState<AcctView | null>(null);
  const [page, setPage] = useState<PageStateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  /** 退出是两步：点一次变成"确认退出"，再点一次才执行（不用 confirm，见 02 §7） */
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [now] = useState(() => Date.now());
  const pollRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const [acctRes, pageRes] = await Promise.all([
      send<{ type?: string; configured?: boolean; account?: AccountSummary | null }>({
        type: 'account/summary',
      }),
      queryPageState(),
    ]);

    if (acctRes?.type === 'account/summary:ok') {
      setAcct({ configured: acctRes.configured === true, account: acctRes.account ?? null });
    }
    setPage(pageRes);
  }, []);

  useEffect(() => {
    void refresh();
    return stopPolling;
  }, [refresh, stopPolling]);

  /**
   * 扫码后开始轮询。
   *
   * 为什么轮询而不是让登录窗口通知：登录窗口在**无痕分区**，那里是另一个 background
   * 实例（`incognito: "split"`），两个实例不能直接通信；共享的 `storage.local`
   * 是唯一可靠通道，而 `account/summary` 读的正是它。
   */
  const startPolling = useCallback(
    (midBefore: number | null) => {
      stopPolling();
      let ticks = 0;
      pollRef.current = window.setInterval(() => {
        ticks += 1;
        void (async () => {
          const res = await send<{
            type?: string;
            configured?: boolean;
            account?: AccountSummary | null;
          }>({ type: 'account/summary' });
          const mid =
            res?.type === 'account/summary:ok' ? (res.account?.profile.mid ?? null) : null;

          if (res?.configured === true && mid !== null && mid !== midBefore) {
            stopPolling();
            setHint('播放账号已配置，可以开始用了');
            await refresh();
            return;
          }
          if (ticks >= POLL_MAX) {
            stopPolling();
            setHint('等了 3 分钟还没读到新账号 —— 扫码成功了吗？也可以点「重新登录」再试一次');
          }
        })();
      }, POLL_MS);
    },
    [refresh, stopPolling],
  );

  const openLogin = useCallback(async () => {
    setBusy(true);
    setHint(null);
    const midBefore = acct?.account?.profile.mid ?? null;

    const res = await send<{ type?: string; opened?: boolean; reason?: string }>({
      type: 'login/open',
    });
    setBusy(false);

    if (res?.type !== 'login/open:ok') {
      setHint('登录窗口打不开，请重试');
      return;
    }
    if (res.opened !== true) {
      setHint(
        res.reason === 'incognito-disabled'
          ? '需要先在扩展详情页打开「在 InPrivate 中允许」（Chrome 叫「在无痕模式下启用」），再点一次'
          : '登录窗口打不开，请重试',
      );
      return;
    }

    setHint('登录窗口已打开，请用手机扫码。成功后窗口会自动关闭，这里会自动刷新。');
    startPolling(midBefore);
  }, [acct, startPolling]);

  const remove = useCallback(async () => {
    setBusy(true);
    const res = await send<{ type?: string; detail?: string }>({ type: 'account/remove' });
    setBusy(false);
    setConfirmRemove(false);

    if (res?.type === 'account/remove:ok') {
      setHint('已退出播放账号，取流回退到主账号身份');
      await refresh();
    } else {
      setHint(`退出失败：${res?.detail ?? '未知原因'}`);
    }
  }, [refresh]);

  // ── 主账号卡片的数据 ──
  const primary =
    page?.kind === 'ok'
      ? {
          known: true,
          loggedIn: page.view.primary.loggedIn,
          user: page.view.primary.user,
          mid: page.view.primary.mid,
        }
      : { known: false, loggedIn: 'unknown' as const, user: null, mid: null };

  const play = acct?.account ?? null;

  return (
    <>
      <Card title="主账号">
        {primary.loggedIn === 'yes' ? (
          <div class="acct">
            <div class="acct-main">
              <span class="acct-name">{primary.user?.uname || '已登录'}</span>
              <span class="acct-tag muted">只读</span>
            </div>
            <div class="acct-meta">
              {primary.mid ? `mid ${primary.mid}` : 'mid 未知'} · 收藏 · 点赞 · 评论 · 历史
            </div>
          </div>
        ) : primary.loggedIn === 'no' ? (
          <p class="empty">当前浏览器没有登录 B站。点赞、历史、评论都会不可用。</p>
        ) : (
          <p class="empty">
            {primary.known
              ? '还没读到主账号信息，稍等或刷新本页'
              : '打开任意视频页后这里会显示主账号昵称（信息来自页面，扩展不读凭据）'}
          </p>
        )}
      </Card>

      <Card title="播放账号">
        {play ? (
          <>
            <div class="acct">
              <div class="acct-main">
                <span class="acct-name">{play.profile.uname}</span>
                <span class="acct-tag">仅取流</span>
              </div>
              <div class="acct-meta">
                mid {play.profile.mid} · {describeVip(play, now)}
              </div>
              <div class="acct-meta">
                {play.health.healthy
                  ? sinceText(play.health.checkedAt, now)
                  : `凭据异常${play.health.reason ? `（${play.health.reason}）` : ''}`}
              </div>
            </div>

            <div class="actions">
              <button class="ghost" disabled={busy} onClick={() => void openLogin()}>
                重新登录
              </button>
              {confirmRemove ? (
                <>
                  <button class="danger" disabled={busy} onClick={() => void remove()}>
                    确认退出
                  </button>
                  <button class="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>
                    取消
                  </button>
                </>
              ) : (
                <button class="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
                  退出播放账号
                </button>
              )}
            </div>
          </>
        ) : acct?.configured ? (
          <p class="empty">
            已配置，但暂时读不出账号资料（可能是网络或风控）。点「重新登录」可以重新扫码。
          </p>
        ) : (
          <p class="empty">还没有配置播放账号。</p>
        )}

        {!play && (
          <div class="actions">
            <button class="primary" disabled={busy} onClick={() => void openLogin()}>
              扫码登录播放账号
            </button>
          </div>
        )}

        {hint && <p class="hint">{hint}</p>}
      </Card>
    </>
  );
}
