(() => {
  const w = window.open('', 'probeWin');
  if (!w) return { ok: false, handle: false };
  let state = 'unknown';
  try { state = w.document ? w.document.readyState : 'no-document'; } catch (e) { state = 'err:' + e.message; }
  return { ok: true, handle: true, name: w.name, closed: w.closed, readyState: state, href: (() => { try { return w.location.href; } catch (e) { return 'err'; } })() };
})()
