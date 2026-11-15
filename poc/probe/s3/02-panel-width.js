(() => {
  const host = document.getElementById('pluma-panel-host');
  if (!host) return JSON.stringify({ err: 'no panel host' });

  // closed shadow → 用 host 的尺寸 + 从快照已知结构推断；
  // 但 .acct-* 在 shadow 内，这里读不到。改用 getBoundingClientRect 只能拿 host。
  // → 需要一个能穿透的办法：辅助功能树只给文本不给尺寸。
  //   所以本表达式只报 host 与 page 侧可见信息。
  const r = host.getBoundingClientRect();

  // 尝试：如果能拿到 shadowRoot（closed 拿不到）就直接量
  const sr = host.shadowRoot;

  return JSON.stringify({
    panelW: Math.round(r.width),
    panelH: Math.round(r.height),
    hasShadowRoot: !!sr,          // closed → false
    devicePixelRatio: window.devicePixelRatio,
    innerWidth: window.innerWidth,
  });
})()
