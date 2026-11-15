const { chromium } = require("playwright-core");
const path = require("node:path"); const os = require("node:os"); const fs = require("node:fs");
const EXT = path.resolve("poc/probe/dnr-initiator");
const UD = path.join(os.tmpdir(),"p6-"+Date.now());
(async () => {
  const ctx = await chromium.launchPersistentContext(UD, {
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--no-first-run","--no-default-browser-check",
      "--disable-extensions-except="+EXT,"--load-extension="+EXT,
      "--disable-features=DisableLoadExtensionCommandLineSwitch"],
  });
  await new Promise(r=>setTimeout(r,4000));
  const sp = path.join(UD,"Default","Secure Preferences");
  const prefs = path.join(UD,"Default","Preferences");
  for (const f of [prefs, sp]) {
    try { const j = JSON.parse(fs.readFileSync(f,"utf8"));
      console.log(path.basename(f), "extension ids:", Object.keys(j.extensions?.settings||{}));
      console.log("  ui developer_mode:", j.extensions?.ui?.developer_mode);
    } catch(e) { console.log(path.basename(f), "err", e.message); }
  }
  await ctx.close();
})();
