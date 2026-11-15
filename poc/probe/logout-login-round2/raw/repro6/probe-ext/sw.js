
      const KEY = 'probe:reads';
      async function record(tag) {
        let v = null;
        try { v = await chrome.extension.isAllowedIncognitoAccess(); } catch (e) { v = 'ERR:' + e.message; }
        const { [KEY]: prev = [] } = await chrome.storage.local.get(KEY);
        prev.push({ at: Date.now(), tag, value: v });
        await chrome.storage.local.set({ [KEY]: prev.slice(-200) });
        return v;
      }
      // 启动时读一次，并每 2 秒读一次，持续 10 分钟
      record('startup');
      let n = 0;
      const timer = setInterval(async () => {
        n += 1;
        await record('tick' + n);
        if (n >= 300) clearInterval(timer);
      }, 2000);
      chrome.runtime.onMessage.addListener(() => { record('onMessage'); return false; });
    