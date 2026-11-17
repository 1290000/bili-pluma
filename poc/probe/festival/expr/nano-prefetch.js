(() => {
  const n = window.nano || {};
  const short = (x) => {
    if (x === null) return 'null';
    if (typeof x === 'function') return 'fn:' + (x.name || 'anon') + '(' + x.length + ')';
    if (Array.isArray(x)) return 'array(' + x.length + ')';
    if (typeof x === 'object') {
      let k = [];
      try { k = Object.keys(x).slice(0, 25); } catch (e) {}
      return 'obj{' + k.join(',') + '}';
    }
    const s = String(x);
    return typeof x + ':' + (s.length > 80 ? s.slice(0, 50) + '…' : s);
  };
  let fn = null;
  try {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n), 'prefetch');
    fn = d && d.get ? d.get.call(n) : n.prefetch;
  } catch (e) { fn = 'err:' + e.message; }
  let called = null;
  try {
    if (typeof fn === 'function') called = short(fn());
  } catch (e) { called = 'err:' + e.message; }
  let own = [];
  try { own = Object.keys(fn || {}).slice(0, 25); } catch (e) {}
  let src = '';
  try { src = String(fn).slice(0, 500); } catch (e) {}
  return {
    prefetchType: short(fn),
    prefetchCallResult: called,
    prefetchOwnKeys: own,
    prefetchSource: src,
  };
})()
