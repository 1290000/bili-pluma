# task-18 只读采样器 v2
# 修复：v1 的 $cb 脚本块作用域看不到 $p，导致 edgePidCount 恒 0
# 约束：不点击、不 borrow、不 evaluate、不 reload、不强杀浏览器
# 追加写，绝不覆盖

$ErrorActionPreference = 'Continue'
$Dir    = 'D:\Projects\Pluma\poc\probe\logout-login-round2\raw\repro4'
$WinOut = Join-Path $Dir 'windows.jsonl'
$TabOut = Join-Path $Dir 'tabs.jsonl'
$Heart  = Join-Path $Dir 'heartbeat.txt'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W18b {
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

# 窗口枚举：不依赖脚本块作用域变量，返回 ArrayList
function Get-Snapshot {
  $script:acc = New-Object System.Collections.ArrayList
  $cb = [W18b+EnumProc]{
    param($h, $p)
    $c = New-Object System.Text.StringBuilder 256
    [void][W18b]::GetClassNameW($h, $c, 256)
    if ($c.ToString() -like 'Chrome_WidgetWin*') {
      $s = New-Object System.Text.StringBuilder 512
      [void][W18b]::GetWindowTextW($h, $s, 512)
      $r = New-Object W18b+RECT
      [void][W18b]::GetWindowRect($h, [ref]$r)
      $wp = 0
      [void][W18b]::GetWindowThreadProcessId($h, [ref]$wp)
      [void]$script:acc.Add([pscustomobject]@{
        hwnd      = [int64]$h
        w         = ($r.R - $r.L)
        h         = ($r.B - $r.T)
        x         = $r.L
        y         = $r.T
        visible   = [W18b]::IsWindowVisible($h)
        minimized = [W18b]::IsIconic($h)
        pid       = [int64]$wp
        title     = $s.ToString()
      })
    }
    return $true
  }
  [void][W18b]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:acc
}

# ---- 自检 ----
$probe = Get-Snapshot
$cim0 = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)
if ($probe.Count -lt 3) { Write-Output "SELFTEST FAIL: windows=$($probe.Count)"; exit 1 }
if ($cim0.Count -eq 0)  { Write-Output "SELFTEST FAIL: no msedge via CIM"; exit 1 }
$main0 = ($cim0 | Select-Object -ExpandProperty ProcessId | Measure-Object -Minimum).Minimum
Write-Output "SELFTEST OK v2: windows=$($probe.Count) msedgeCount=$($cim0.Count) mainPid=$main0"

"=== SAMPLER v2 START $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') mainPid=$main0 (append) ===" |
  Add-Content -Path $Heart -Encoding UTF8

$end = (Get-Date).AddMinutes(5)
$seq = 0
while ((Get-Date) -lt $end) {
  $seq++
  $t0  = Get-Date
  $iso = $t0.ToString('yyyy-MM-ddTHH:mm:ss.fff')

  # Edge 进程：用 CIM，写进本次记录（不再依赖脚本块作用域）
  $cim = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)
  $pids = @($cim | Select-Object -ExpandProperty ProcessId | Sort-Object)
  $mainPid = if ($pids.Count -gt 0) { ($pids | Measure-Object -Minimum).Minimum } else { $null }

  $snap = Get-Snapshot
  [pscustomobject]@{
    seq          = $seq
    at           = $iso
    v            = 2
    edgeMainPid  = $mainPid
    edgePidCount = $pids.Count
    edgePids     = $pids
    winCount     = $snap.Count
    windows      = $snap
  } | ConvertTo-Json -Depth 6 -Compress | Add-Content -Path $WinOut -Encoding UTF8

  # bsk tab list：session 失效也照记，不伪造
  $tabRec = [pscustomobject]@{ seq = $seq; at = $iso; v = 2; ok = $false; reason = $null; raw = $null }
  try {
    $env:BSK_AUTO_START = '0'
    $out = (& bsk tab list --session mzyu --json 2>&1 | Out-String).Trim()
    if ($out -match '"tabs"') { $tabRec.ok = $true; $tabRec.raw = $out }
    else { $tabRec.reason = 'no session'; $tabRec.raw = $out }
  } catch {
    $tabRec.reason = 'exception'; $tabRec.raw = $_.Exception.Message
  }
  $tabRec | ConvertTo-Json -Depth 4 -Compress | Add-Content -Path $TabOut -Encoding UTF8

  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  if ((1000 - $ms) -gt 0) { Start-Sleep -Milliseconds (1000 - $ms) }
}

"=== SAMPLER v2 END $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') seq=$seq ===" |
  Add-Content -Path $Heart -Encoding UTF8
Write-Output "DONE seq=$seq"
