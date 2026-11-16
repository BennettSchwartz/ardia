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
  [int]$WatchSeconds = 25,
  [switch]$Import,
  [string]$SeedEngine,
  [switch]$TesterShape,
  [ValidateSet("", "kill-main", "kill-tree", "early", "endsession")][string]$Unclean = ""
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
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
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

$script:tracked = [ordered]@{}

function Track-Ardia {
  foreach ($process in Get-ArdiaProcesses) {
    if ($script:tracked.Contains([string]$process.ProcessId)) { continue }
    $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    if (-not $live) { continue }
    try { $null = $live.Handle } catch { }
    $kind = if ($process.CommandLine -match "--type=([a-z-]+)") { $Matches[1] } else { "browser" }
    $script:tracked[[string]$process.ProcessId] = [pscustomobject]@{ Process = $live; Kind = $kind; Seen = Get-Date; Reported = $false }
  }
}

function Report-Exits([string]$Name) {
  Track-Ardia
  foreach ($entry in $script:tracked.Values) {
    if ($entry.Reported -or -not $entry.Process.HasExited) { continue }
    $entry.Reported = $true
    $code = try { $entry.Process.ExitCode } catch { "unknown" }
    $hex = if ($code -is [int]) { "0x{0:X8}" -f $code } else { "" }
    $lived = try { [int]($entry.Process.ExitTime - $entry.Process.StartTime).TotalMilliseconds } catch { "?" }
    Write-Host "Relaunch ($Name): exit: $($entry.Kind) pid $($entry.Process.Id) ended with $code $hex after $lived ms"
  }
}

function Get-BrowserProcess {
  Track-Ardia
  foreach ($process in Get-ArdiaProcesses) {
    if ($process.CommandLine -notmatch "--type=") { $entry = $script:tracked[[string]$process.ProcessId]; if ($entry) { return $entry.Process } }
  }
  return $null
}

function Stop-Unclean([System.Diagnostics.Process]$Browser, [string]$Name, [string]$How) {
  Track-Ardia
  if ($How -eq "kill-main") {
    Stop-Process -Id $Browser.Id -Force -ErrorAction SilentlyContinue
  } elseif ($How -eq "endsession") {
    $handles = @([IntPtr]$Browser.MainWindowHandle) + @(Get-OtherWindows $Browser.MainWindowHandle | ForEach-Object { [IntPtr]$_.Current.NativeWindowHandle })
    foreach ($handle in $handles) {
      $answer = [IntPtr]::Zero
      $sent = [RelaunchInput]::SendMessageTimeout($handle, 0x0011, [IntPtr]::Zero, [IntPtr]::Zero, 2, 5000, [ref]$answer)
      Write-Host "Relaunch ($Name): WM_QUERYENDSESSION to $handle answered $answer (sent: $sent)"
    }
    foreach ($handle in $handles) {
      $answer = [IntPtr]::Zero
      $sent = [RelaunchInput]::SendMessageTimeout($handle, 0x0016, [IntPtr]1, [IntPtr]::Zero, 2, 5000, [ref]$answer)
      Write-Host "Relaunch ($Name): WM_ENDSESSION to $handle sent: $sent"
    }
    Start-Sleep -Seconds 5
    foreach ($leftover in Get-ArdiaProcesses) { Stop-Process -Id $leftover.ProcessId -Force -ErrorAction SilentlyContinue }
  } else {
    foreach ($leftover in Get-ArdiaProcesses) { Stop-Process -Id $leftover.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and @(Get-ArdiaProcesses).Count -gt 0) { Start-Sleep -Milliseconds 250 }
  $left = @(Get-ArdiaProcesses)
  Write-Host "Relaunch ($Name): ended uncleanly with $How; $($left.Count) Ardia processes left"
  foreach ($leftover in $left) { Stop-Process -Id $leftover.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Report-Exits $Name
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

function Start-Ardia([string]$Name, [int]$KillAfterMs = 0) {
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
  if ($KillAfterMs -gt 0) {
    Start-Sleep -Milliseconds $KillAfterMs
    Save-Screenshot (Join-Path $Out "$Name-before-kill.png")
    Stop-Unclean $window $Name "kill-tree"
    return $null
  }
  $watchUntil = $shownAt.AddSeconds($WatchSeconds)
  $shots = 0
  $peakMb = 0
  while ((Get-Date) -lt $watchUntil -and -not $window.HasExited) {
    Start-Sleep -Milliseconds 250
    try { $window.Refresh(); $peakMb = [Math]::Max($peakMb, [int]($window.PrivateMemorySize64 / 1MB)) } catch { }
    Track-Ardia
    if ($shots -lt 8 -and ((Get-Date) - $shownAt).TotalSeconds -ge $shots) { Save-Screenshot (Join-Path $Out "$Name-at-$($shots)s.png"); $shots++ }
  }
  if ($window.HasExited) {
    $died = [int]((Get-Date) - $shownAt).TotalMilliseconds
    Save-Screenshot (Join-Path $Out "$Name-gone.png")
    $left = @(Get-ArdiaProcesses)
    Write-Host "Relaunch ($Name): a window showed after $ms ms, then the browser process (pid $($window.Id)) ended with exit code $($window.ExitCode) (0x$('{0:X8}' -f $window.ExitCode)) about $died ms after the window showed (peak $peakMb MB private); $($left.Count) Ardia processes left"
    Start-Sleep -Seconds 2
    Report-Exits $Name
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

function Get-EngineHistoryCount {
  $line = python (Join-Path $PSScriptRoot "probe\count-history.py") (Join-Path $data "User Data\Default\History") 2>&1 | Out-String
  if ($line -match ": (\d+) pages") { return [int]$Matches[1] }
  return 0
}

function Get-OtherWindows([IntPtr]$Handle) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $owner = [System.Windows.Automation.AutomationElement]::FromHandle($Handle).Current.ProcessId
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $owner)
  return @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition) | Where-Object { $_.Current.NativeWindowHandle -ne [int]$Handle })
}

function Start-Import([IntPtr]$Handle, [string]$Name) {
  $opened = Click-NameLike $Handle "Import*"
  Start-Sleep -Seconds 3
  Save-Screenshot (Join-Path $Out "$Name-import-1.png")
  Write-Host "Relaunch ($Name): import card button: $opened"
  $sheet = Get-OtherWindows $Handle | Select-Object -First 1
  if (-not $sheet) { Write-Host "::warning::relaunch: no import window opened"; return }
  $sheetHandle = [IntPtr]$sheet.Current.NativeWindowHandle
  Write-Host "Relaunch ($Name): the import window is '$($sheet.Current.Name)' ($sheetHandle)"
  [RelaunchInput]::SetForegroundWindow($sheetHandle) | Out-Null
  Start-Sleep -Milliseconds 500
  $started = Click-Named $sheetHandle @("Continue", "Import")
  Write-Host "Relaunch ($Name): import window button: $started"
  Start-Sleep -Seconds 3
  Save-Screenshot (Join-Path $Out "$Name-import-started.png")
  $at = Get-Date
  $last = -1
  $stableSince = Get-Date
  $shot = 2
  while (((Get-Date) - $at).TotalSeconds -lt 300) {
    Start-Sleep -Seconds 5
    $count = Get-EngineHistoryCount
    if ($count -ne $last) { $last = $count; $stableSince = Get-Date }
    if ([int](((Get-Date) - $at).TotalSeconds) % 30 -lt 5) { Save-Screenshot (Join-Path $Out "$Name-import-$shot.png"); $shot++ }
    if ($count -gt 10 -and ((Get-Date) - $stableSince).TotalSeconds -ge 25) { break }
  }
  Save-Screenshot (Join-Path $Out "$Name-import-done.png")
  Write-Host "Relaunch ($Name): the engine's history held $last pages $([int]((Get-Date) - $at).TotalSeconds) s after the import started"
  foreach ($left in Get-OtherWindows $Handle) {
    $leftHandle = [IntPtr]$left.Current.NativeWindowHandle
    [RelaunchInput]::SetForegroundWindow($leftHandle) | Out-Null
    $closed = Click-Named $leftHandle @("Done", "Close", "OK", "Got it", "Continue")
    Write-Host "Relaunch ($Name): left the import window '$($left.Current.Name)' with $closed"
    Start-Sleep -Seconds 2
  }
  [RelaunchInput]::SetForegroundWindow($Handle) | Out-Null
  Start-Sleep -Milliseconds 500
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
    if ($Import) { Start-Import $handle $Name; $clicked += "import" }
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
  if ($Onboarding -and $TesterShape) {
    $keys = [System.Windows.Forms.SendKeys]
    $keys::SendWait("^+s")
    Start-Sleep -Seconds 2
    Save-Screenshot (Join-Path $Out "$Name-shape-sidebar.png")
    $keys::SendWait("^t"); Start-Sleep -Seconds 2
    $keys::SendWait("https://www.roblox.com/{ENTER}"); Start-Sleep -Seconds 8
    $keys::SendWait("^%+d"); Start-Sleep -Seconds 2
    Save-Screenshot (Join-Path $Out "$Name-shape-pinned.png")
    $keys::SendWait("^t"); Start-Sleep -Seconds 2
    $keys::SendWait("https://www.youtube.com/{ENTER}"); Start-Sleep -Seconds 8
    $keys::SendWait("^l"); Start-Sleep -Seconds 2
    $keys::SendWait("Move to Top Apps"); Start-Sleep -Seconds 2
    $keys::SendWait("{ENTER}"); Start-Sleep -Seconds 2
    Save-Screenshot (Join-Path $Out "$Name-shape-tile.png")
    $keys::SendWait("^l"); Start-Sleep -Seconds 2
    $keys::SendWait("Dark Appearance"); Start-Sleep -Seconds 2
    $keys::SendWait("{ENTER}"); Start-Sleep -Seconds 3
    Save-Screenshot (Join-Path $Out "$Name-shape-dark.png")
    Write-Host "Relaunch ($Name): shaped like the tester's: tabs in the sidebar, roblox.com pinned, youtube.com in Top Apps, dark appearance"
  }
  foreach ($address in @("https://example.com/", "https://www.wikipedia.org/")) {
    [System.Windows.Forms.SendKeys]::SendWait("^t")
    Start-Sleep -Seconds 2
    [System.Windows.Forms.SendKeys]::SendWait("$address{ENTER}")
    Start-Sleep -Seconds 6
  }
  [System.Windows.Forms.SendKeys]::SendWait("^t")
  Start-Sleep -Seconds 2
  [System.Windows.Forms.SendKeys]::SendWait("nkse{ENTER}")
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
  Report-Exits $Name
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

$steps = if ($Unclean -eq "early") { @(
  @{ Name = "1-first"; Wait = 0; Close = "alt-f4"; Settle = $FirstSettle },
  @{ Name = "2-killed-early"; Wait = 0; KillAfterMs = 2000 },
  @{ Name = "3-after-early-kill"; Wait = 0; Close = "alt-f4"; Settle = 10 },
  @{ Name = "4-again"; Wait = 5; Close = "alt-f4"; Settle = 10 }
) } elseif ($Unclean) { @(
  @{ Name = "1-first"; Wait = 0; Close = $Unclean; Settle = $FirstSettle },
  @{ Name = "2-after-unclean"; Wait = 0; Close = "alt-f4"; Settle = 10 },
  @{ Name = "3-again"; Wait = 0; Close = "alt-f4"; Settle = 10 },
  @{ Name = "4-after-60s"; Wait = 60; Close = "alt-f4"; Settle = 10 }
) } else { @(
  @{ Name = "1-first"; Wait = 0; Close = "alt-f4"; Settle = $FirstSettle },
  @{ Name = "2-at-once"; Wait = 0; Close = "taskbar-close"; Settle = 10 },
  @{ Name = "3-after-5s"; Wait = 5; Close = "alt-f4"; Settle = 10 },
  @{ Name = "4-after-60s"; Wait = 60; Close = "alt-f4"; Settle = 10 }
) }
foreach ($step in $steps) {
  if ($step.Wait) { Start-Sleep -Seconds $step.Wait }
  if ($step.KillAfterMs) {
    Start-Ardia $step.Name $step.KillAfterMs | Out-Null
    Save-DataFolder "$($step.Name)-killed"
    continue
  }
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
  if ($step.Close -in @("kill-main", "kill-tree", "endsession")) {
    Stop-Unclean $browser $step.Name $step.Close
    Save-DataFolder "$($step.Name)-closed"
    continue
  }
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
  if ($SeedEngine -and $step.Name -eq "1-first") {
    python (Join-Path $PSScriptRoot "probe\seed-engine-history.py") $SeedEngine (Join-Path $data "User Data\Default\History") | Write-Host
  }
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
