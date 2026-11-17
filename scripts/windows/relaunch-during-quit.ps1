$script:QuitStretch = "quitWaitMs=2000,quitUnloadHoldMs=2000,quitFlushHoldMs=2000"
$script:QuitHandOffHoldMs = 2500
$script:QuitPort = 9461
$script:QuitData = $null

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

function Wait-QuitLine([string]$pattern, [string]$what, [int]$seconds = 30) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Count-QuitLines $pattern) -gt 0) { return }
    Start-Sleep -Milliseconds 25
  }
  Keep-QuitLog $what
  throw "$what`: the launch log never said '$pattern'"
}

function Quit-Link([string]$name) {
  $page = Join-Path $script:QuitData "pages\quit-$name.html"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $page) | Out-Null
  Set-Content -LiteralPath $page -Value "<!doctype html><meta charset=utf-8><title>quit $name</title><p>opened during a quit: $name</p>" -Encoding utf8NoBOM
  return ([Uri]$page).AbsoluteUri
}

function Start-QuitLaunch([string]$link) {
  $launched = Start-Process -FilePath $exe -ArgumentList @($link) -PassThru
  $null = $launched.Handle
  return $launched
}

function Wait-QuitLink([string]$what, [string]$name, [int]$seconds = 45) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $seen = @()
  while ((Get-Date) -lt $deadline) {
    try {
      $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$($script:QuitPort)/json/list" -TimeoutSec 2)
      $seen = @($targets | ForEach-Object { $_.url })
      if ($seen | Where-Object { $_ -like "*quit-$name.html" }) { return }
    } catch {
    }
    Start-Sleep -Milliseconds 250
  }
  Keep-QuitLog $what
  throw "$what`: the link the launch carried (quit-$name.html) never opened; pages open: $($seen -join ', ')"
}

function Open-QuitInstance([string]$what) {
  if (@(Browsers).Count) { throw "$what`: an Ardia was still running before this case" }
  Clear-QuitLog
  Start-Ardia | Out-Null
  $shown = Wait-Window $what 120
  Wait-QuitLine 'launch guard: waited' $what
  Start-Sleep -Seconds 3
  return $shown
}

function Wait-OneWindowAfter([string]$what, [int]$old, [int]$seconds = 60) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $windowed = @(Browsers | Where-Object { [RelaunchCheck.Native]::AppWindows([uint32]$_.ProcessId).Count -gt 0 })
    if ($windowed.Count -eq 1 -and -not (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
      $window = [RelaunchCheck.Native]::AppWindows([uint32]$windowed[0].ProcessId)[0]
      return [pscustomobject]@{ Pid = [int]$windowed[0].ProcessId; Window = $window }
    }
    Start-Sleep -Milliseconds 250
  }
  Keep-QuitLog $what
  $alive = if (Get-Process -Id $old -ErrorAction SilentlyContinue) { "still running" } else { "gone" }
  throw "$what`: no single Ardia with a window within $seconds s (the quitting Ardia $old is $alive; browsers: $(((Browsers) | ForEach-Object ProcessId) -join ', '))"
}

function Assert-LaunchKept([string]$what, $old, $launched, [string]$name) {
  $shown = Wait-OneWindowAfter $what $old.Pid
  Assert-OneBrowser $what
  $lines = @(Quit-Log)
  $fresh = @($lines | ForEach-Object { if ($_ -match 'a fresh Ardia \((\d+)\)') { [int]$Matches[1] } })
  if ($shown.Pid -ne $launched.Id -and $fresh -notcontains $shown.Pid) {
    Keep-QuitLog $what
    throw "$what`: the window is in Ardia $($shown.Pid), which is neither this launch ($($launched.Id)) nor a fresh start the log names"
  }
  if ($launched.HasExited -and $shown.Pid -ne $launched.Id) {
    $said = @($lines | Where-Object { $_ -match 'reached this Ardia while it was quitting|Chromium refused this launch|app start failed' })
    if (-not $said.Count) { Keep-QuitLog $what; throw "$what`: Ardia $($launched.Id) exited with $($launched.ExitCode) and nothing in the log says why" }
  }
  Wait-QuitLink $what $name
  Keep-QuitLog $what
  return $shown
}

function Assert-QuitFinished([string]$what) {
  if (-not (@(Quit-Log) | Where-Object { $_ -match 'process ending' })) { Keep-QuitLog $what; throw "$what`: the quitting Ardia never finished its shutdown" }
}

function Close-QuitInstance([string]$what, $shown) {
  Close-Window $shown
  Wait-Exit $shown.Pid $what | Out-Null
}

function Test-LaunchInQuitPhase([string]$name, [string]$phase, [string]$waitFor, [int]$afterMs) {
  $what = "a launch during the quit's $phase"
  $old = Open-QuitInstance $what
  $link = Quit-Link $name
  Close-Window $old
  Wait-QuitLine $waitFor $what
  Start-Sleep -Milliseconds $afterMs
  $launched = Start-QuitLaunch $link
  $shown = Assert-LaunchKept $what $old $launched $name
  Assert-QuitFinished $what
  $waited = @(@(Quit-Log) | Where-Object { $_ -match 'launch guard: waited (\d+) ms for the previous Ardia on this profile to finish exiting' } | Select-Object -Last 1)
  if (-not $waited.Count) { Keep-QuitLog $what; throw "$what`: the new launch didn't wait for the quitting Ardia, so it met it some other way" }
  Note "$what`: the launch waited for the quitting Ardia ($($waited[0] -replace '^.*waited (\d+) ms.*$', '$1') ms), then one Ardia with a window and its link"
  Close-QuitInstance $what $shown
}

function Test-LaunchHandedToQuittingArdia {
  $what = "a launch handed to an Ardia that then quits"
  $old = Open-QuitInstance $what
  $link = Quit-Link "handed"
  $env:ARDIA_TEST = "$($script:QuitStretch),handOffHoldMs=$($script:QuitHandOffHoldMs)"
  try {
    $launched = Start-QuitLaunch $link
    Wait-QuitLine 'test: this launch waits' $what
  } finally {
    $env:ARDIA_TEST = $script:QuitStretch
  }
  Close-Window $old
  Wait-QuitLine 'reached this Ardia while it was quitting' $what 30
  $shown = Assert-LaunchKept $what $old $launched "handed"
  Assert-QuitFinished $what
  if ($shown.Pid -eq $launched.Id) { Keep-QuitLog $what; throw "$what`: the handed launch opened its own window instead of the quitting Ardia starting a fresh one" }
  if (-not (@(Quit-Log) | Where-Object { $_ -match 'started again for 1 launches that reached a quitting Ardia' })) { Keep-QuitLog $what; throw "$what`: the fresh Ardia doesn't say it was started for the held launch" }
  Note "$what`: the quitting Ardia held it, started a fresh Ardia ($($shown.Pid)) once it ended, and the link opened there"
  Close-QuitInstance $what $shown
}

function Test-LaunchRefusedByAnEndingArdia {
  $what = "a launch Chromium refuses while the last Ardia ends"
  Clear-QuitLog
  $link = Quit-Link "refused"
  $key = [RelaunchCheck.Native]::ProfileKey((Join-Path $script:QuitData "Chromium"))
  $created = $false
  $alive = New-Object System.Threading.Mutex($true, "Local\ArdiaBrowser.$key.alive", [ref]$created)
  $exiting = New-Object System.Threading.EventWaitHandle($true, [System.Threading.EventResetMode]::ManualReset, "Local\ArdiaBrowser.$key.exiting")
  $lock = [IO.File]::Open((Join-Path $script:QuitData "Chromium\lockfile"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  $released = $false
  try {
    $launched = Start-QuitLaunch $link
    Start-Sleep -Seconds 3
    $alive.ReleaseMutex()
    $released = $true
    Wait-QuitLine 'Chromium refused this launch' $what 40
  } finally {
    $lock.Dispose()
    if (-not $released) { try { $alive.ReleaseMutex() } catch { } }
    $alive.Dispose()
    $exiting.Dispose()
  }
  $shown = Assert-LaunchKept $what ([pscustomobject]@{ Pid = $launched.Id }) $launched "refused"
  if (-not (@(Quit-Log) | Where-Object { $_ -match 'started again after Chromium refused the last launch' })) { Keep-QuitLog $what; throw "$what`: the fresh Ardia doesn't say it was started after a refusal" }
  Note "$what`: it waited for the ending Ardia, started a fresh Ardia ($($shown.Pid)) when Chromium still refused it, and the link opened there"
  Close-QuitInstance $what $shown
}

function Test-LaunchRefusedForGood {
  $what = "a launch whose profile another program holds"
  Clear-QuitLog
  $lock = [IO.File]::Open((Join-Path $script:QuitData "Chromium\lockfile"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  try {
    $launched = Start-QuitLaunch (Quit-Link "held")
    if (-not $launched.WaitForExit(60000)) { throw "$what`: Ardia was still running 60 s after a start that could not open its profile" }
  } finally {
    $lock.Dispose()
  }
  $failed = @(@(Quit-Log) | Where-Object { $_ -match 'app start failed: (.+)$' })
  Keep-QuitLog $what
  if (-not $failed.Count) { throw "$what`: Ardia exited with $($launched.ExitCode) and the launch log doesn't say why (a silent exit)" }
  if ($launched.ExitCode -eq 0) { throw "$what`: Ardia exited with 0 although it couldn't start" }
  if (@(Browsers).Count) { throw "$what`: an Ardia is running although the start failed" }
  $shown = Open-QuitInstance "a launch after a refused start"
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
  $env:ARDIA_TEST = $script:QuitStretch
  $env:ARDIA_REMOTE_DEBUGGING_PORT = "$($script:QuitPort)"
  try {
    Test-LaunchInQuitPhase "wait" "wait for the app's answer" 'test: the quit waits' 700
    Test-LaunchInQuitPhase "unload" "unload, before the engine quits" 'test: the engine is asked to quit' 600
    Test-LaunchInQuitPhase "flush" "document flush" 'test: the flush is held' 600
    Test-LaunchHandedToQuittingArdia
    Test-LaunchRefusedByAnEndingArdia
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
