# task-18 只读采样器：每秒 OS 窗口枚举 + bsk tab list
# 约束：不点击、不 borrow、不 evaluate、不 reload、不强杀浏览器
# 追加写；不用 cmd timeout（用 Start-Sleep）

$ErrorActionPreference = 'Continue'
$Dir = 'D:\Projects\Pluma\poc\probe\logout-login-round2\raw\repro4'
$WinOut = Join-Path $Dir 'windows.jsonl'
$TabOut = Join-Path $Dir 'tabs.jsonl'
$Heart  = Join-Path $Dir 'heartbeat.txt'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W18 {
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
  $list = New-Object System.Collections.ArrayList
  $cb = [W18+EnumProc]{
    param($h, $p)
    $cls = New-Object System.Text.StringBuilder 256
    [void][W18]::GetClassNameW($h, $cls, 256)
    $cn = $cls.ToString()
    if ($cn -like 'Chrome_WidgetWin*') {
      $sb = New-Object System.Text.StringBuilder 512
      [void][W18]::GetWindowTextW($h, $sb, 512)
      $rect = New-Object W18+RECT
      [void][W18]::GetWindowRect($h, [ref]$rect)
      $wndPid = 0
      [void][W18]::GetWindowThreadProcessId($h, [ref]$wndPid)
      [void]$list.Add([pscustomobject]@{
        hwnd      = [int64]$h
        w         = $rect.R - $rect.L
        h         = $rect.B - $rect.T
        x         = $rect.L
        y         = $rect.T
        visible   = [W18]::IsWindowVisible($h)
        minimized = [W18]::IsIconic($h)
        pid       = [int64]$wndPid
        cls       = $cn
        title     = $sb.ToString()
      })
    }
    return $true
  }
  [void][W18]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

# ---- 自检 ----
$probe = Get-Snapshot
if ($probe.Count -lt 3) {
  Write-Output "SELFTEST FAIL: only $($probe.Count) Chrome_WidgetWin* windows (need >=3)"
  exit 1
}
$edgePids = (Get-Process msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | Sort-Object)
if (-not $edgePids -or $edgePids.Count -eq 0) {
  Write-Output "SELFTEST FAIL: no msedge process"
  exit 1
}
$mainPid = ($edgePids | Measure-Object -Minimum).Minimum
Write-Output "SELFTEST OK: windows=$($probe.Count) msedgePidCount=$($edgePids.Count) mainPid(min)=$mainPid"

"=== SAMPLER START $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') mainPid=$mainPid ===" |
  Add-Content -Path $Heart -Encoding UTF8

# ---- 循环 5 分钟，约每 1 秒 ----
$end = (Get-Date).AddMinutes(5)
$seq = 0
while ((Get-Date) -lt $end) {
  $seq++
  $t0 = Get-Date
  $iso = $t0.ToString('yyyy-MM-ddTHH:mm:ss.fff')

  # Edge 进程集（每秒）
  $pids = @(Get-Process msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | Sort-Object)
  $mainPid = if ($pids.Count -gt 0) { ($pids | Measure-Object -Minimum).Minimum } else { $null }

  # 窗口
  $snap = Get-Snapshot
  $rec = [pscustomobject]@{
    seq           = $seq
    at            = $iso
    edgeMainPid   = $mainPid
    edgePidCount  = $pids.Count
    edgePids      = $pids
    winCount      = $snap.Count
    windows       = $snap
  }
  ($rec | ConvertTo-Json -Depth 6 -Compress) | Add-Content -Path $WinOut -Encoding UTF8

  # bsk tab list（只读；失败也记一行）
  $tabLine = [pscustomobject]@{ seq = $seq; at = $iso; ok = $false; raw = $null; err = $null }
  try {
    $env:BSK_AUTO_START = '0'
    $out = & bsk tab list --session mzyu --json 2>&1 | Out-String
    if ($out -match '"tabs"') { $tabLine.ok = $true }
    $tabLine.raw = $out.Trim()
  } catch {
    $tabLine.err = $_.Exception.Message
  }
  ($tabLine | ConvertTo-Json -Depth 4 -Compress) | Add-Content -Path $TabOut -Encoding UTF8

  $elapsedMs = [int]((Get-Date) - $t0).TotalMilliseconds
  $sleep = 1000 - $elapsedMs
  if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
}

"=== SAMPLER END $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') seq=$seq ===" |
  Add-Content -Path $Heart -Encoding UTF8
Write-Output "DONE seq=$seq"
