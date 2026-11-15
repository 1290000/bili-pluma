// Read-only: enumerate ALL Chrome_WidgetWin* windows (visible or not), so we can
// tell a real 460x420 popup apart from a minimized/placeholder window.
const { execFileSync } = require('node:child_process');

const ps = `
$ErrorActionPreference='Stop'
$code = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W3 {
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
    var c=cn.ToString();
    if(!c.StartsWith("Chrome_WidgetWin")) return true;
    var sb=new StringBuilder(512); GetWindowTextW(h,sb,512);
    uint p; GetWindowThreadProcessId(h,out p);
    RECT rr; GetWindowRect(h,out rr);
    int w=rr.R-rr.L; int hh=rr.B-rr.T;
    o.Add(((long)h).ToString()+"|"+w+"x"+hh+"|"+rr.L+","+rr.T+"|vis="+IsWindowVisible(h)+"|min="+IsIconic(h)+"|pid="+p+"|"+c+"|"+sb.ToString());
    return true;
  }
}
'@
Add-Type -TypeDefinition $code
[W3]::Run() | ForEach-Object { $_ }
`;

const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  encoding: 'utf8',
  timeout: 20000,
});

const rows = out.split(/\r?\n/).filter((l) => l.includes('|'));
console.log('hwnd | size | pos | vis | min | pid | class | title');
for (const r of rows) console.log(r);
console.log('\ntotal = ' + rows.length);
const popups = rows.filter((r) => /460x420/.test(r));
console.log('460x420 windows = ' + popups.length);
for (const p of popups) console.log('  ' + p);
