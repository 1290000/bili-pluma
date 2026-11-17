(() => {
  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id).filter((id) => /pluma/i.test(id)).slice(0, 40);
  const labelled = [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).filter((a) => /pluma|面板/i.test(a || '')).slice(0, 20);
  const host = document.getElementById('pluma-panel-host');
  return JSON.stringify({
    href: location.href,
    hasPlumaMain: typeof window.__PLUMA_MAIN__,
    hasFestivalFlag: typeof window.__PLUMA_FESTIVAL__,
    plumaIds: ids,
    plumaAriaLabels: labelled,
    hostExists: !!host,
    hostShadow: !!(host && host.shadowRoot),
    bodyChildTags: [...document.body.children].map((e) => e.tagName + (e.id ? '#' + e.id : '')).slice(-25),
  }, null, 2);
})()
