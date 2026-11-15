const { chromium } = require("playwright-core");
const path = require("node:path"); const os = require("node:os");
const EXT = path.resolve("poc/probe/dnr-initiator");
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(),"p3-"+Date.now()), {
    channel:"chrome", headless:false,
    ignoreDefaultArgs:["--disable-extensions"],
    args:["--disable-extensions-except="+EXT,"--load-extension="+EXT,"--disable-features=DisableLoadExtensionCommandLineSwitch","--no-first-run"],
  });
  await new Promise(r=>setTimeout(r,5000));
  console.log("SWs:", ctx.serviceWorkers().map(s=>s.url()));
  const p = await ctx.newPage();
  await p.goto("chrome://version");
  const t = await p.evaluate(()=>document.body.innerText);
  const cl = t.split("\n").find(l=>/命令行|Command Line/.test(l))||"";
  console.log("cmdline has disable-extensions? ", /--disable-extensions\b/.test(cl));
  console.log("cmdline:", cl.slice(0,1500));
  await ctx.close();
})();
