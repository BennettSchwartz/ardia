$script:QuitPort = 9461
$script:QuitData = $null
$script:StillThereSeconds = 20

function Quit-LogFiles { return @((Join-Path $script:QuitData "Logs\launch.previous.log"), (Join-Path $script:QuitData "Logs\launch.log")) }

function Quit-Log {
  $lines = @()
  foreach ($file in @(Quit-LogFiles)) { if (Test-Path -LiteralPath $file) { $lines += @(Get-Content -LiteralPath $file) } }
  return $lines
}

function Count-QuitLines([string]$pattern) { return @(@(Quit-Log) | Where-Object { $_ -match $pattern }).Count }

function Keep-QuitLog([string]$name) {
  $to = Join-Path $Out "during-quit"
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  foreach ($file in @(Quit-LogFiles)) {
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $to "$name-$(Split-Path -Leaf $file)") -Force }
  }
}

function Clear-QuitLog { foreach ($file in @(Quit-LogFiles)) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue } }

function Fail-Quit([string]$what, [string]$why) {
  Keep-QuitLog $what
  throw "$what`: $why"
}

function Wait-QuitLine([string]$pattern, [string]$what, [int]$seconds = 30) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Count-QuitLines $pattern) -gt 0) { return }
    Start-Sleep -Milliseconds 25
  }
  Fail-Quit $what "the launch log never said '$pattern'"
}

function Assert-QuitLine([string]$pattern, [string]$what, [string]$why) {
  if (-not (Count-QuitLines $pattern)) { Fail-Quit $what $why }
}

function Assert-NoQuitLine([string]$pattern, [string]$what, [string]$why) {
  if (Count-QuitLines $pattern) { Fail-Quit $what $why }
}

function Assert-EndedWithProcessEnding([string]$what, [string]$file) {
  $last = @(Get-Content -LiteralPath $file -ErrorAction SilentlyContinue | Where-Object { $_.Trim() }) | Select-Object -Last 1
  if ("$last" -notmatch 'process ending') { Fail-Quit $what "the closing Ardia's log ($(Split-Path -Leaf $file)) ends with '$last', not 'process ending'" }
}

function Quit-Link([string]$name, [string]$pageScript = "") {
  $page = Join-Path $script:QuitData "pages\quit-$name.html"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $page) | Out-Null
  Set-Content -LiteralPath $page -Value "<!doctype html><meta charset=utf-8><title>quit $name</title><p>opened during a quit: $name</p><script>$pageScript</script>" -Encoding utf8NoBOM
  return ([Uri]$page).AbsoluteUri
}

function Start-WithTest([string]$test, [string[]]$arguments = @()) {
  $saved = $env:ARDIA_TEST
  if ($test) { $env:ARDIA_TEST = $test } else { Remove-Item -Path Env:ARDIA_TEST -ErrorAction SilentlyContinue }
  try {
    $started = if ($arguments.Count) { Start-Process -FilePath $exe -ArgumentList $arguments -PassThru } else { Start-Process -FilePath $exe -PassThru }
    $null = $started.Handle
    return $started
  } finally {
    if ($null -eq $saved) { Remove-Item -Path Env:ARDIA_TEST -ErrorAction SilentlyContinue } else { $env:ARDIA_TEST = $saved }
  }
}

function Page-Targets {
  try { return @(Invoke-RestMethod -Uri "http://127.0.0.1:$($script:QuitPort)/json/list" -TimeoutSec 2 | Where-Object { $_.type -eq "page" }) } catch { return @() }
}

function Link-Targets([string]$name) { return @(Page-Targets | Where-Object { $_.url -like "*quit-$name.html" }) }

function Wait-QuitLinkOnce([string]$what, [string]$name, [int]$seconds = 45) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline -and -not @(Link-Targets $name).Count) { Start-Sleep -Milliseconds 250 }
  if (-not @(Link-Targets $name).Count) { Fail-Quit $what "the link the launch carried (quit-$name.html) never opened; pages open: $((Page-Targets | ForEach-Object { $_.url }) -join ', ')" }
  Start-Sleep -Seconds 2
  $open = @(Link-Targets $name).Count
  if ($open -ne 1) { Fail-Quit $what "the link the launch carried (quit-$name.html) is open $open times, not once" }
}

function Open-QuitInstance([string]$what, [string]$test) {
  if (@(Browsers).Count) { throw "$what`: an Ardia was still running before this case" }
  Clear-QuitLog
  Start-WithTest $test | Out-Null
  $shown = Wait-Window $what 120
  Wait-QuitLine 'launch guard: waited' $what
  Start-Sleep -Seconds 3
  return $shown
}

function Describe-Browsers { return (@(Browsers) | ForEach-Object { "$($_.ProcessId) ($([RelaunchCheck.Native]::AppWindows([uint32]$_.ProcessId).Count) windows)" }) -join ', ' }

function Assert-SameArdiaKeepsIt([string]$what, $old, $launched, [string]$name) {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not ($launched.HasExited -and [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid).Count -gt 0)) { Start-Sleep -Milliseconds 250 }
  if (-not (Get-Process -Id $old.Pid -ErrorAction SilentlyContinue)) { Fail-Quit $what "the Ardia that was closing ($($old.Pid)) ended instead of taking the launch (browsers: $(Describe-Browsers))" }
  if (-not $launched.HasExited) { Fail-Quit $what "the launch ($($launched.Id)) is still running instead of handing over to Ardia $($old.Pid)" }
  if ($launched.ExitCode -ne 0) { Fail-Quit $what "the launch ($($launched.Id)) exited with $($launched.ExitCode), not 0" }
  if (-not [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid).Count) { Fail-Quit $what "Ardia $($old.Pid) took the launch but shows no window" }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and @(Browsers | Where-Object { [int]$_.ProcessId -ne $old.Pid }).Count) { Start-Sleep -Milliseconds 250 }
  if (@(Browsers | Where-Object { [int]$_.ProcessId -ne $old.Pid }).Count) { Fail-Quit $what "another browser runs beside Ardia $($old.Pid): $(Describe-Browsers)" }
  Wait-QuitLinkOnce $what $name
  Start-Sleep -Seconds 5
  if (-not (Get-Process -Id $old.Pid -ErrorAction SilentlyContinue) -or -not [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid).Count) { Fail-Quit $what "Ardia $($old.Pid) showed the launch's window, then lost it within 5 s (browsers: $(Describe-Browsers))" }
  $open = @(Link-Targets $name).Count
  if ($open -ne 1) { Fail-Quit $what "5 s later the link is open $open times, not once" }
  Keep-QuitLog $what
  return [pscustomobject]@{ Pid = $old.Pid; Window = [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid)[0] }
}

function Assert-OneFreshArdia([string]$what, [int]$old, [string]$name, [int[]]$notThese = @()) {
  $deadline = (Get-Date).AddSeconds(75)
  $fresh = 0
  while ((Get-Date) -lt $deadline) {
    $windowed = @(Browsers | Where-Object { [RelaunchCheck.Native]::AppWindows([uint32]$_.ProcessId).Count -gt 0 })
    if ($windowed.Count -eq 1 -and -not (Get-Process -Id $old -ErrorAction SilentlyContinue)) { $fresh = [int]$windowed[0].ProcessId; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $fresh) {
    $alive = if (Get-Process -Id $old -ErrorAction SilentlyContinue) { "still running" } else { "gone" }
    Fail-Quit $what "no single fresh Ardia with a window within 75 s (the closing Ardia $old is $alive; browsers: $(Describe-Browsers))"
  }
  if ($notThese -contains $fresh) { Fail-Quit $what "the window is in Ardia $fresh, a process this case expected to end" }
  Assert-OneBrowser $what
  Wait-QuitLinkOnce $what $name
  Start-Sleep -Seconds $script:StillThereSeconds
  if (-not (Get-Process -Id $fresh -ErrorAction SilentlyContinue) -or -not [RelaunchCheck.Native]::AppWindows([uint32]$fresh).Count) { Fail-Quit $what "the fresh Ardia ($fresh) was gone or windowless $($script:StillThereSeconds) s later (browsers: $(Describe-Browsers))" }
  if (@(Browsers).Count -ne 1) { Fail-Quit $what "$($script:StillThereSeconds) s later there are $(@(Browsers).Count) browsers: $(Describe-Browsers)" }
  $open = @(Link-Targets $name).Count
  if ($open -ne 1) { Fail-Quit $what "$($script:StillThereSeconds) s later the link is open $open times, not once" }
  Keep-QuitLog $what
  return [pscustomobject]@{ Pid = $fresh; Window = [RelaunchCheck.Native]::AppWindows([uint32]$fresh)[0] }
}

function Close-QuitInstance([string]$what, $shown) {
  Close-Window $shown
  Wait-Exit $shown.Pid $what | Out-Null
  Assert-EndedWithProcessEnding $what (Join-Path $script:QuitData "Logs\launch.log")
}

function Test-LaunchBeforeTheQuitBegins {
  $what = "a launch in the wait between the last window closing and the quit"
  $old = Open-QuitInstance $what "lastWindowWaitMs=4000"
  $link = Quit-Link "before"
  Close-Window $old
  Wait-QuitLine 'test: the quit waits 4000 ms after the last window closed' $what
  Start-Sleep -Milliseconds 1000
  $launched = Start-WithTest "" @($link)
  $shown = Assert-SameArdiaKeepsIt $what $old $launched "before"
  Assert-NoQuitLine 'began \((user|update)\)' $what "a quit began although a launch came before it"
  Note "$what`: the same Ardia ($($shown.Pid)) showed a window with the link, once"
  Close-QuitInstance $what $shown
}

function Test-LaunchAtTheQuitSeam {
  $what = "a launch whose window is still on its way when the last window's wait ends"
  $old = Open-QuitInstance $what "lastWindowWaitMs=1500,windowOpenHoldMs=3000"
  $link = Quit-Link "seam"
  Close-Window $old
  Wait-QuitLine 'test: the quit waits 1500 ms after the last window closed' $what
  Start-Sleep -Milliseconds 300
  $launched = Start-WithTest "" @($link)
  Wait-QuitLine 'not begun: a launch arrived after the last window closed' $what
  $shown = Assert-SameArdiaKeepsIt $what $old $launched "seam"
  Assert-NoQuitLine 'began \((user|update)\)' $what "the quit began while the launch's window was on its way"
  Note "$what`: the quit waited for the launch's window, and Ardia $($shown.Pid) kept it with the link, once"
  Close-QuitInstance $what $shown
}

function Test-LaunchDuringTheQuitWait {
  $what = "a launch while the quit waits for the app's answer"
  $old = Open-QuitInstance $what "quitWaitMs=4000"
  $link = Quit-Link "wait"
  Close-Window $old
  Wait-QuitLine 'began \(user\)' $what
  Start-Sleep -Milliseconds 700
  $launched = Start-WithTest "" @($link)
  $shown = Assert-SameArdiaKeepsIt $what $old $launched "wait"
  Assert-QuitLine 'cancelled by a relaunch after \d+ ms' $what "the log doesn't say the launch cancelled the quit"
  Assert-QuitLine 'relaunch: a launch cancels the quit' $what "the engine doesn't say the launch cancelled the quit"
  Assert-NoQuitLine '^launch \d+ quitting$' $what "the app unloaded although the launch cancelled the quit"
  Note "$what`: the quit was cancelled and Ardia $($shown.Pid) kept running with the link, once"
  Close-QuitInstance $what $shown
  Note "$what`: a later quit still ends Ardia, with 'process ending' last"
}

function Test-LaunchDuringAnUpdateQuit {
  $what = "a launch during an update's quit"
  $old = Open-QuitInstance $what "quitWaitMs=3000,quitReason=update"
  $link = Quit-Link "update"
  Close-Window $old
  Wait-QuitLine 'began \(update\)' $what
  Start-Sleep -Milliseconds 700
  $launched = Start-WithTest "" @($link)
  if (-not $launched.WaitForExit(30000)) { Fail-Quit $what "the launch ($($launched.Id)) was still running 30 s later" }
  Wait-Exit $old.Pid $what 30 | Out-Null
  Assert-QuitLine "relaunch: a launch during an update's quit is ignored" $what "the engine doesn't say it ignored the launch during an update's quit"
  Assert-NoQuitLine 'cancelled by a relaunch' $what "a launch cancelled an update's quit"
  Start-Sleep -Seconds 5
  if (@(Browsers).Count) { Fail-Quit $what "an Ardia is running after an update's quit, before any installer: $(Describe-Browsers)" }
  Assert-EndedWithProcessEnding $what (Join-Path $script:QuitData "Logs\launch.log")
  Note "$what`: the quit went on, the launch was left for the installer to reopen Ardia, and nothing was left running"
}

function Test-LateAnswerAfterACancelledQuit {
  $what = "the app's answer to a quit a launch cancelled"
  $old = Open-QuitInstance $what "quitAnswerHoldMs=4000"
  $link = Quit-Link "late"
  Close-Window $old
  Wait-QuitLine 'began \(user\)' $what
  Start-Sleep -Milliseconds 300
  Start-WithTest "" @($link) | Out-Null
  Wait-QuitLine 'cancelled by a relaunch after \d+ ms' $what
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and -not [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid).Count) { Start-Sleep -Milliseconds 100 }
  $windows = [RelaunchCheck.Native]::AppWindows([uint32]$old.Pid)
  if (-not $windows.Count) { Fail-Quit $what "Ardia $($old.Pid) showed no window after the launch cancelled its quit (browsers: $(Describe-Browsers))" }
  Close-Window ([pscustomobject]@{ Pid = $old.Pid; Window = $windows[0] })
  Wait-Exit $old.Pid $what 45 | Out-Null
  Assert-QuitLine 'an answer (to an earlier, cancelled quit came during this one|came after its quit was cancelled or had finished); ignored' $what "the answer to the cancelled quit wasn't set aside"
  $outcomes = @(@(Quit-Log) | Where-Object { $_ -match '(the app answered (yes|no) after \d+ ms|no answer in \d+ ms|cancelled by a relaunch after \d+ ms)' })
  if ($outcomes.Count -ne 2) { Fail-Quit $what "expected two quits in the log (the cancelled one and the real one), found $($outcomes.Count): $($outcomes -join ' | ')" }
  if ($outcomes[1] -notmatch 'no answer in \d+ ms') { Fail-Quit $what "the second quit ended on '$($outcomes[1])', not on its own missing answer: the first quit's late answer ended it" }
  Assert-EndedWithProcessEnding $what (Join-Path $script:QuitData "Logs\launch.log")
  Note "$what`: the late answer was set aside, the app stayed up, and the next quit ended Ardia on its own terms"
}

function Test-LaunchAfterThePointOfNoReturn {
  $what = "a launch after the quit's point of no return"
  $old = Open-QuitInstance $what "quitUnloadHoldMs=3000,quitFlushHoldMs=2000"
  $link = Quit-Link "after"
  Close-Window $old
  Wait-QuitLine 'test: the engine is asked to quit 3000 ms after the unload' $what
  Start-Sleep -Milliseconds 500
  Start-WithTest "" @($link) | Out-Null
  $shown = Assert-OneFreshArdia $what $old.Pid "after"
  Assert-QuitLine 'launch guard: waited \d+ ms for the previous Ardia on this profile to finish exiting' $what "the launch didn't wait for the closing Ardia"
  Assert-EndedWithProcessEnding $what (Join-Path $script:QuitData "Logs\launch.previous.log")
  Note "$what`: the launch waited for the closing Ardia, then one fresh Ardia ($($shown.Pid)) with the link, once, still there $($script:StillThereSeconds) s later"
  Close-QuitInstance $what $shown
}

function Test-LaunchTurnedAwayAfterThePointOfNoReturn {
  $what = "a launch handed over after the quit's point of no return"
  $old = Open-QuitInstance $what "quitWaitMs=1500,quitUnloadHoldMs=4000"
  $link = Quit-Link "turned"
  Close-Window $old
  Wait-QuitLine 'began \(user\)' $what
  $launched = Start-WithTest "handOffHoldMs=3000" @($link)
  Wait-QuitLine 'turned a launch away' $what 30
  $shown = Assert-OneFreshArdia $what $old.Pid "turned" @($launched.Id)
  if (-not $launched.HasExited) { Fail-Quit $what "the turned-away launch ($($launched.Id)) is still running" }
  if ($launched.ExitCode -ne 0) { Fail-Quit $what "the turned-away launch exited with $($launched.ExitCode), not 0, after starting Ardia again" }
  Assert-QuitLine 'started again after the closing Ardia turned the last launch away' $what "the fresh Ardia doesn't say it was started again after being turned away"
  Assert-NoQuitLine 'cancelled by a relaunch' $what "the launch reached the app before the point of no return"
  Assert-EndedWithProcessEnding $what (Join-Path $script:QuitData "Logs\launch.previous.log")
  Note "$what`: the closing Ardia turned it away, the launch waited for it to end and started itself again ($($shown.Pid)), with the link once, still there $($script:StillThereSeconds) s later"
  Close-QuitInstance $what $shown
}

function Invoke-PageCommands([string]$socketUrl, [object[]]$commands) {
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $none = [Threading.CancellationToken]::None
  if (-not $socket.ConnectAsync([Uri]$socketUrl, $none).Wait(5000)) { throw "the page's DevTools socket didn't open" }
  try {
    $answers = @()
    $id = 0
    foreach ($command in $commands) {
      $id++
      $bytes = [Text.Encoding]::UTF8.GetBytes((@{ id = $id; method = $command.method; params = $command.params } | ConvertTo-Json -Depth 8 -Compress))
      if (-not $socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $none).Wait(5000)) { throw "$($command.method) wasn't sent" }
      $deadline = (Get-Date).AddSeconds(10)
      $answer = $null
      while (-not $answer -and (Get-Date) -lt $deadline) {
        $buffer = New-Object byte[] 65536
        $text = New-Object System.Text.StringBuilder
        do {
          $receiving = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $none)
          if (-not $receiving.Wait(10000)) { throw "no answer to $($command.method)" }
          [void]$text.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $receiving.Result.Count))
        } while (-not $receiving.Result.EndOfMessage)
        $message = $text.ToString() | ConvertFrom-Json
        if ($message.id -eq $id) { $answer = $message }
      }
      if (-not $answer) { throw "no answer to $($command.method)" }
      $answers += $answer
    }
    return $answers
  } finally {
    $socket.Dispose()
  }
}

function Test-QuitWithABeforeUnloadPage {
  $what = "a quit with a page that asks before it unloads"
  $old = Open-QuitInstance $what "quitByMessage=1"
  $link = Quit-Link "unload" "addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });"
  $launched = Start-WithTest "" @($link)
  if (-not $launched.WaitForExit(30000)) { Fail-Quit $what "the launch carrying the page was still running 30 s later" }
  Wait-QuitLinkOnce $what "unload"
  $page = @(Link-Targets "unload")[0]
  $press = @{ type = "mousePressed"; x = 40; y = 40; button = "left"; clickCount = 1 }
  $release = @{ type = "mouseReleased"; x = 40; y = 40; button = "left"; clickCount = 1 }
  $answers = Invoke-PageCommands $page.webSocketDebuggerUrl @(
    @{ method = "Input.dispatchMouseEvent"; params = $press },
    @{ method = "Input.dispatchMouseEvent"; params = $release },
    @{ method = "Runtime.evaluate"; params = @{ expression = "navigator.userActivation.hasBeenActive"; returnByValue = $true } }
  )
  if ($answers[2].result.result.value -ne $true) { Fail-Quit $what "the page has no user activation, so its beforeunload would never ask (answer: $($answers[2] | ConvertTo-Json -Compress -Depth 6))" }
  $message = [RelaunchCheck.Native]::RegisterWindowMessageW("ArdiaTestQuit")
  [RelaunchCheck.Native]::PostMessageW($old.Window, $message, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Wait-QuitLine 'test: asked to quit by a message' $what 10
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.Elapsed.TotalSeconds -lt 20 -and (Get-Process -Id $old.Pid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 100 }
  if (Get-Process -Id $old.Pid -ErrorAction SilentlyContinue) { Fail-Quit $what "Ardia $($old.Pid) was still running 20 s after its quit began, with $([RelaunchCheck.Native]::AppWindows([uint32]$old.Pid).Count) windows: the page's beforeunload held the engine's quit" }
  Assert-EndedWithProcessEnding $what (Join-Path $script:QuitData "Logs\launch.log")
  Note "$what`: Ardia ended $([int]$watch.Elapsed.TotalMilliseconds) ms after its quit began, without asking the page, with 'process ending' last"
}

function Test-TurnedAwayLaunchKeepsItsUserDataDir {
  $what = "a launch with its own --user-data-dir turned away by a closing Ardia"
  $saved = @{ ARDIA_DATA_DIR = $env:ARDIA_DATA_DIR; ARDIA_REMOTE_DEBUGGING_PORT = $env:ARDIA_REMOTE_DEBUGGING_PORT }
  $custom = Join-Path $script:QuitData "custom-profile"
  New-Item -ItemType Directory -Force -Path $custom | Out-Null
  $key = [RelaunchCheck.Native]::ProfileKey($custom)
  $closing = Start-Process -FilePath "pwsh" -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 14") -WindowStyle Hidden -PassThru
  $null = $closing.Handle
  $owner = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateNew("Local\ArdiaBrowser.$key.owner", 16)
  $view = $owner.CreateViewAccessor(0, 16)
  $view.Write(0, [uint32]$closing.Id)
  $view.Write(4, [uint32]0)
  $view.Write(8, [int64]$closing.StartTime.ToFileTimeUtc())
  $created = $false
  $alive = New-Object System.Threading.Mutex($true, "Local\ArdiaBrowser.$key.alive", [ref]$created)
  $lock = [IO.File]::Open((Join-Path $custom "lockfile"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  $exiting = $null
  $released = $false
  $restarts = Count-LogLines 'started again after the closing Ardia turned the last launch away'
  Remove-Item -Path Env:ARDIA_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item -Path Env:ARDIA_REMOTE_DEBUGGING_PORT -ErrorAction SilentlyContinue
  try {
    $launched = Start-WithTest "" @("--user-data-dir=$custom")
    Start-Sleep -Seconds 1
    $exiting = New-Object System.Threading.EventWaitHandle($true, [System.Threading.EventResetMode]::ManualReset, "Local\ArdiaBrowser.$key.exiting")
    if (-not $closing.WaitForExit(30000)) { throw "$what`: the stand-in for the closing Ardia didn't end" }
    $lock.Dispose()
    $alive.ReleaseMutex()
    $released = $true
  } finally {
    $lock.Dispose()
    if (-not $released) { try { $alive.ReleaseMutex() } catch { } }
    $alive.Dispose()
    if ($exiting) { $exiting.Dispose() }
    $view.Dispose()
    $owner.Dispose()
    foreach ($name in $saved.Keys) { if ($null -ne $saved[$name]) { Set-Item -Path "Env:$name" -Value $saved[$name] } }
  }
  if (-not $launched.WaitForExit(60000)) { throw "$what`: the turned-away launch was still running 60 s later" }
  if ($launched.ExitCode -ne 0) { Keep-Log $what; throw "$what`: the turned-away launch exited with $($launched.ExitCode), not 0" }
  $deadline = (Get-Date).AddSeconds(90)
  $fresh = $null
  while ((Get-Date) -lt $deadline -and -not $fresh) {
    $fresh = @(Browsers | Where-Object { "$($_.CommandLine)" -like "*--user-data-dir=$custom*" -and [RelaunchCheck.Native]::AppWindows([uint32]$_.ProcessId).Count -gt 0 }) | Select-Object -First 1
    if (-not $fresh) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $fresh) { Keep-Log $what; throw "$what`: no Ardia with a window on $custom within 90 s (browsers: $(Describe-Browsers))" }
  Wait-LogLine 'started again after the closing Ardia turned the last launch away' $what $restarts
  $held = $false
  try { ([IO.File]::Open((Join-Path $custom "lockfile"), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)).Dispose() } catch { $held = $true }
  if (-not $held) { Keep-Log $what; throw "$what`: the fresh Ardia ($($fresh.ProcessId)) doesn't hold $custom's lockfile" }
  Note "$what`: it waited for the closing Ardia, then started again ($($fresh.ProcessId)) on its own --user-data-dir"
  Close-Window ([pscustomobject]@{ Pid = [int]$fresh.ProcessId; Window = [RelaunchCheck.Native]::AppWindows([uint32]$fresh.ProcessId)[0] })
  Wait-Exit ([int]$fresh.ProcessId) $what | Out-Null
}

function Test-LaunchRefusedForGood {
  $what = "a launch whose profile another program holds"
  Clear-QuitLog
  $lock = [IO.File]::Open((Join-Path $script:QuitData "Chromium\lockfile"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  try {
    $launched = Start-WithTest "" @((Quit-Link "held"))
    if (-not $launched.WaitForExit(60000)) { throw "$what`: Ardia was still running 60 s after a start that could not open its profile" }
  } finally {
    $lock.Dispose()
  }
  $failed = @(@(Quit-Log) | Where-Object { $_ -match 'app start failed: (.+)$' })
  Keep-QuitLog $what
  if (-not $failed.Count) { throw "$what`: Ardia exited with $($launched.ExitCode) and the launch log doesn't say why (a silent exit)" }
  if ($launched.ExitCode -eq 0) { throw "$what`: Ardia exited with 0 although it couldn't start" }
  if (@(Browsers).Count) { throw "$what`: an Ardia is running although the start failed" }
  $shown = Open-QuitInstance "a launch after a refused start" ""
  $facts = Get-Content -LiteralPath (Join-Path $script:QuitData "launch-guard.json") -Raw | ConvertFrom-Json
  if ($facts.refusedStartsBefore -ne 1) { throw "$what`: the next start counted $($facts.refusedStartsBefore) refused starts, not 1" }
  Note "$what`: no silent exit ($($launched.ExitCode)), the reason in the log ($($failed[0] -replace '^.*app start failed: ', '')), and the next start counted it"
  Close-QuitInstance $what $shown
}

function Test-LaunchesDuringQuit {
  $script:QuitData = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($Out))) ("relaunch-during-quit-" + [guid]::NewGuid().ToString("N").Substring(0, 8))))
  $marker = Join-Path $folder "Ardia.test-build"
  $saved = @{ ARDIA_DATA_DIR = $env:ARDIA_DATA_DIR; ARDIA_TEST = $env:ARDIA_TEST; ARDIA_REMOTE_DEBUGGING_PORT = $env:ARDIA_REMOTE_DEBUGGING_PORT }
  New-Item -ItemType Directory -Force -Path $script:QuitData | Out-Null
  Set-Content -LiteralPath (Join-Path $script:QuitData "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $script:QuitData "config.json") -Value '{"settings":{"openLinksInLittleArdia":false}}' -Encoding utf8NoBOM
  Set-Content -LiteralPath $marker -Value "relaunch-check" -Encoding ascii
  $env:ARDIA_DATA_DIR = $script:QuitData
  Remove-Item -Path Env:ARDIA_TEST -ErrorAction SilentlyContinue
  $env:ARDIA_REMOTE_DEBUGGING_PORT = "$($script:QuitPort)"
  try {
    Test-LaunchBeforeTheQuitBegins
    Test-LaunchAtTheQuitSeam
    Test-LaunchDuringTheQuitWait
    Test-LaunchDuringAnUpdateQuit
    Test-LateAnswerAfterACancelledQuit
    Test-LaunchAfterThePointOfNoReturn
    Test-LaunchTurnedAwayAfterThePointOfNoReturn
    Test-QuitWithABeforeUnloadPage
    Test-TurnedAwayLaunchKeepsItsUserDataDir
    Test-LaunchRefusedForGood
  } finally {
    Keep-QuitLog "final"
    Get-Process -Name Ardia -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    foreach ($name in $saved.Keys) {
      if ($null -eq $saved[$name]) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item -Path "Env:$name" -Value $saved[$name] }
    }
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:QuitData -Recurse -Force -ErrorAction SilentlyContinue
  }
}
