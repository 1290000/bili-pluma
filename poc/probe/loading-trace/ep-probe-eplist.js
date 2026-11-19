/**
 * 列选集区的 ep 链接（只读）：返回 ep 序号 + ep id（id 不是凭据，不含数字签名）。
 */
(async () => {
  const eps = [];
  const anchors = document.querySelectorAll('a[href*="/bangumi/play/ep"]');
  for (const a of anchors) {
    const href = String(a.getAttribute('href') || '');
    const m = href.match(/\/bangumi\/play\/ep(\d+)/);
    if (!m) continue;
    eps.push({
      ep: Number(m[1]),
      text: String(a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
      cls: String(a.className || '').slice(0, 40),
      parent: String((a.parentElement && a.parentElement.className) || '').slice(0, 40),
      visible: a.getBoundingClientRect().width > 0,
    });
  }
  return JSON.stringify({
    nowMs: Math.round(performance.now()),
    currentUrl: location.hostname + location.pathname,
    count: eps.length,
    eps,
  });
})()