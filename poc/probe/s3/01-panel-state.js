(() => {
  const host = document.getElementById('pluma-panel-host');
  if (!host) return JSON.stringify({ err: 'no panel host' });
  const r = host.getBoundingClientRect();
  return JSON.stringify({ panelW: Math.round(r.width), panelH: Math.round(r.height) });
})()
