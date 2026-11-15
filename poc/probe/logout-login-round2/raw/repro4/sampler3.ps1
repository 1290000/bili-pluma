# task-18 只读采样器 v3
# 修复 v1 两处缺陷：
#   1) $cb 脚本块作用域看不到外层变量 -> edgePidCount 恒 0（改用 script: 作用域 + CIM）
#   2) 卡片说的"取 msedge pid 最小值当主进程"是错的（pid 会复用乱序）：
#      实测 minPid 从 1528->1056，但 1056 是 14:44:30 新起的 renderer；
#      真主进程是 cmdline 不含 --type= 的那个（2600，13:59:43 启动，全程未变）
# 约束：不点击、不 borrow、不 evaluate、不 reload、不强杀浏览器
# 追加写，绝不覆盖

$ErrorActionPreference = 'Continue'
$Dir    = 'D:\Projects\Pluma\poc\probe\logout-login-round2\raw\repro4'
$WinOut = Join-Path $Dir 'windows-v3.jsonl'
$TabOut = Join-Path $Dir 'tabs-v3.jsonl'
$Heart  = Join-Path $Dir 'heartbeat-v3.txt'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W18d {
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

function Get-Snapshot {
  $script:acc = New-Object System.Collections.ArrayList
  $cb = [W18d+EnumProc]{
    param($h, $p)
    $c = New-Object System.Text.StringBuilder 256
    [void][W18d]::GetClassNameW($h, $c, 256)
    if ($c.ToString() -like 'Chrome_WidgetWin*') {
      $s = New-Object System.Text.StringBuilder 512
      [void][W18d]::GetWindowTextW($h, $s, 512)
      $r = New-Object W18d+RECT
      [void][W18d]::GetWindowRect($h, [ref]$r)
      $wp = 0
      [void][W18d]::GetWindowThreadProcessId($h, [ref]$wp)
      [void]$script:acc.Add([pscustomobject]@{
        hwnd=[int64]$h; w=($r.R-$r.L); h=($r.B-$r.T); x=$r.L; y=$r.T
        visible=[W18d]::IsWindowVisible($h); minimized=[W18d]::IsIconic($h)
        pid=[int64]$wp; title=$s.ToString()
      })
    }
    return $true
  }
  [void][W18d]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:acc
}

function Get-EdgeProcs {
  $all = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)
  $main = @($all | Where-Object { $_.CommandLine -notmatch '--type=' })
  $mainIds = @($main | ForEach-Object { $_.ProcessId })
  [pscustomobject]@{
    count    = $all.Count
    mainPids = $mainIds
    mainStarts = @($main | ForEach-Object { $_.CreationDate.ToString('HH:mm:ss') })
    allPids  = @($all | ForEach-Object { $_.ProcessId } | Sort-Object)
  }
}

$probe = Get-Snapshot
$ep0   = Get-EdgeProcs
if ($probe.Count -lt 3)         { Write-Output "SELFTEST FAIL: windows=$($probe.Count)"; exit 1 }
if ($ep0.mainPids.Count -ne 1)  { Write-Output "SELFTEST FAIL: mainPidCount=$($ep0.mainPids.Count)"; exit 1 }
Write-Output "SELFTEST OK v3: windows=$($probe.Count) mainPid=$($ep0.mainPids[0]) mainStart=$($ep0.mainStarts[0]) edgeCount=$($ep0.count)"

"=== SAMPLER v3 START $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') mainPid=$($ep0.mainPids[0]) ===" |
  Add-Content -Path $Heart -Encoding UTF8

$end = (Get-Date).AddMinutes(5)
$seq = 0
while ((Get-Date) -lt $end) {
  $seq++
  $t0  = Get-Date
  $iso = $t0.ToString('yyyy-MM-ddTHH:mm:ss.fff')

  $ep   = Get-EdgeProcs
  $snap = Get-Snapshot
  [pscustomobject]@{
    seq            = $seq
    at             = $iso
    v              = 3
    edgeMainPid    = if ($ep.mainPids.Count -gt 0) { $ep.mainPids[0] } else { $null }
    edgeMainPidCnt = $ep.mainPids.Count
    edgePidCount   = $ep.count
    edgePids       = $ep.allPids
    winCount       = $snap.Count
    windows        = $snap
  } | ConvertTo-Json -Depth 6 -Compress | Add-Content -Path $WinOut -Encoding UTF8

  $tabRec = [pscustomobject]@{ seq=$seq; at=$iso; v=3; ok=$false; reason=$null; raw=$null }
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

"=== SAMPLER v3 END $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') seq=$seq ===" |
  Add-Content -Path $Heart -Encoding UTF8
Write-Output "DONE seq=$seq"
