/**
 * 登录窗口 —— 独立 popup 窗口（420×600，与 `src/background/login-window.ts` 的 LOGIN_WINDOW 保持一致）。
 *
 * 为什么不能放 popup：规范 §1「Popup 失焦即关闭」，用户拿手机扫的时候窗口已经没了。
 *
 * 这里只做四件事：画二维码、轮询状态、显示三态、应答跨分区的存活探测。
 * 生成和轮询的逻辑都在 background，UI 只发消息。
 */

import { render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import {
  LOGIN_HEARTBEAT_INTERVAL_MS,
  LOGIN_PING_KEY,
  clearLoginHeartbeat,
  parseLoginPing,
  writeLoginHeartbeat,
  writeLoginPong,
} from '@/src/background/login-window';
import { POLL_INTERVAL_MS, isTerminal } from '@/src/core/auth/qrcode';
import { buildQrMatrix } from '@/src/platform/qr/qrcode';
import type { QrLoginStatus } from '@/src/shared/types/login';

import '@/src/design/tokens.css';
import './style.css';

const QUIET_ZONE = 4; // 二维码静区（模块数），规范要求至少 4

/**
 * 把二维码画到底层 canvas 上。
 *
 * 关键：**必须整数倍缩放**。若 canvas 内部尺寸与 CSS 尺寸不是整数倍关系，
 * 浏览器会做插值，模块边缘发虚，手机扫不出来。
 * 这里按可用空间算出整数 scale，再反推 canvas 尺寸与 CSS 尺寸。
 */
function drawQr(canvas: HTMLCanvasElement, text: string): void {
  const { size, cells } = buildQrMatrix(text);
  const total = size + QUIET_ZONE * 2;

  // 目标显示尺寸（px），与 .qr-canvas 的 CSS 尺寸保持一致
  const target = 280;
  const scale = Math.max(2, Math.floor(target / total));
  const px = total * scale;

  canvas.width = px;
  canvas.height = px;
  // 显式写死 CSS 尺寸 = 内部尺寸，杜绝浏览器插值
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';

  for (let row = 0; row < size; row += 1) {
    const line = cells[row];
    if (!line) continue;
    for (let col = 0; col < size; col += 1) {
      if (!line[col]) continue;
      ctx.fillRect((col + QUIET_ZONE) * scale, (row + QUIET_ZONE) * scale, scale, scale);
    }
  }
}

interface QrPayload {
  qrContent: string;
  qrcodeKey: string;
}

function App() {
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [status, setStatus] = useState<QrLoginStatus>({ kind: 'pending' });
  const [error, setError] = useState<string | null>(null);
  /** 扫码成功但凭据读取/落库失败。此时**不能**自动关窗口 */
  const [saveFailed, setSaveFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const regenerate = useCallback(async () => {
    setQr(null);
    setError(null);
    setSaveFailed(false);
    setStatus({ kind: 'pending' });

    try {
      const res = await chrome.runtime.sendMessage({ type: 'qr/generate' });
      if (res?.type === 'qr/generate:ok') {
        setQr({ qrContent: res.qrContent, qrcodeKey: res.qrcodeKey });
      } else {
        setError(res?.detail ?? '二维码生成失败');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void regenerate();
  }, [regenerate]);

  /**
   * ## 心跳 + 存活应答：告诉普通分区"这个扫码窗口还活着"（2026-11-12 task-24，
   * 2026-11-15 task-47 修）
   *
   * 背景：`incognito: "split"` 下普通实例**看不到**无痕分区的窗口和标签页
   * （`loginTabs` 恒为 0，`windows.create()` 返回 `undefined`），所以它无法
   * 直接判断"扫码窗口是不是已经开着"。唯一跨分区共享的通道是
   * `chrome.storage.local`（`login-handshake.ts` 已记录）。
   *
   * 本 effect 干两件事：
   *
   * 1. **周期写心跳** —— 只是"最近有过窗口"的线索，不是裁决依据。
   * 2. **关窗时清心跳** —— 见下面的 ⚠️。
   *
   * ## ⚠️ 「卸载时清心跳，让关窗立即生效」这句话曾经是错的
   *
   * 旧注释就是这么写的，而 React 的 `useEffect` cleanup **只在组件卸载时运行**。
   * 用户关掉浏览器窗口时，文档被**直接销毁**，React 根本不会走卸载流程
   * ⇒ cleanup 不跑 ⇒ 心跳停在最后一次写入 ⇒ 普通实例在 90 秒 TTL 内一直读到
   * "活着" ⇒ `probeExistingLoginWindow()` 返回非 null ⇒ `openLoginWindow()`
   * 直接返回 `already-open` ⇒ **既不建窗也不提示**。
   *
   * 真机日志（同一实例 14 次连续点击，age 从 49080ms 单调涨到 62190ms，
   * 屏幕上 0 个扫码窗）就是这个形态。
   *
   * ⇒ 所以清理必须挂在**文档销毁事件**上：`pagehide` 是关闭 / 导航的最后时机
   * （bfcache 那种"还会回来"的情形要跳过，见下），`beforeunload` 作为旧内核的兜底。
   * （`unload` 不用：Chrome 正在废弃它，且 bfcache 下不会触发。）
   *
   * ## ⚠️ 即使这样，清心跳仍**不是**可靠信号
   *
   * `chrome.storage.local.remove` 是**异步 IPC**，页面正在销毁时可能来不及完成；
   * 硬杀（崩溃 / 任务管理器结束进程 / 断电）时任何页面代码都不会跑。
   * 所以"窗口还在不在"的**裁决权不在这一层** —— 普通实例会发 ping，
   * 由本页面在 `onChanged` 里**当场回 pong**（见下一个 effect）。
   * 页面没了就没人应答，那一侧自然判"已关"。
   * 这里清心跳只是让下一次点击**少付 600ms 的探测超时**。
   */
  useEffect(() => {
    let cancelled = false;
    const instance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const beat = (): void => {
      if (cancelled) return;
      void writeLoginHeartbeat(instance);
    };

    // 立刻写一次：让"窗口刚开出来"就能被下一次点击探测到
    beat();
    const timer = window.setInterval(beat, LOGIN_HEARTBEAT_INTERVAL_MS);

    /** 幂等收尾：停心跳 + 清记录。事件与 React cleanup 都会调它 */
    const stopHeartbeat = (): void => {
      cancelled = true;
      window.clearInterval(timer);
      void clearLoginHeartbeat();
    };

    /**
     * ⚠️ `pagehide` 的 `persisted === true` 表示页面进了 **bfcache**（还会回来）。
     * 那种情况下清心跳等于把一个**活着的**窗口说成"关了" ⇒ 用户看到两个二维码。
     *
     * 注：Chrome 只要发现页面注册了 `beforeunload`，就不再让它进 bfcache，
     * 所以这条守卫大概率不会触发 —— 它守的是"浏览器将来放宽那个规则"。
     */
    const onPageHide = (event: PageTransitionEvent): void => {
      if (event.persisted) return;
      stopHeartbeat();
    };

    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', stopHeartbeat);

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', stopHeartbeat);
      stopHeartbeat();
    };
  }, []);

  /**
   * ## 应答普通分区的存活探测（ping → pong）
   *
   * 普通实例点扫码时会先发一个 ping（`requestLoginWindowPong()`），
   * **本页面还活着就当场写 pong**，它就据此报 `already-open`；
   * 本页面已经不在了（关窗 / 崩溃）就没人写 pong，它就照常建新窗口。
   *
   * ## 为什么用 `chrome.storage.onChanged` 而不是定时器轮询 ping
   *
   * `onChanged` 是**浏览器投递的事件**，不是定时器 ⇒
   * - 不受后台节流影响（窗口被完全遮住、被判 hidden 时，`setInterval` 会被压到
   *   每分钟一次，而事件照常投递）—— 这正是"用时间戳判断活着"不可靠的反面；
   * - 页面对"我正在销毁"没有任何责任：不跑就是不在，语义天然正确。
   *
   * 这也是这条 bug 的根因给的教训：**别让"清理"成为判定活着的前提**。
   */
  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== 'local') return;
      const change = changes[LOGIN_PING_KEY];
      if (!change) return;
      const ping = parseLoginPing(change.newValue);
      // 读不懂就当没收到（脏数据不该让页面抛错，也不该伪造"活着"）
      if (ping === null) return;
      void writeLoginPong(ping.nonce);
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // 画二维码
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !qr) return;
    drawQr(canvas, qr.qrContent);
  }, [qr]);

  // 轮询：用递归 setTimeout 而不是 setInterval，
  // 避免请求还没回来就叠上下一次
  useEffect(() => {
    if (!qr) return;

    let cancelled = false;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      if (cancelled) return;

      try {
        const res = await chrome.runtime.sendMessage({ type: 'qr/poll', qrcodeKey: qr.qrcodeKey });
        if (cancelled) return;

        if (res?.type === 'qr/poll:ok') {
          setStatus(res.status);
          // 登录成功但凭据没存进去 —— 必须让用户看见，否则窗口自动关闭后
          // 他只是回到 popup 看到"凭据失效"，完全不知道发生了什么。
          if (res.status.kind === 'success' && !res.credentialSaved) {
            setSaveFailed(true);
            return;
          }
          if (isTerminal(res.status)) return;
        } else {
          setStatus({ kind: 'error', code: -1, message: res?.detail ?? '轮询失败' });
          return;
        }
      } catch (e) {
        if (!cancelled) setStatus({ kind: 'error', code: -1, message: String(e) });
        return;
      }

      timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [qr]);

  // 成功后自动关闭，让用户回到视频页。
  //
  // ⚠️ 必须同时满足 `!saveFailed`。曾经只看 status.kind === 'success'，
  // 结果凭据没存进去时窗口照样关掉，失败被完全吞掉——
  // 用户只看到 popup 说"凭据读取失败"，无从判断发生了什么。
  useEffect(() => {
    if (status.kind !== 'success' || saveFailed) return;
    const t = window.setTimeout(() => window.close(), 1500);
    return () => clearTimeout(t);
  }, [status, saveFailed]);

  const statusText = (() => {
    switch (status.kind) {
      case 'pending':
        return '请用哔哩哔哩手机客户端扫码';
      case 'scanned':
        return '已扫码，请在手机上确认登录';
      case 'expired':
        return '二维码已失效';
      case 'success':
        return saveFailed ? '扫码成功，但读取登录凭据失败' : '登录成功，正在关闭…';
      case 'error':
        return `登录失败：${status.message}`;
    }
  })();

  const showQr = !saveFailed && (status.kind === 'pending' || status.kind === 'scanned');

  return (
    <div class="wrap">
      <h1 class="title">登录取流账号</h1>
      <p class="subtitle">主账号无需配置，自动沿用浏览器当前的登录状态</p>

      <div class={`qr-card ${status.kind}`}>
        {showQr && qr && <canvas ref={canvasRef} class="qr-canvas" />}
        {showQr && !qr && !error && <div class="placeholder">正在生成二维码…</div>}
        {status.kind === 'expired' && <div class="placeholder">二维码已失效</div>}
        {status.kind === 'success' && !saveFailed && <div class="placeholder success">✓</div>}
        {saveFailed && <div class="placeholder error">!</div>}
        {status.kind === 'error' && <div class="placeholder error">!</div>}
      </div>

      <p class={`status ${status.kind}`}>{statusText}</p>

      {saveFailed && (
        <div class="save-failed">
          <p class="save-failed-title">账号已登录成功，但扩展读不到凭据</p>
          <p class="save-failed-note">
            通常是 InPrivate 窗口允许扩展运行了，但 cookies 权限没跟上。请在扩展详情页确认「在
            InPrivate 中允许」已打开（Chrome 叫「在无痕模式下启用」），然后重新扫码。
          </p>
        </div>
      )}

      {(status.kind === 'expired' || status.kind === 'error' || error || saveFailed) && (
        <button class="refresh" onClick={() => void regenerate()}>
          刷新二维码
        </button>
      )}

      <p class="footnote">凭据仅保存在本地，不会上传到任何服务器</p>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
