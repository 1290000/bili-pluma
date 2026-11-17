(async () => {
  const html = document.documentElement.outerHTML;
  const markers = ['__playinfo__', '__INITIAL_STATE__', 'createPlayer', 'nano.createPlayer', 'playurl'];
  return JSON.stringify({
    href: location.href,
    htmlLength: html.length,
    markerCount: Object.fromEntries(markers.map((m) => [m, html.split(m).length - 1])),
    title: document.title,
  }, null, 2);
})()
