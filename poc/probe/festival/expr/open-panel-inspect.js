(() => {
  const strip = document.querySelector('[aria-label="打开 Pluma 面板"]');
  if (!strip) return JSON.stringify({ error: 'no strip', href: location.href });
  strip.click();
  const host = document.getElementById('pluma-panel-host');
  const sr = host && host.shadowRoot;
  const nodes = [];
  if (sr) {
    sr.querySelectorAll('button,input,[role="switch"],label').forEach((el) => {
      nodes.push({
        tag: el.tagName,
        id: el.id || '',
        type: el.getAttribute('type') || '',
        aria: el.getAttribute('aria-label') || '',
        text: (el.textContent || '').trim().slice(0, 60),
        checked: el.checked === true ? true : (el.getAttribute('aria-checked') || ''),
      });
    });
  }
  return JSON.stringify({
    clicked: true,
    hasHost: !!host,
    hasShadow: !!sr,
    shadowChildCount: sr ? sr.children.length : 0,
    controls: nodes.slice(0, 120),
  }, null, 2);
})()
