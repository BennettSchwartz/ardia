param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$HistoryPages = 150000,
  [int]$OpenTabs = 30,
  [int]$SettleSeconds = 10,
  [int]$SurviveSeconds = 45,
  [int]$PausedStarts = 5,
  [int]$JoinSeconds = 600
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "relaunch-facts.ps1")


Add-Type -Namespace CrashProfileProbe -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr window, System.Text.StringBuilder name, int size);
[DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr window, IntPtr state);
public static System.Collections.Generic.List<string> AppWindows() {
  var found = new System.Collections.Generic.List<string>();
  EnumWindows((window, state) => {
    if (!IsWindowVisible(window)) return true;
    var name = new System.Text.StringBuilder(128); GetClassNameW(window, name, 128);
    if (name.ToString() != "Microsoft.UI.Windowing.Window") return true;
    uint owner; GetWindowThreadProcessId(window, out owner);
    found.Add(window.ToInt64().ToString() + ":" + owner.ToString());
    return true;
  }, IntPtr.Zero);
  return found;
}
'@

$entry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{47A92F18-32B0-4548-A1EF-72C217FE1836}_is1"
$folder = Join-Path $env:LOCALAPPDATA "Programs\Ardia"
$exe = Join-Path $folder "Ardia.exe"
$marker = Join-Path $folder "Ardia.test-build"
$Out = [IO.Path]::GetFullPath($Out)
$work = Join-Path (Split-Path -Parent $Out) "crash-profile-work"
$data = Join-Path $work "data"
$source = Join-Path $work "source"
$syncFolder = Join-Path $work "sync-folder"
$pages = Join-Path $work "pages"
$clean = Join-Path $work "clean"
$after = Join-Path $work "after"
$logs = Join-Path $Out "logs"
$notes = New-Object System.Collections.Generic.List[string]
$rows = New-Object System.Collections.Generic.List[string]
foreach ($made in @($Out, $logs)) { New-Item -ItemType Directory -Force -Path $made | Out-Null }

function Note([string]$line) {
  Write-Host "crash-profile-probe: $line"
  $script:notes.Add($line)
}

function Browsers { return @(Get-BrowserProcesses @(Get-CimInstance Win32_Process -Filter "Name='Ardia.exe'")) }

function Visible-Windows {
  $found = @()
  foreach ($item in [CrashProfileProbe.Native]::AppWindows()) {
    $parts = $item.Split(":")
    $found += [pscustomobject]@{ Hwnd = [long]$parts[0]; Pid = [int]$parts[1] }
  }
  return $found
}

function Stop-All {
  foreach ($process in @(Get-Process -Name Ardia -ErrorAction SilentlyContinue)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(20)
  while (@(Get-Process -Name Ardia -ErrorAction SilentlyContinue).Count -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
}

function Close-All([string]$what) {
  foreach ($round in 1..3) {
    $browsers = @(Browsers)
    if (-not $browsers.Count) { break }
    $ids = @($browsers | ForEach-Object { [int]$_.ProcessId })
    foreach ($window in @(Visible-Windows | Where-Object { $ids -contains $_.Pid })) {
      [CrashProfileProbe.Native]::PostMessageW([IntPtr]$window.Hwnd, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero) | Out-Null
    }
    $deadline = (Get-Date).AddSeconds(60)
    while (@(Browsers).Count -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  }
  $left = @(Browsers).Count -gt 0
  if ($left) { Note "$what`: Ardia still running after closing its windows; stopped" }
  Stop-All
  return -not $left
}

function Log-Lines([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  return @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)
}

function Wait-LogLine([string]$path, [string]$pattern, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $found = @(Log-Lines $path | Where-Object { $_ -match $pattern })
    if ($found.Count) { return $found[0] }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

function Mirror([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  & robocopy $from $to /MIR /COPY:DAT /DCOPY:DAT /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $from to $to failed with $LASTEXITCODE" }
}

function Start-Old([string]$log, [string[]]$extra = @()) {
  $process = Start-Process -FilePath $exe -ArgumentList (@("--log-file=$log") + $extra) -PassThru
  $null = $process.Handle
  $deadline = (Get-Date).AddSeconds(180)
  $window = $null
  while (-not $window -and (Get-Date) -lt $deadline -and -not $process.HasExited) {
    $window = @(Visible-Windows | Where-Object { $_.Pid -eq $process.Id }) | Select-Object -First 1
    if (-not $window) { Start-Sleep -Milliseconds 200 }
  }
  return [pscustomobject]@{ Process = $process; Window = $window }
}

$docPath = Join-Path $data "sync.json"
$pausedSentence = 'Sync is paused because Ardia didn.t start properly\. Nothing was deleted\. Resume loads Sync again\.'

function Local-Telemetry {
  $local = Join-Path $data "Telemetry\local"
  if (-not (Test-Path -LiteralPath $local)) { return @() }
  return @(Get-ChildItem -LiteralPath $local -File -Filter *.jsonl | ForEach-Object { Get-Content -LiteralPath $_.FullName })
}

function Watch-Start([string]$what, [string]$test = "", [scriptblock]$whileAlive = $null, [string]$untilLine = "", [int]$untilSeconds = 0, [scriptblock]$atUntil = $null, [switch]$KillAtUntil) {
  $log = Join-Path $logs "$($what -replace '[^a-z0-9]+', '-').log"
  $env:ARDIA_TEST = $test
  $startedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $started = Start-Old $log
  $env:ARDIA_TEST = ""
  $verdict = [pscustomobject]@{ What = $what; Window = [bool]$started.Window; Died = $false; Exit = $null; Recovered = $null; Statuses = @(); Fatal = $null; Settings = $null; Lines = @(); During = $null; Reached = $true; AtUntil = $null; Killed = $false; StartedMs = $startedMs; EndedMs = 0 }
  if ($started.Window -and $untilLine) {
    $deadline = (Get-Date).AddSeconds($untilSeconds)
    $verdict.Reached = $false
    while ((Get-Date) -lt $deadline -and -not $started.Process.HasExited) {
      if (@(Log-Lines $log | Where-Object { $_ -match $untilLine }).Count) {
        $verdict.Reached = $true
        if ($atUntil -and -not $started.Process.HasExited) { $verdict.AtUntil = & $atUntil }
        if ($KillAtUntil -and -not $started.Process.HasExited) {
          Stop-All
          $verdict.Killed = $true
        }
        break
      }
      Start-Sleep -Milliseconds 500
    }
  }
  if ($started.Window -and -not $verdict.Killed) {
    $deadline = (Get-Date).AddSeconds($SurviveSeconds)
    while ((Get-Date) -lt $deadline -and -not $started.Process.HasExited) { Start-Sleep -Milliseconds 250 }
  }
  $verdict.Died = $started.Process.HasExited -and -not $verdict.Killed
  if (-not $verdict.Died -and -not $verdict.Killed -and $whileAlive) { $verdict.During = & $whileAlive }
  if ($verdict.Died) { $verdict.Exit = $started.Process.ExitCode; Stop-All } elseif (-not $verdict.Killed) { Close-All $what | Out-Null }
  $verdict.EndedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $lines = @(Log-Lines $log)
  $trace = Read-SyncTrace $lines
  $verdict.Lines = $lines
  $verdict.Recovered = $trace.Recovered
  $verdict.Statuses = $trace.Statuses
  $verdict.Fatal = @((Read-LaunchGuard $lines).Fatal) | Select-Object -First 1
  $verdict.Settings = @($lines | Where-Object { $_ -match '\[sync\] test: settings: (.+)$' } | ForEach-Object { $Matches[1] }) | Select-Object -First 1
  if ($verdict.Fatal) { $verdict.Died = $true }
  return $verdict
}

function Get-ResumeEnding([string[]]$Lines, [bool]$ExitedBeforeClose) {
  $find = { param($pattern) for ($i = 0; $i -lt $Lines.Count; $i++) { if ($Lines[$i] -match $pattern) { return $i } }; return -1 }
  $updated = & $find '\[sync\] test: status updated'
  $saves = & $find '\[quit\] last saves'
  $quitting = & $find '^launch \d+ quitting'
  $fatal = & $find '^fatal \d+ |:FATAL:|Check failed:'
  $ending = & $find 'process ending'
  $crashAt = if ($fatal -ge 0) { $fatal } elseif ($ExitedBeforeClose) { $Lines.Count } else { -1 }
  $kind = if ($crashAt -lt 0) {
    if ($ending -lt 0) { "ended without finishing its quit" } else { "closed by the probe and ended cleanly" }
  } elseif ($updated -lt 0 -or $crashAt -lt $updated) { "crashed before updated" }
  elseif ($saves -ge 0 -and $crashAt -gt $saves) { "crashed after the quit's save" }
  elseif ($quitting -ge 0 -and $crashAt -gt $quitting) { "crashed at quit before the save" }
  else { "crashed after updated while running" }
  $gapMs = $null
  if ($fatal -gt $quitting -and $quitting -ge 0 -and $Lines[$quitting] -match '^launch (\d+) ' ) {
    $quitAt = [long]$Matches[1]
    if ($Lines[$fatal] -match '^fatal (\d+) ') { $gapMs = [long]$Matches[1] - $quitAt }
  }
  return [pscustomobject]@{ Kind = $kind; AfterQuitting = $crashAt -ge 0 -and $quitting -ge 0 -and $crashAt -gt $quitting; Fatal = if ($fatal -ge 0) { $Lines[$fatal] } else { $null }; QuittingToFatalMs = $gapMs }
}

function Lines-Matching($verdict, [string]$pattern) { return @($verdict.Lines | Where-Object { $_ -match $pattern }) }

function Settled-Starts { return "$(Get-Content -LiteralPath (Join-Path $data "launch-starts.txt") -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim() }

function Add-Row([string]$row, $verdict, $doc, [string]$files, [string[]]$problems) {
  $shape = if (-not $verdict.Window) { "no window" } elseif ($verdict.Killed) { "killed by the probe" } elseif ($verdict.Died) { "died" } else { "alive $SurviveSeconds s" }
  $result = if ($problems.Count) { "FAIL: $($problems -join '; ')" } else { "pass" }
  $script:rows.Add("| $row | $shape$(if ($null -ne $verdict.Exit) { " (exit $($verdict.Exit))" }) | $($verdict.Recovered) | $($verdict.Statuses -join ', ') | $($doc.UnsettledStarts) | $($doc.PausedByGuard) | $files | $(if ($verdict.Fatal) { $verdict.Fatal -replace '\|', '/' } else { 'none' }) | $result |")
  Note "$row`: $shape, recoveredStart $($verdict.Recovered), statuses $($verdict.Statuses -join ', '), unsettledStarts $($doc.UnsettledStarts), pausedByGuard $($doc.PausedByGuard), files ${files}: $result"
  if ($problems.Count) { $script:failures += "$row`: $($problems -join '; ')" }
}

function Paused-Problems($verdict, $doc, $changes, [int]$unsettled) {
  $problems = @()
  if (-not $verdict.Window) { $problems += "no window" }
  if ($verdict.Died) { $problems += "didn't stay alive $SurviveSeconds s$(if ($verdict.Fatal) { ": $($verdict.Fatal)" })" }
  if (-not $verdict.Statuses.Count -or @($verdict.Statuses | Where-Object { $_ -ne "paused" }).Count) { $problems += "statuses $($verdict.Statuses -join ', ')" }
  if (-not $doc.PausedByGuard) { $problems += "no pausedByGuard in sync.json" }
  if ($doc.UnsettledStarts -ne $unsettled) { $problems += "unsettledStarts $($doc.UnsettledStarts), not $unsettled" }
  if ($verdict.Settings -notmatch $pausedSentence) { $problems += "Settings said '$($verdict.Settings)'" }
  elseif ($verdict.Settings -notmatch 'offers resume, stop$') { $problems += "Settings offered '$($verdict.Settings)'" }
  if ($changes.Count) { $problems += "Sync files changed: $($changes -join '; ')" }
  $unlocks = (Read-SyncTrace $verdict.Lines).UnlocksOrCycles
  if ($unlocks.Count) { $problems += "a paused start unlocked or cycled: $($unlocks[0])" }
  return , $problems
}

function Write-Report {
  $report = New-Object System.Collections.Generic.List[string]
  $report.Add("## #2596 on the #2570 crashing profile")
  $report.Add("")
  foreach ($line in $notes) { $report.Add("- $line") }
  if ($rows.Count) {
    $report.Add("")
    $report.Add("| row | start | recoveredStart | statuses | unsettledStarts after | pausedByGuard after | Sync files | fatal | result |")
    $report.Add("|---|---|---|---|---|---|---|---|---|")
    foreach ($row in $rows) { $report.Add($row) }
  }
  $report | Set-Content -LiteralPath (Join-Path $Out "crash-profile.md") -Encoding utf8NoBOM
  if ($env:GITHUB_STEP_SUMMARY) { $report | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY }
}

$failures = @()
try {
  if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) { throw "'$Setup' does not exist" }
  if ((Test-Path -LiteralPath $entry) -or (Test-Path -LiteralPath $folder)) { throw "Ardia is already installed for this user" }
  $install = Start-Process -FilePath (Resolve-Path -LiteralPath $Setup).Path -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "the installer exited with $($install.ExitCode)" }

  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($made in @($data, $syncFolder, $pages)) { New-Item -ItemType Directory -Force -Path $made | Out-Null }
  $generated = & python (Join-Path $PSScriptRoot "unforced-history.py") (Join-Path $source "Local\Google\Chrome\User Data\Default\History") $HistoryPages 80
  if ($LASTEXITCODE -ne 0) { throw "the history generator failed" }
  Note "source profile: $generated"
  Set-Content -LiteralPath (Join-Path $data "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $data "config.json") -Value '{"settings":{"openLinksInLittleArdia":false}}' -Encoding utf8NoBOM
  $tabLinks = @(1..$OpenTabs | ForEach-Object {
      $tab = Join-Path $pages "tab-$_.html"
      Set-Content -LiteralPath $tab -Value "<!doctype html><meta charset=utf-8><title>tab $_</title><p>open tab $_</p>" -Encoding utf8NoBOM
      ([Uri]$tab).AbsoluteUri
    })
  $link = Join-Path $pages "overlap.html"
  Set-Content -LiteralPath $link -Value "<!doctype html><meta charset=utf-8><title>overlap</title><p>opened while the last Ardia quit</p>" -Encoding utf8NoBOM
  $linkUri = ([Uri]$link).AbsoluteUri
  Set-Content -LiteralPath $marker -Value "crash-profile-probe" -Encoding ascii
  $env:ARDIA_BACKGROUND = "1"
  $env:ARDIA_DATA_DIR = $data

  $env:ARDIA_TEST = "stageProfile=$syncFolder"
  $env:ARDIA_INSTANCE = "importSourceDir=$source"
  $stageLog = Join-Path $logs "stage.log"
  $staging = [Diagnostics.Stopwatch]::StartNew()
  $stage = Start-Old $stageLog $tabLinks
  if (-not $stage.Window) { throw "the staging start showed no window" }
  $done = Wait-LogLine $stageLog 'staged profile: (synced in|failed|history never loaded|no browser|sync couldn)' 1200
  Note "staging took $([int]$staging.Elapsed.TotalSeconds) s: $(@(Log-Lines $stageLog | Where-Object { $_ -match 'staged profile' }) -join ' | ')"
  if (-not $done -or $done -notmatch 'synced in') { throw "staging didn't finish with Sync on" }
  Start-Sleep -Seconds $SettleSeconds
  Close-All "after staging" | Out-Null
  $env:ARDIA_TEST = ""
  $env:ARDIA_INSTANCE = ""
  Mirror $data (Join-Path $clean "data")
  Mirror $syncFolder (Join-Path $clean "sync-folder")

  $overlapped = $false
  foreach ($attempt in 1..3) {
    if ($attempt -gt 1) { Stop-All; Mirror (Join-Path $clean "data") $data; Mirror (Join-Path $clean "sync-folder") $syncFolder }
    $oldLog = Join-Path $logs "overlap-$attempt-old.log"
    $newLog = Join-Path $logs "overlap-$attempt-new.log"
    $old = Start-Old $oldLog
    if (-not $old.Window) { throw "overlap attempt $attempt`: no window before the close" }
    Start-Sleep -Seconds $SettleSeconds
    $clock = [Diagnostics.Stopwatch]::StartNew()
    [CrashProfileProbe.Native]::PostMessageW([IntPtr]$old.Window.Hwnd, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero) | Out-Null
    while ($clock.ElapsedMilliseconds -lt 500) { Start-Sleep -Milliseconds 5 }
    $new = Start-Process -FilePath $exe -ArgumentList @("--log-file=$newLog", $linkUri) -PassThru
    $null = $new.Handle
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline -and (-not $old.Process.HasExited -or -not $new.HasExited)) { Start-Sleep -Milliseconds 100 }
    $lines = @(Log-Lines $oldLog)
    $arrivedAt = [array]::FindIndex([object[]]$lines, [Predicate[object]] { param($line) $line -match 'test: willQuit arrived' })
    $openedDuringQuit = $arrivedAt -ge 0 -and $arrivedAt + 1 -lt $lines.Count -and @($lines[($arrivedAt + 1)..($lines.Count - 1)] | Where-Object { $_ -match '^window \d+ opened ' }).Count -gt 0
    Note "overlap attempt $attempt`: a window opened in the quitting Ardia: $openedDuringQuit"
    Stop-All
    if ($openedDuringQuit) { $overlapped = $true; break }
  }
  if (-not $overlapped) { Note "no attempt overlapped the quit; the starts below use the last attempt's profile" }
  Mirror $data (Join-Path $after "data")
  Mirror $syncFolder (Join-Path $after "sync-folder")
  $doc = Read-SyncDoc $docPath
  if (-not $doc.Enabled) { throw "the staged profile doesn't have Sync on" }
  Note "after the overlap: unsettledStarts $($doc.UnsettledStarts), pausedByGuard $($doc.PausedByGuard), launch-starts $(Settled-Starts); launch-starts.txt is left alone from here"

  foreach ($death in 1, 2) {
    $verdict = Watch-Start "death $death"
    $doc = Read-SyncDoc $docPath
    $problems = @()
    if (-not $verdict.Died) { $problems += "the start didn't crash" }
    if ($doc.UnsettledStarts -ne $death) { $problems += "unsettledStarts $($doc.UnsettledStarts), not $death" }
    if ($doc.PausedByGuard) { $problems += "already paused" }
    Add-Row "$death. death $death" $verdict $doc "-" $problems
  }

  $digests = Get-SyncDigests $data $syncFolder
  $seqs = (Read-SyncDoc $docPath).Seqs
  $guardBefore = Settled-Starts
  Set-Content -LiteralPath (Join-Path $data "launch-starts.txt") -Value "0" -Encoding ascii
  Note "3. launch-starts.txt was $guardBefore after the deaths; set to 0 so start 3 can pause only through unsettledStarts"
  $verdict = Watch-Start "start 3" "" { Compare-SyncDigests $digests (Get-SyncDigests $data $syncFolder) }
  $doc = Read-SyncDoc $docPath
  $changes = @(@($verdict.During) + @(Compare-SyncDigests $digests (Get-SyncDigests $data $syncFolder)) | Where-Object { $_ })
  $problems = Paused-Problems $verdict $doc $changes 2
  if ($doc.Seqs -ne $seqs) { $problems += "seqs changed" }
  $byCount = Measure-LocalCount @(Local-Telemetry) "usage_counts" "sync_paused_after_unsettled_starts" $verdict.StartedMs $verdict.EndedMs
  $byGuard = Measure-LocalCount @(Local-Telemetry) "usage_counts" "sync_paused_by_launch_guard" $verdict.StartedMs $verdict.EndedMs
  if ($verdict.Recovered -ne $false) { $problems += "recoveredStart $($verdict.Recovered), not false" }
  if ($byCount -ne 1) { $problems += "sync_paused_after_unsettled_starts $byCount in local telemetry, not 1" }
  if ($byGuard -ne 0) { $problems += "sync_paused_by_launch_guard $byGuard in local telemetry, not 0" }
  Add-Row "3. start 3 (count only)" $verdict $doc "$(if ($changes.Count) { 'changed' } else { 'unchanged during and after' })" $problems
  Note "start 3's Settings line: $($verdict.Settings)"

  foreach ($index in 1..$PausedStarts) {
    $verdict = Watch-Start "paused start $index"
    $doc = Read-SyncDoc $docPath
    $changes = Compare-SyncDigests $digests (Get-SyncDigests $data $syncFolder)
    $problems = Paused-Problems $verdict $doc $changes 2
    if ($verdict.Recovered) { $problems += "recoveredStart true on a start after the pause" }
    Add-Row "4. paused start $index" $verdict $doc "$(if ($changes.Count) { 'changed' } else { 'unchanged' })" $problems
  }

  $guardBeforeResume = Settled-Starts
  $verdict = Watch-Start "resume" "syncProbe=resume" $null '\[sync\] test: status updated' 120 { (Read-SyncDocWhileRunning $docPath).UnsettledStarts }
  $doc = Read-SyncDoc $docPath
  $pressed = (Lines-Matching $verdict 'test: pressing Resume').Count -gt 0
  $ended = @(Lines-Matching $verdict 'test: Resume ended, status (\w+)') | Select-Object -First 1
  $ending = Get-ResumeEnding $verdict.Lines ($null -ne $verdict.Exit)
  $countAtUpdated = if ($verdict.Reached -and $null -ne $verdict.AtUntil) { $verdict.AtUntil } else { "not sampled (no updated while alive)" }
  Note "5. Resume: pressed $pressed, $(if ($ended) { $ended -replace '^.*test: ', '' } else { 'no end line' }); unsettledStarts right after updated: $countAtUpdated (a Resume counts its own load, so 3 is expected); the process $($ending.Kind)$(if ($ending.Fatal) { ": $($ending.Fatal)" }); on disk after: unsettledStarts $($doc.UnsettledStarts), pausedByGuard $($doc.PausedByGuard)"
  if ($ending.Kind -eq "crashed after the quit's save") { Note "5. Resume: a death in teardown after the saves, $(if ($null -ne $ending.QuittingToFatalMs) { "$($ending.QuittingToFatalMs) ms after quitting" } else { 'time after quitting unknown' }): $($ending.Fatal)" }
  elseif ($ending.AfterQuitting) { Note "5. Resume: the process crashed after its quitting line, before the saves: $($ending.Fatal)" }
  Add-Row "5. Resume ($($ending.Kind))" $verdict $doc "-" @(if (-not $pressed) { "Resume wasn't pressed" })
  $expectPaused = $ending.Kind -in @("crashed before updated", "crashed after updated while running", "crashed at quit before the save")
  $resumedDoc = $doc
  $digests = Get-SyncDigests $data $syncFolder
  if ($expectPaused) {
    $verdict = Watch-Start "after the Resume"
    $doc = Read-SyncDoc $docPath
    $changes = Compare-SyncDigests $digests (Get-SyncDigests $data $syncFolder)
    $files = if ($changes.Count) { "changed" } else { "unchanged across this paused start" }
    $problems = Paused-Problems $verdict $doc $changes $resumedDoc.UnsettledStarts
    Add-Row "5. branch A: start after the Resume (paused expected)" $verdict $doc $files $problems
  } else {
    $verdict = Watch-Start "after the Resume" "" $null '\[sync\] unlock finished: unlocked' 120 { (Read-SyncDocWhileRunning $docPath).UnsettledStarts }
    $doc = Read-SyncDoc $docPath
    $problems = @()
    if ($ending.Kind -notin @("closed by the probe and ended cleanly", "crashed after the quit's save")) { $problems += "the Resume's process $($ending.Kind)" }
    if ($verdict.Died) { $problems += "died$(if ($verdict.Fatal) { ": $($verdict.Fatal)" })" }
    if ($verdict.Statuses -contains "paused" -or $doc.PausedByGuard) { $problems += "paused (statuses $($verdict.Statuses -join ', '))" }
    if (-not $verdict.Reached) { $problems += "no '[sync] unlock finished: unlocked' while alive" }
    elseif ($verdict.AtUntil -ne 1) { $problems += "unsettledStarts $($verdict.AtUntil) during the start, not 1" }
    Add-Row "5. branch A: start after the Resume (ordinary expected, count during: $($verdict.AtUntil))" $verdict $doc "-" $problems
  }
  $unfinished = (Read-LaunchGuard $verdict.Lines).UnfinishedBefore
  Note "5. the launch guard $(if ($null -eq $unfinished) { "left no guard line in the next start's log" } elseif ($unfinished -gt [int]"0$guardBeforeResume") { "counted the Resume start as unfinished ($unfinished unfinished starts before the next one; $guardBeforeResume before the Resume)" } else { "didn't count the Resume start as unfinished ($unfinished unfinished starts before the next one; $guardBeforeResume before the Resume)" })"

  $verdict = Watch-Start "way out" "syncProbe=wayOut,reauth=granted" $null '\[sync\] test: (status updated|way out: (couldn|no |the |way out failed))' $JoinSeconds
  $doc = Read-SyncDoc $docPath
  $problems = @()
  foreach ($step in 'way out: stopped, status off', 'way out: rejoined') { if (-not (Lines-Matching $verdict ([regex]::Escape($step))).Count) { $problems += "no '$step'" } }
  foreach ($line in Lines-Matching $verdict 'test: way out: (couldn|no |the )|way out failed') { $problems += $line -replace '^.*test: ', '' }
  if (-not ($verdict.Statuses -contains "updated")) { $problems += "Sync never reached updated within $JoinSeconds s" }
  if ($verdict.Died) { $problems += "died" }
  if ($doc.PausedByGuard) { $problems += "still paused" }
  Add-Row "6. Stop Syncing, then join from the folder" $verdict $doc "-" $problems
  foreach ($index in 1, 2) {
    $verdict = Watch-Start "synced start $index" "" $null '\[sync\] test: status updated' 300
    $doc = Read-SyncDoc $docPath
    $problems = @()
    if ($verdict.Died) { $problems += "died" }
    if (-not ($verdict.Statuses -contains "updated")) { $problems += "no finished cycle" }
    if ($verdict.Statuses -contains "paused" -or $doc.PausedByGuard) { $problems += "paused" }
    if ((Settled-Starts) -ne "0") { $problems += "launch-starts $(Settled-Starts) after the quit" }
    $trace = Read-SyncTrace $verdict.Lines
    if (-not $trace.Unlocked) { $problems += "the key didn't unlock (no '[sync] unlock finished: unlocked'), so the count isn't checked" }
    elseif ($doc.UnsettledStarts -ne 0) { $problems += "unsettledStarts $($doc.UnsettledStarts) after a clean quit" }
    Add-Row "6. synced start $index" $verdict $doc "-" $problems
  }


  $healthyCount = (Read-SyncDoc $docPath).UnsettledStarts
  if ($healthyCount -ne 0) { $failures += "7. branch B: unsettledStarts $healthyCount on the synced profile before the kills, not 0" }
  foreach ($kill in 1, 2) {
    $before = (Read-SyncDoc $docPath).UnsettledStarts
    Set-Content -LiteralPath (Join-Path $data "launch-starts.txt") -Value "0" -Encoding ascii
    $verdict = Watch-Start "branch B kill $kill" "" $null '\[sync\] unlock finished: unlocked' 120 $null -KillAtUntil
    $doc = Read-SyncDoc $docPath
    $problems = @()
    if (-not $verdict.Killed) { $problems += "not killed after its unlock line ($(if ($verdict.Died) { 'it died first' } else { 'no unlock line within 120 s' }))" }
    if ($doc.UnsettledStarts -ne $before + 1) { $problems += "unsettledStarts went from $before to $($doc.UnsettledStarts), not up by 1" }
    if ($doc.PausedByGuard) { $problems += "paused before the third start" }
    Add-Row "7. branch B: synced start $kill killed after its count" $verdict $doc "-" $problems
  }

  Set-Content -LiteralPath (Join-Path $data "launch-starts.txt") -Value "0" -Encoding ascii
  $countBeforePause = (Read-SyncDoc $docPath).UnsettledStarts
  $digests = Get-SyncDigests $data $syncFolder
  $verdict = Watch-Start "branch B paused by the count"
  $doc = Read-SyncDoc $docPath
  $changes = Compare-SyncDigests $digests (Get-SyncDigests $data $syncFolder)
  $problems = Paused-Problems $verdict $doc $changes $countBeforePause
  if ($verdict.Recovered -ne $false) { $problems += "recoveredStart $($verdict.Recovered), not false" }
  $byCount = Measure-LocalCount @(Local-Telemetry) "usage_counts" "sync_paused_after_unsettled_starts" $verdict.StartedMs $verdict.EndedMs
  $byGuard = Measure-LocalCount @(Local-Telemetry) "usage_counts" "sync_paused_by_launch_guard" $verdict.StartedMs $verdict.EndedMs
  if ($byCount -ne 1) { $problems += "sync_paused_after_unsettled_starts $byCount in local telemetry, not 1" }
  if ($byGuard -ne 0) { $problems += "sync_paused_by_launch_guard $byGuard in local telemetry, not 0" }
  Add-Row "7. branch B: third start paused by the count" $verdict $doc "$(if ($changes.Count) { 'changed' } else { 'unchanged across this paused start' })" $problems

  Set-Content -LiteralPath (Join-Path $data "launch-starts.txt") -Value "0" -Encoding ascii
  $countBeforeResume = (Read-SyncDoc $docPath).UnsettledStarts
  $verdict = Watch-Start "branch B resume" "syncProbe=resume" $null '\[sync\] test: status updated' 120 { Read-SyncDocWhileRunning $docPath } -KillAtUntil
  $doc = Read-SyncDoc $docPath
  $problems = @()
  if (-not (Lines-Matching $verdict 'test: pressing Resume').Count) { $problems += "Resume wasn't pressed" }
  if (-not $verdict.Killed) { $problems += "not killed after updated ($(if ($verdict.Died) { 'it died first' } else { "no updated within 120 s, statuses $($verdict.Statuses -join ', ')" }))" }
  if ($doc.UnsettledStarts -ne 3) { $problems += "unsettledStarts $($doc.UnsettledStarts) after the kill, not 3 ($countBeforeResume before the Resume start)" }
  if ($doc.PausedByGuard) { $problems += "pausedByGuard still set after the kill" }
  $atUpdated = if ($verdict.AtUntil) { "unsettledStarts $($verdict.AtUntil.UnsettledStarts), pausedByGuard $($verdict.AtUntil.PausedByGuard)" } else { "not sampled" }
  Add-Row "7. branch B: Resume reached updated and was killed ($atUpdated at updated)" $verdict $doc "-" $problems

  Set-Content -LiteralPath (Join-Path $data "launch-starts.txt") -Value "0" -Encoding ascii
  $countBeforeNext = (Read-SyncDoc $docPath).UnsettledStarts
  $digests = Get-SyncDigests $data $syncFolder
  $verdict = Watch-Start "branch B after the kill"
  $doc = Read-SyncDoc $docPath
  $changes = Compare-SyncDigests $digests (Get-SyncDigests $data $syncFolder)
  $problems = Paused-Problems $verdict $doc $changes $countBeforeNext
  if ($verdict.Recovered -ne $false) { $problems += "recoveredStart $($verdict.Recovered), not false" }
  $byCount = Measure-LocalCount @(Local-Telemetry) "usage_counts" "sync_paused_after_unsettled_starts" $verdict.StartedMs $verdict.EndedMs
  $byGuard = Measure-LocalCount @(Local-Telemetry) "usage_counts" "sync_paused_by_launch_guard" $verdict.StartedMs $verdict.EndedMs
  if ($byCount -ne 1) { $problems += "sync_paused_after_unsettled_starts $byCount in local telemetry, not 1" }
  if ($byGuard -ne 0) { $problems += "sync_paused_by_launch_guard $byGuard in local telemetry, not 0" }
  Add-Row "7. branch B: start after the killed Resume, paused by the count again" $verdict $doc "$(if ($changes.Count) { 'changed' } else { 'unchanged across this paused start' })" $problems

  if ($failures.Count) { Note "failed: $($failures -join ' | ')" } else { Note "every row passed" }
} catch {
  Note "stopped: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
  throw
} finally {
  Stop-All
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  foreach ($variable in "ARDIA_BACKGROUND", "ARDIA_DATA_DIR", "ARDIA_INSTANCE", "ARDIA_TEST") { Remove-Item -LiteralPath "Env:$variable" -ErrorAction SilentlyContinue }
  Write-Report
}
if ($failures.Count) { exit 1 }
