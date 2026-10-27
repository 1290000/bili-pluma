/**
 * 登录窗口 —— 独立 popup 窗口（420×560）。
 *
 * 为什么不能放 popup：规范 §1「Popup 失焦即关闭」，用户拿手机扫的时候窗口已经没了。
 *
 * 这里只做三件事：画二维码、轮询状态、显示三态。
 * 生成和轮询的逻辑都在 background，UI 只发消息。
 */

import { render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

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
      <h1 class="title">登录播放账号</h1>
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
