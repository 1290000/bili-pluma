// content script：作为"页面发起方"代打请求
//
// initiator 由浏览器的发起方链决定，无法从 JS 伪造，所以必须真的从页面里 fetch。
// 用 httpbin/anything 回显请求头，判据是服务端看到的 x-pluma-probe。
//
// ⚠️ all_frames: true —— 本文件在 iframe 里也会注入一份。
//    Q1 的关键追问是「iframe 发起的请求，initiator 算谁」，
//    所以必须能只让 iframe 那一份发请求（isTopFrame 用于区分）。

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'probe-fetch') return false;

  // 只让顶层文档响应（默认行为，保持原有测试语义）
  if (msg.topOnly !== false && window.top === window) {
    // 顶层，OK
  } else if (msg.topOnly === false && window.top !== window) {
    // 只让 iframe 响应
  } else {
    sendResponse({ ok: false, skipped: true, reason: 'frame filter' });
    return false;
  }

  (async () => {
    try {
      const res = await fetch(msg.url, { cache: 'no-store', credentials: 'include' });
      const text = await res.text();
      sendResponse({
        ok: true,
        status: res.status,
        body: text.slice(0, 2000),
        frame: {
          isTop: window.top === window,
          origin: location.origin,
          href: location.href,
        },
        visibleHeaders: [...res.headers.entries()].slice(0, 20),
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e), frameHref: location.href });
    }
  })();

  return true;
});
