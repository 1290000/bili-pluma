/**
 * 读 background 收到的消息类型清单（只读桥）。
 *
 * `content.ts` 的 `streaming-probe` 桥会带回 `storage.local` 里的
 * `pluma:probe-types` —— 那是 background 记录"收到过哪些消息类型"的键，
 * 用来判断换集后有没有 `page/activate` 到达 background。
 *
 * ⚠️ 内部 await 完再 stringify（直接 stringify Promise 只会得到 `{}`）。
 */
(async () => {
  const r = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 4000);
    const h = (ev) => {
      const d = ev.data;
      if (!d || d.__ns !== '__PLUMA__' || d.type !== 'streaming-probe-reply') return;
      clearTimeout(timer);
      window.removeEventListener('message', h);
      resolve({ probe: d.probe, trace: d.trace });
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'streaming-probe', probeTypes: ['streaming/status'] }, '*');
  });
  return JSON.stringify(r);
})()