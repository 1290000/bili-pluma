/**
 * 只读盘点活动页 window.__INITIAL_STATE__ 里与画质/权益相关的字段。
 * 凭据类值一律 [redacted]；签名/直链一律不输出原值。
 */
(() => {
  const s = window.__INITIAL_STATE__;
  if (!s || typeof s !== 'object') return JSON.stringify({ error: 'no __INITIAL_STATE__', href: location.href });
  const interesting = /quality|qual|vip|upower|format|height|width|codec|frame|dash|playurl|playinfo|cid|aid|bvid|duration|right|auth|level|permission|hdr|dolby|hires|fnval|qn|type|islogin|isLogin/i;
  const sensitive = /cookie|token|session|sessdata|bili_jct|password|secret|sign|key|rid|wts|csrf|mid|face|avatar|uname|nick|email|tel/i;
  const scalar = (v) => (v === null ? 'null' : typeof v);
  const safeVal = (k, v) => {
    if (sensitive.test(k)) return '[redacted]';
    if (typeof v === 'string' && v.length > 80) return '[long:' + v.length + ']';
    return v;
  };
  const out = [];
  let count = 0;
  const walk = (obj, path, depth) => {
    if (count > 600 || depth > 7 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      if (interesting.test(path)) {
        out.push({ path, type: 'array', len: obj.length, sample: obj.slice(0, 4).map((x) => (x && typeof x === 'object' ? '[obj]' : safeVal(path, x))) });
        count++;
      }
      obj.slice(0, 3).forEach((x, i) => walk(x, path + '[' + i + ']', depth + 1));
      return;
    }
    for (const k of Object.keys(obj)) {
      const kp = path ? path + '.' + k : k;
      const v = obj[k];
      if (interesting.test(k)) {
        if (v === null || typeof v !== 'object') {
          out.push({ path: kp, type: scalar(v), value: safeVal(k, v) });
        } else if (Array.isArray(v)) {
          out.push({ path: kp, type: 'array', len: v.length, sample: v.slice(0, 8).map((x) => (x && typeof x === 'object' ? '[obj]' : safeVal(k, x))) });
        } else {
          out.push({ path: kp, type: 'obj', keys: Object.keys(v).slice(0, 24) });
        }
        count++;
      }
      walk(v, kp, depth + 1);
    }
  };
  walk(s, '', 0);

  const vi = s.videoInfo || {};
  const ui = s.userInfo || {};
  const pl = s.player || {};
  const scalarEntries = (o, keys) => Object.fromEntries(
    (keys || Object.keys(o))
      .filter((k) => o[k] === null || typeof o[k] !== 'object' || Array.isArray(o[k]))
      .map((k) => [k, Array.isArray(o[k]) ? 'array(' + o[k].length + ')' : safeVal(k, o[k])]),
  );
  const pages = Array.isArray(vi.pages)
    ? vi.pages.map((p) => Object.fromEntries(
        Object.keys(p)
          .filter((k) => interesting.test(k) || ['page', 'cid', 'part', 'duration'].includes(k))
          .map((k) => [k, safeVal(k, p[k])]),
      ))
    : null;

  return JSON.stringify({
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    hasPlayinfo: typeof window.__playinfo__ !== 'undefined',
    playinfoDescriptor: (() => { const d = Object.getOwnPropertyDescriptor(window, '__playinfo__'); return d ? { get: typeof d.get, set: typeof d.set, configurable: d.configurable } : null; })(),
    topLevelKeys: Object.keys(s),
    videoInfoKeys: Object.keys(vi),
    videoInfoScalars: scalarEntries(vi),
    pagesSummary: pages,
    userInfoScalars: scalarEntries(ui),
    playerKeys: Object.keys(pl),
    playerScalar: scalarEntries(pl, ['quality', 'qn', 'format', 'cid', 'aid', 'bvid', 'type', 'isLogin', 'vip']),
    matchedPaths: out.slice(0, 240),
    totalMatched: out.length,
  }, null, 2);
})()
