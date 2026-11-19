(() => {
  const w = window.open('about:blank', 'probeWin', 'width=900,height=700');
  if (!w) return { ok: false, blocked: true };
  try { w.__probeParent = true; } catch (e) {}
  return { ok: true, name: w.name, hasWindow: true, closed: w.closed };
})()
