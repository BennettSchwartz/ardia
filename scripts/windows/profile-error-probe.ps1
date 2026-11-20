param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out,
  [string[]]$Cases = @("control", "preferences-locked", "preferences-folder", "local-state-locked", "local-state-folder")
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ProbeWindows {
  delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll", EntryPoint = "PostMessageW")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static List<string> Of(int pid) {
    var lines = new List<string>();
    EnumWindows((window, data) => {
      uint owner;
      uint thread = GetWindowThreadProcessId(window, out owner);
      if (owner != (uint)pid) return true;
      var title = new StringBuilder(256);
      var name = new StringBuilder(256);
      GetWindowText(window, title, 256);
      GetClassName(window, name, 256);
      lines.Add(String.Format("{0} thread={1} visible={2} class={3} title=\"{4}\"", window, thread, IsWindowVisible(window), name, title));
      return true;
    }, IntPtr.Zero);
    return lines;
  }
}
"@

function Save-Screenshot([string]$Path) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
  } catch { Write-Host "no screenshot: $_" }
}

function Save-Stacks([int]$ProcessId, [string]$Path) {
  $cdb = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64\cdb.exe",
    "$env:ProgramFiles\Windows Kits\10\Debuggers\x64\cdb.exe"
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $cdb) { "no cdb on this runner" | Set-Content -LiteralPath $Path; return }
  & $cdb -pv -p $ProcessId -c ".symfix; .reload; ~*kn 40; qd" 2>&1 | Set-Content -LiteralPath $Path
}

$summary = @()
foreach ($case in $Cases) {
  $data = Join-Path $Out "$case-data"
  $log = Join-Path $Out "$case.log"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $data, $log
  $chromium = Join-Path $data "Chromium"
  $profile = Join-Path $chromium "Default"
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  Set-Content -Path (Join-Path $data "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
  $held = $null
  switch ($case) {
    "preferences-locked" {
      Set-Content -Path (Join-Path $profile "Preferences") -Value "{}" -Encoding utf8NoBOM
      $held = [System.IO.File]::Open((Join-Path $profile "Preferences"), [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    }
    "preferences-folder" { New-Item -ItemType Directory -Force -Path (Join-Path $profile "Preferences") | Out-Null }
    "local-state-locked" {
      Set-Content -Path (Join-Path $chromium "Local State") -Value "{}" -Encoding utf8NoBOM
      $held = [System.IO.File]::Open((Join-Path $chromium "Local State"), [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    }
    "local-state-folder" { New-Item -ItemType Directory -Force -Path (Join-Path $chromium "Local State") | Out-Null }
  }
  $env:ARDIA_DATA_DIR = $data
  $env:ARDIA_BACKGROUND = ""
  $started = Get-Date
  $run = Start-Process -FilePath $App -ArgumentList "--log-file=`"$log`"" -PassThru
  $windowSeen = $false
  $by = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $by -and -not $run.HasExited) {
    $run.Refresh()
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern "\[ardia windows\] first window" -Quiet)) { $windowSeen = $true; break }
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Seconds 3
  $before = [ProbeWindows]::Of($run.Id)
  $before | Set-Content -LiteralPath (Join-Path $Out "$case-windows-before-quit.txt")
  Save-Screenshot (Join-Path $Out "$case-before-quit.png")
  $dialogBefore = @($before | Where-Object { $_ -match 'visible=True class=#32770' })
  $run.Refresh()
  $main = $run.MainWindowHandle
  $appWindow = $before | Where-Object { $_ -match 'visible=True' -and $_ -notmatch 'class=#32770' } | Select-Object -First 1
  $closeTarget = if ($appWindow) { [IntPtr]([long]($appWindow -split ' ')[0]) } else { $main }
  $quitAsked = Get-Date
  if (-not $run.HasExited -and $closeTarget -ne [IntPtr]::Zero) { [ProbeWindows]::PostMessage($closeTarget, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
  $ended = $run.HasExited -or $run.WaitForExit(30000)
  $outcome = ""
  if ($ended) {
    $outcome = "ended $([int]((Get-Date) - $quitAsked).TotalMilliseconds) ms after WM_CLOSE, exit $($run.ExitCode)"
  } else {
    $after = [ProbeWindows]::Of($run.Id)
    $after | Set-Content -LiteralPath (Join-Path $Out "$case-windows-stuck.txt")
    Save-Screenshot (Join-Path $Out "$case-stuck.png")
    Save-Stacks $run.Id (Join-Path $Out "$case-stacks.txt")
    $outcome = "STILL RUNNING 30 s after WM_CLOSE; windows: $(@($after | Where-Object { $_ -match 'visible=True' }) -join ' | ')"
    Get-Process -Id $run.Id -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq (Resolve-Path $App).Path } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  if ($held) { $held.Dispose() }
  $line = "${case}: first window $windowSeen; dialog before quit: $(if ($dialogBefore) { $dialogBefore -join ' | ' } else { 'none' }); $outcome"
  Write-Host $line
  $summary += $line
  if (Test-Path $log) { Write-Host "--- $case log tail"; Get-Content $log -Tail 15 | ForEach-Object { Write-Host "  $_" } }
}
$summary | Set-Content -LiteralPath (Join-Path $Out "summary.txt")
