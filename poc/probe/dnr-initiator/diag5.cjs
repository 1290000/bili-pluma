const { chromium } = require("playwright-core");
const path = require("node:path"); const os = require("node:os");
const EXT = path.resolve("poc/probe/dnr-initiator");
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(),"p5-"+Date.now()), {
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--no-first-run","--no-default-browser-check",
      "--disable-extensions-except="+EXT,"--load-extension="+EXT,
      "--disable-features=DisableLoadExtensionCommandLineSwitch"],
  });
  await new Promise(r=>setTimeout(r,3000));
  const p = await ctx.newPage();
  await p.goto("chrome://extensions");
  await p.waitForTimeout(2000);
  const info = await p.evaluate(() => {
    const mgr = document.querySelector("extensions-manager");
    const list = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector("extensions-item-list");
    if (!list || !list.shadowRoot) return { err: "no list shadowRoot", mgrHtml: mgr ? mgr.shadowRoot.innerHTML.slice(0,500) : null };
    const items = [...list.shadowRoot.querySelectorAll("extensions-item")];
    return { count: items.length, items: items.map(i => ({
      id: i.id,
      name: i.shadowRoot?.querySelector("#name")?.textContent?.trim(),
      err: i.shadowRoot?.querySelector("#errors-button")?.textContent?.trim() ?? null,
    })) };
  });
  console.log(JSON.stringify(info, null, 1));
  await ctx.close();
})();
