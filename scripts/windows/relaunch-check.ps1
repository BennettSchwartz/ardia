param(
  [string]$Setup,
  [string]$App,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$WindowSeconds = 90,
  [switch]$NoUpdates,
  [switch]$FinishOnboarding,
  [switch]$KeepLingering,
  [int]$FirstSettle = 20,
  [string]$ComingFrom = "Edge",
  [switch]$Sharing,
  [switch]$Maximize,
  [int]$WatchSeconds = 25
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$data = Join-Path $env:LOCALAPPDATA "Ardia"
$started = Get-Date
$failures = @()

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RelaunchInput {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", EntryPoint = "PostMessageW")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
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
  } catch {
    Write-Host "::warning::no screenshot: $_"
  }
}

function Get-ArdiaProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name='Ardia.exe'" -ErrorAction SilentlyContinue)
}

function Get-BrowserProcess {
  foreach ($process in Get-ArdiaProcesses) {
    if ($process.CommandLine -notmatch "--type=") { return Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue }
  }
  return $null
}

function Save-DataFolder([string]$Name) {
  $target = Join-Path $Out "data-$Name"
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  if (-not (Test-Path -LiteralPath $data)) { "no data folder" | Set-Content (Join-Path $target "missing.txt"); return }
  Get-ChildItem -LiteralPath $data -Recurse -Force -File -ErrorAction SilentlyContinue |
    Select-Object @{ n = "Path"; e = { $_.FullName.Substring($data.Length) } }, Length, LastWriteTime |
    Export-Csv -NoTypeInformation -Path (Join-Path $target "files.csv")
  foreach ($file in Get-ChildItem -LiteralPath $data -Recurse -Force -File -ErrorAction SilentlyContinue) {
    $relative = $file.FullName.Substring($data.Length).TrimStart("\")
    $keep = $file.Length -lt 2MB -and ($file.Extension -in @(".json", ".log", ".txt", ".dmp", "") -or $file.Name -in @("Local State", "Preferences", "Secure Preferences", "lockfile", "Last Version", "First Run"))
    if ($relative -match "\\(Cache|Code Cache|GPUCache|GrShaderCache|ShaderCache|DawnGraphiteCache|DawnWebGPUCache)\\") { $keep = $false }
    if (-not $keep) { continue }
    $copy = Join-Path $target $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copy) | Out-Null
    try { Copy-Item -LiteralPath $file.FullName -Destination $copy -Force } catch { Write-Host "::warning::could not copy $relative ($_)" }
  }
}

function Start-Ardia([string]$Name) {
  $before = @(Get-ArdiaProcesses | ForEach-Object { $_.ProcessId })
  $at = Get-Date
  $process = Start-Process -FilePath $App -ArgumentList "--log-file=`"$(Join-Path $Out "$Name.log")`"" -PassThru
  $deadline = $at.AddSeconds($WindowSeconds)
  $window = $null
  while ((Get-Date) -lt $deadline) {
    $browser = Get-BrowserProcess
    if ($browser) {
      $browser.Refresh()
      if ($browser.MainWindowHandle -ne [IntPtr]::Zero -and [RelaunchInput]::IsWindowVisible($browser.MainWindowHandle)) { $window = $browser; break }
    }
    if ($process.HasExited -and -not (Get-BrowserProcess)) { break }
    Start-Sleep -Milliseconds 250
  }
  $ms = [int]((Get-Date) - $at).TotalMilliseconds
  $process.Refresh()
  $launcherExit = if ($process.HasExited) { $process.ExitCode } else { "running" }
  if (-not $window) {
    Save-Screenshot (Join-Path $Out "$Name-no-window.png")
    $left = Get-ArdiaProcesses | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }
    Write-Host "Relaunch ($Name): no window within $ms ms; the started process (pid $($process.Id), alive before: $($before.Count)) ended with $launcherExit; Ardia processes now: $($left.Count)"
    $left | ForEach-Object { Write-Host "  $_" }
    return $null
  }
  $shownAt = Get-Date
  $watchUntil = $shownAt.AddSeconds($WatchSeconds)
  $shots = 0
  $peakMb = 0
  while ((Get-Date) -lt $watchUntil -and -not $window.HasExited) {
    Start-Sleep -Milliseconds 250
    try { $window.Refresh(); $peakMb = [Math]::Max($peakMb, [int]($window.PrivateMemorySize64 / 1MB)) } catch { }
    if ($shots -lt 8 -and ((Get-Date) - $shownAt).TotalSeconds -ge $shots) { Save-Screenshot (Join-Path $Out "$Name-at-$($shots)s.png"); $shots++ }
  }
  if ($window.HasExited) {
    $died = [int]((Get-Date) - $shownAt).TotalMilliseconds
    Save-Screenshot (Join-Path $Out "$Name-gone.png")
    $left = @(Get-ArdiaProcesses)
    Write-Host "Relaunch ($Name): a window showed after $ms ms, then the browser process (pid $($window.Id)) ended with exit code $($window.ExitCode) (0x$('{0:X8}' -f $window.ExitCode)) about $died ms after the window showed (peak $peakMb MB private); $($left.Count) Ardia processes left"
    return $null
  }
  Save-Screenshot (Join-Path $Out "$Name-window.png")
  Write-Host "Relaunch ($Name): a window after $ms ms (browser pid $($window.Id), $(@(Get-ArdiaProcesses).Count) Ardia processes), still up $WatchSeconds s later; the browser process peaked at $peakMb MB private"
  return $window
}

function Send-Click([int]$X, [int]$Y) {
  [RelaunchInput]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 150
  [RelaunchInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [RelaunchInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}

function Click-Named([IntPtr]$Handle, [string[]]$Names) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
  foreach ($name in $Names) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
    $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if (-not $found -or $found.Current.IsOffscreen) { continue }
    $bounds = $found.Current.BoundingRectangle
    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
    Send-Click ([int]($bounds.X + $bounds.Width / 2)) ([int]($bounds.Y + $bounds.Height / 2))
    return $name
  }
  return $null
}

function Click-NameLike([IntPtr]$Handle, [string]$Pattern) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
  foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    $name = $element.Current.Name
    if (-not $name -or $name -notlike $Pattern -or $element.Current.IsOffscreen) { continue }
    $bounds = $element.Current.BoundingRectangle
    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
    Send-Click ([int]($bounds.X + $bounds.Width / 2)) ([int]($bounds.Y + $bounds.Height / 2))
    return $name
  }
  return $null
}

function Use-Ardia([System.Diagnostics.Process]$Browser, [string]$Name, [bool]$Onboarding) {
  Add-Type -AssemblyName System.Windows.Forms
  $Browser.Refresh()
  $handle = $Browser.MainWindowHandle
  [RelaunchInput]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 500
  if ($Onboarding -and $FinishOnboarding) {
    $clicked = @()
    $picked = Click-Named $handle @($ComingFrom)
    if ($picked) { $clicked += $picked; Start-Sleep -Seconds 1 }
    $shared = $false
    foreach ($page in 1..14) {
      $settings = @(Get-Process SystemSettings -ErrorAction SilentlyContinue)
      if ($settings.Count) { $settings | Stop-Process -Force; $clicked += "closed Windows Settings"; Start-Sleep -Seconds 1 }
      [RelaunchInput]::SetForegroundWindow($handle) | Out-Null
      Start-Sleep -Milliseconds 400
      Save-Screenshot (Join-Path $Out "$Name-onboarding-$page.png")
      if ($Sharing -and -not $shared) {
        $card = Click-NameLike $handle "*Share anonymous crash reports*"
        if ($card) { $shared = $true; $clicked += "sharing card"; Start-Sleep -Seconds 1; Save-Screenshot (Join-Path $Out "$Name-onboarding-$page-shared.png") }
      }
      $next = Click-Named $handle @("Continue", "Get Started", "Get Started →", "Next", "Done", "Finish", "Import", "Skip")
      if (-not $next) { break }
      $clicked += $next
      Start-Sleep -Seconds 3
    }
    Write-Host "Relaunch ($Name): onboarding clicks: $($clicked -join ', ')"
    $state = Get-Content -Raw -LiteralPath (Join-Path $data "onboarding.json") -ErrorAction SilentlyContinue
    Write-Host "Relaunch ($Name): onboarding.json: $state"
    if ($state -notmatch '"completedAt":\d') { Write-Host "::warning::relaunch: onboarding did not finish" }
    if ($Sharing -and -not $shared) { Write-Host "::warning::relaunch: the sharing card was never found in onboarding" }
  } elseif ($Onboarding) {
    $rect = New-Object RelaunchInput+Rect
    [RelaunchInput]::GetWindowRect($handle, [ref]$rect) | Out-Null
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    Send-Click ($rect.Left + [int]($width * 222 / 1008)) ($rect.Top + [int]($height * 594 / 712))
    Start-Sleep -Seconds 3
    Save-Screenshot (Join-Path $Out "$Name-after-skip.png")
  }
  foreach ($address in @("https://example.com/", "https://www.wikipedia.org/")) {
    [System.Windows.Forms.SendKeys]::SendWait("^t")
    Start-Sleep -Seconds 2
    [System.Windows.Forms.SendKeys]::SendWait("$address{ENTER}")
    Start-Sleep -Seconds 6
  }
  [System.Windows.Forms.SendKeys]::SendWait("^t")
  Start-Sleep -Seconds 2
  [System.Windows.Forms.SendKeys]::SendWait("nyse{ENTER}")
  Start-Sleep -Seconds 6
  if ($Maximize) { [RelaunchInput]::PostMessage($handle, 0x0112, [IntPtr]0xF030, [IntPtr]::Zero) | Out-Null; Start-Sleep -Seconds 2 }
  Save-Screenshot (Join-Path $Out "$Name-page.png")
  Write-Host "Relaunch ($Name): opened two pages and a search with Ctrl+T$(if ($Maximize) { ', maximized the window' })"
}

function Close-Ardia([System.Diagnostics.Process]$Browser, [string]$Name, [string]$How) {
  $Browser.Refresh()
  $handle = $Browser.MainWindowHandle
  [RelaunchInput]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 500
  if ($How -eq "alt-f4") {
    [RelaunchInput]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [RelaunchInput]::keybd_event(0x73, 0, 0, [UIntPtr]::Zero)
    [RelaunchInput]::keybd_event(0x73, 0, 2, [UIntPtr]::Zero)
    [RelaunchInput]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  } else {
    [RelaunchInput]::PostMessage($handle, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero) | Out-Null
  }
  $at = Get-Date
  $deadline = $at.AddSeconds(60)
  while ((Get-Date) -lt $deadline -and @(Get-ArdiaProcesses).Count -gt 0) { Start-Sleep -Milliseconds 250 }
  $ms = [int]((Get-Date) - $at).TotalMilliseconds
  $left = @(Get-ArdiaProcesses)
  $exit = if ($Browser.HasExited) { $Browser.ExitCode } else { "running" }
  Write-Host "Relaunch ($Name): closed with $How; the browser process ended with $exit; every Ardia process was gone after $ms ms ($($left.Count) left)"
  $left | ForEach-Object { Write-Host "  left: $($_.ProcessId) $($_.CommandLine)" }
  Save-Screenshot (Join-Path $Out "$Name-closed.png")
  return $left.Count -eq 0
}

if ($Setup) {
  $run = Start-Process -FilePath (Resolve-Path -LiteralPath $Setup).Path -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
  if ($run.ExitCode -ne 0) { throw "the installer exited with $($run.ExitCode)" }
  $App = Join-Path $env:LOCALAPPDATA "Programs\Ardia\Ardia.exe"
}
if (-not $App -or -not (Test-Path -LiteralPath $App -PathType Leaf)) { throw "no app to start: give -Setup or -App" }
if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $App) "Ardia.test-build")) { throw "the app carries an Ardia.test-build marker; this check starts the app as a person does" }
Get-Content -LiteralPath (Join-Path (Split-Path -Parent $App) "Ardia.build.json") -ErrorAction SilentlyContinue | Write-Host
if ($NoUpdates) {
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  '{"automaticChecks":false,"automaticDownloads":false,"lastCheck":null}' | Set-Content -NoNewline -Encoding utf8NoBOM -Path (Join-Path $data "windows-updates.json")
  Write-Host "Relaunch: automatic update checks are off, as they had nothing to offer before nightly.4 was published"
}
Save-DataFolder "0-before"

$steps = @(
  @{ Name = "1-first"; Wait = 0; Close = "alt-f4"; Settle = $FirstSettle },
  @{ Name = "2-at-once"; Wait = 0; Close = "taskbar-close"; Settle = 10 },
  @{ Name = "3-after-5s"; Wait = 5; Close = "alt-f4"; Settle = 10 },
  @{ Name = "4-after-60s"; Wait = 60; Close = "alt-f4"; Settle = 10 }
)
foreach ($step in $steps) {
  if ($step.Wait) { Start-Sleep -Seconds $step.Wait }
  $browser = Start-Ardia $step.Name
  if (-not $browser) {
    $failures += "start $($step.Name): no lasting window"
    Save-DataFolder "$($step.Name)-failed"
    foreach ($leftover in Get-ArdiaProcesses) { Stop-Process -Id $leftover.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
    continue
  }
  Use-Ardia $browser $step.Name ($step.Name -eq "1-first")
  Start-Sleep -Seconds $step.Settle
  if (-not (Close-Ardia $browser $step.Name $step.Close)) {
    $failures += "close $($step.Name): Ardia processes were still running 60 s after the last window closed"
    if ($KeepLingering) {
      $again = Start-Ardia "$($step.Name)-while-lingering"
      if (-not $again) { $failures += "start while $($step.Name)'s process lingered: no lasting window" }
      Save-DataFolder "$($step.Name)-while-lingering"
    }
    foreach ($leftover in Get-ArdiaProcesses) { Stop-Process -Id $leftover.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
  }
  Save-DataFolder "$($step.Name)-closed"
  python (Join-Path $PSScriptRoot "probe\count-history.py") (Join-Path $data "User Data\Default\History") | Write-Host
}

try {
  Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $started } -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -match "Ardia" } |
    ForEach-Object { "[$($_.TimeCreated.ToString('o'))] $($_.ProviderName) $($_.Id)`n$($_.Message)`n" } |
    Set-Content -Path (Join-Path $Out "application-events.txt")
} catch { Write-Host "::warning::no event log: $_" }
foreach ($folder in @($data, (Join-Path $env:LOCALAPPDATA "CrashDumps"))) {
  Get-ChildItem -LiteralPath $folder -Recurse -Force -File -Filter "*.dmp" -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Out $_.Name) -Force
    Write-Host "Relaunch: crash dump $($_.FullName) ($($_.Length) bytes, $($_.LastWriteTime.ToString('o')))"
  }
}
if (Test-Path (Join-Path $Out "application-events.txt")) { Get-Content (Join-Path $Out "application-events.txt") | Select-Object -First 60 | Write-Host }

foreach ($failure in $failures) { Write-Host "::error::relaunch: $failure" }
if ($failures.Count) { exit 1 }
Write-Host "Relaunch: every start after a close as a person makes it showed a lasting window"
