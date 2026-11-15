// Read-only: sample OS window state every 2s during the user's 4-step repro.
// Criteria: (1) any window whose title contains "[InPrivate]"; (2) visible count.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OUT = path.join(__dirname, 'raw', 'repro-windows.jsonl');
const DURATION_MS = Number(process.env.REPRO_MS ?? 900000);
const INTERVAL_MS = 2000;

const ps = `
$ErrorActionPreference='Stop'
$code = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinSample {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L,T,R,B; }
  public class I { public long H=0; public string T=""; public bool V; public bool M; public int W; public int Hh; public uint P; public int L; public int Tp; }
  static List<I> r;
  public static List<I> Run(){ r=new List<I>(); EnumWindows(new EnumProc(Cb), IntPtr.Zero); return r; }
  static bool Cb(IntPtr h, IntPtr l){
    var cn=new StringBuilder(256); GetClassNameW(h,cn,256);
    if(cn.ToString()!="Chrome_WidgetWin_1") return true;
    var sb=new StringBuilder(512); GetWindowTextW(h,sb,512);
    uint p; GetWindowThreadProcessId(h,out p);
    RECT rr; GetWindowRect(h,out rr);
    r.Add(new I{H=(long)h,T=sb.ToString(),V=IsWindowVisible(h),M=IsIconic(h),W=rr.R-rr.L,Hh=rr.B-rr.T,P=p,L=rr.L,Tp=rr.T});
    return true;
  }
}
'@
Add-Type -TypeDefinition $code
$all = [WinSample]::Run()
$vis = @($all | Where-Object { $_.V })
$items = @()
foreach ($x in $vis) {
  $items += [pscustomobject]@{ hwnd=[string]$x.H; title=$x.T; minimized=$x.M; w=$x.W; h=$x.Hh; x=$x.L; y=$x.Tp; pid=$x.P }
}
[pscustomobject]@{ at=(Get-Date).ToString('o'); visibleCount=$vis.Count; windows=$items } | ConvertTo-Json -Depth 5 -Compress
`;

fs.writeFileSync(OUT, '');
const started = Date.now();
let n = 0;
while (Date.now() - started < DURATION_MS) {
  const t = Date.now();
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 8000 },
    ).trim();
    fs.appendFileSync(OUT, out + '\n');
    n += 1;
  } catch (e) {
    fs.appendFileSync(OUT, JSON.stringify({ at: new Date(t).toISOString(), error: String(e.message) }) + '\n');
  }
  const spent = Date.now() - t;
  const wait = Math.max(0, INTERVAL_MS - spent);
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}
console.log('sampling done, n=' + n + ' -> ' + OUT);
