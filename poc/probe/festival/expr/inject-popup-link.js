(() => {
  const old = document.getElementById('probe-open');
  if (old) old.remove();
  const a = document.createElement('a');
  a.id = 'probe-open';
  a.href = 'about:blank';
  a.target = 'probeWin';
  a.textContent = 'probe-open-window';
  a.style.cssText = 'position:fixed;left:10px;top:10px;z-index:2147483647;background:#fff;color:#000;padding:8px;font-size:14px';
  document.body.appendChild(a);
  return { ok: true, id: a.id };
})()
