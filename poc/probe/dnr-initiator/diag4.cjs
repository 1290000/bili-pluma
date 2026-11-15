const { chromium } = require("playwright-core");
const path = require("node:path"); const os = require("node:os");
const EXT = path.resolve("poc/probe/dnr-initiator");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const mode = process.argv[2];
const base = {
  headless: false,
  args: ["--no-first-run","--no-default-browser-check",
    "--disable-extensions-except=" + EXT,
    "--load-extension=" + EXT,
    "--disable-features=DisableLoadExtensionCommandLineSwitch"],
};
const opt = mode === "exe"
  ? { ...base, executablePath: CHROME, ignoreDefaultArgs: ["--disable-extensions"] }
  : { ...base, channel: "chrome", ignoreDefaultArgs: ["--disable-extensions"] };
if (mode === "exebare") { delete opt.ignoreDefaultArgs; opt.executablePath = CHROME; }
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(),"p4-"+mode+"-"+Date.now()), opt);
  await new Promise(r=>setTimeout(r,5000));
  console.log(mode, "SWs:", ctx.serviceWorkers().map(s=>s.url()));
  const p = await ctx.newPage();
  await p.goto("chrome://version");
  const t = await p.evaluate(()=>document.body.innerText);
  const cl = t.split("\n").find(l=>/命令行|Command Line/.test(l))||"";
  console.log(mode, "has --disable-extensions:", /--disable-extensions\s/.test(cl));
  await ctx.close();
})();
