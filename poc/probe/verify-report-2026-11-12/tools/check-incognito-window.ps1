# 无痕 / InPrivate 窗口存在性判据（2026-11-12 verifier）
#
# ## 为什么需要这个脚本
#
# 2026-11-12 我第一次验收时用了这个判据：
#
#     Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
#       Where-Object { $_.CommandLine -match 'incognito' }
#
# 它在 Edge 下**恒为 0** —— 因为 Edge 的无痕窗口**不是独立进程**，
# 而是同一浏览器进程内的另一个 profile / 分区，命令行里不含 incognito 字样。
# 我把「匹配不到」当成了「窗口不存在」，得出「点扫码没出窗口」的**假阴性**结论，
# 还据此开了任务卡。真机复验：窗口其实一直在（截图见 S3-QR-window-exists.png）。
#
# ## 正确判据（本脚本）
#
#   1. EnumWindows + GetWindowText，匹配窗口标题里的 InPrivate
#   2. Get-Process msedge | ? MainWindowTitle 交叉验证
#   3. 需要图片证据时：抓该窗口的截图
#
# 用法：
#   powershell -File tools/check-incognito-window.ps1
#   powershell -File tools/check-incognito-window.ps1 -CaptureShot
#
# 输出：INCOGNITO_COUNT=<n> + 每个匹配窗口的 hwnd/尺寸/标题
#
# ⚠️ 判定纪律：**说"不存在"之前，先确认这个探针能看到"存在"。**
#    （先手动开一个无痕窗口自测一次，确认脚本能数到 1，再用它判 0。）

param(
  [switch]$CaptureShot,
  [string]$ShotPath = "poc/probe/verify-report-2026-11-12/evidence/round2/incognito-window.png"
)

$cs = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class IncogProbe {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
}
"@
Add-Type -TypeDefinition $cs

$hits = New-Object System.Collections.ArrayList
$cb = [IncogProbe+EnumProc] {
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 512
  [IncogProbe]::GetWindowText($h, $sb, 512) | Out-Null
  $title = $sb.ToString()
  if ([IncogProbe]::IsWindowVisible($h) -and $title -match 'InPrivate') {
    $r = New-Object IncogProbe+RECT
    [IncogProbe]::GetWindowRect($h, [ref]$r) | Out-Null
    [void]$hits.Add([pscustomobject]@{
      Hwnd  = $h
      Title = $title
      W     = $r.R - $r.L
      H     = $r.B - $r.T
      L     = $r.L
      T     = $r.T
    })
  }
  return $true
}
[IncogProbe]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

Write-Output "INCOGNITO_COUNT=$($hits.Count)"
foreach ($w in $hits) {
  Write-Output ("  hwnd={0} size={1}x{2} title={3}" -f $w.Hwnd, $w.W, $w.H, $w.Title)
}

$procHits = @(Get-Process msedge -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -match 'InPrivate' })
Write-Output "PROCESS_MAINTITLE_COUNT=$($procHits.Count)"
foreach ($p in $procHits) { Write-Output ("  pid={0} title={1}" -f $p.Id, $p.MainWindowTitle) }

if ($hits.Count -eq 0) {
  Write-Output ""
  Write-Output "NOTE: probe counted 0. Before treating 0 as 'window absent',"
  Write-Output "      open one InPrivate window manually and run this again,"
  Write-Output "      confirm the probe reports 1. (The 2026-11-12 false negative"
  Write-Output "      happened because this self-check was skipped.)"
}

if ($CaptureShot -and $hits.Count -gt 0) {
  Add-Type -AssemblyName System.Drawing
  $w = $hits[0]
  $dir = Split-Path -Parent $ShotPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp = New-Object System.Drawing.Bitmap $w.W, $w.H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($w.L, $w.T, 0, 0, (New-Object System.Drawing.Size $w.W, $w.H))
  $bmp.Save($ShotPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "SHOT=$ShotPath"
}
