# 自检：Add-Type + 窗口枚举 + Edge pid，2 秒内跑完，不写数据文件
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W18c {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, ref uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$script:hits = New-Object System.Collections.ArrayList
$cb = [W18c+EnumProc]{
  param($h, $p)
  $c = New-Object System.Text.StringBuilder 256
  [void][W18c]::GetClassNameW($h, $c, 256)
  $cn = $c.ToString()
  if ($cn -like 'Chrome_WidgetWin*') {
    $s = New-Object System.Text.StringBuilder 512
    [void][W18c]::GetWindowTextW($h, $s, 512)
    $r = New-Object W18c+RECT
    [void][W18c]::GetWindowRect($h, [ref]$r)
    $wp = 0
    [void][W18c]::GetWindowThreadProcessId($h, [ref]$wp)
    [void]$script:hits.Add([pscustomobject]@{
      hwnd = [int64]$h; w = ($r.R - $r.L); hh = ($r.B - $r.T)
      x = $r.L; y = $r.T
      vis = [W18c]::IsWindowVisible($h); min = [W18c]::IsIconic($h)
      pid = [int64]$wp; cls = $cn; title = $s.ToString()
    })
  }
  return $true
}
[void][W18c]::EnumWindows($cb, [IntPtr]::Zero)

Write-Output "CHROME_WIDGETWIN COUNT = $($script:hits.Count)"
$script:hits | Sort-Object -Property vis -Descending | ForEach-Object {
  "{0,-10} {1,5}x{2,-5} pos={3},{4,-5} vis={5,-5} min={6,-5} pid={7,-6} [{8}] {9}" -f `
    $_.hwnd, $_.w, $_.hh, $_.x, $_.y, $_.vis, $_.min, $_.pid, $_.cls, $_.title
}
$p = @(Get-Process msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | Sort-Object)
Write-Output ""
Write-Output "MSEDGE PROC COUNT = $($p.Count)"
Write-Output "MSEDGE MIN PID (main) = $(($p | Measure-Object -Minimum).Minimum)"
Write-Output "MSEDGE PIDS = $($p -join ',')"
