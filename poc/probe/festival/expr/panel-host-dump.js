(() => {
  const info = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    return {
      id, childCount: el.children.length,
      htmlHead: el.innerHTML.slice(0, 600),
      shadow: el.shadowRoot ? { childCount: el.shadowRoot.children.length, htmlHead: el.shadowRoot.innerHTML.slice(0, 400) } : null,
    };
  };
  return JSON.stringify({ badge: info('pluma-badge-host'), panel: info('pluma-panel-host') }, null, 2);
})()
