// Read-only: enumerate top-level Chrome windows + their child tab URLs is not
// possible from OS level; instead print hwnd/rect/title so we can map
// chrome window ids to HWNDs by size + order.
const { execFileSync } = require('node:child_process');

const ps = `
$ErrorActionPreference='Stop'
$code = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L,T,R,B; }
  static List<string> o;
  public static List<string> Run(){ o=new List<string>(); EnumWindows(new EnumProc(Cb), IntPtr.Zero); return o; }
  static bool Cb(IntPtr h, IntPtr l){
    var cn=new StringBuilder(256); GetClassNameW(h,cn,256);
    if(cn.ToString()!="Chrome_WidgetWin_1") return true;
    var sb=new StringBuilder(512); GetWindowTextW(h,sb,512);
    uint p; GetWindowThreadProcessId(h,out p);
    RECT rr; GetWindowRect(h,out rr);
    o.Add(((long)h).ToString()+"\\t"+rr.R.ToString()+"x"+rr.B.ToString()+"\\t"+(IsIconic(h)?"MIN":"VIS")+"\\t"+p.ToString()+"\\t"+sb.ToString());
    return true;
  }
}
'@
Add-Type -TypeDefinition $code
[W2]::Run() | ForEach-Object { $_ }
`;

const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  encoding: 'utf8',
  timeout: 15000,
});

console.log('hwnd\trawrect\tstate\tpid\ttitle');
for (const line of out.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [hwnd, raw, state, pid, ...rest] = line.split('\t');
  const title = rest.join('\t');
  // raw is like "287,105,747,705" -> convert to WxH
  const m = /^(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/.exec(raw);
  let size = raw;
  if (m) size = Number(m[3] - m[1]) + 'x' + Number(m[4] - m[2]);
  console.log(hwnd + '\t' + size + '\t' + state + '\t' + pid + '\t' + title);
}
