const { chromium } = require("playwright-core");
const path = require("node:path"); const os = require("node:os");
const EXT = path.resolve("poc/probe/dnr-initiator");
const EDGE156 = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\156.0.4314.50\\msedge.exe";
const EDGE157 = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const exe = process.argv[2] === "156" ? EDGE156 : EDGE157;
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(),"p7-"+process.argv[2]+"-"+Date.now()), {
    executablePath: exe, headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--no-first-run","--no-default-browser-check",
      "--disable-extensions-except="+EXT,"--load-extension="+EXT,
      "--disable-features=DisableLoadExtensionCommandLineSwitch"],
  });
  await new Promise(r=>setTimeout(r,5000));
  console.log(process.argv[2], "SWs:", ctx.serviceWorkers().map(s=>s.url()));
  await ctx.close();
})();
