$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "relaunch-facts.ps1")

$failures = @()

function Check([string]$Name, $Expected, $Actual) {
  if ("$Expected" -eq "$Actual") { Write-Host "pass: $Name" } else { $script:failures += "$Name`: expected '$Expected', got '$Actual'" }
}

function Process([int]$Id, [int]$Parent, [string]$CommandLine) {
  return [pscustomobject]@{ ProcessId = $Id; ParentProcessId = $Parent; CommandLine = $CommandLine }
}

$running = @(
  (Process 10 1 '"C:\Users\a\AppData\Local\Programs\Ardia\Ardia.exe" '),
  (Process 11 10 'C:\Users\a\AppData\Local\Programs\Ardia\Ardia.exe --type=crashpad-handler "--user-data-dir=C:\x"'),
  (Process 12 10 '"C:\Users\a\AppData\Local\Programs\Ardia\Ardia.exe" --type=gpu-process --field-trial-handle=1'),
  (Process 20 1 '"C:\Users\a\AppData\Local\Programs\Ardia\Ardia.exe" --single-argument https://example.com/--type=x'),
  (Process 30 1 $null)
)
Check "a process without --type is a browser process" "10,20" ((Get-BrowserProcesses $running | ForEach-Object ProcessId) -join ",")
Check "an address that contains --type is still a browser process" $true ((Get-BrowserProcesses $running | ForEach-Object ProcessId) -contains 20)
Check "a process with no command line is not counted" $false ((Get-BrowserProcesses $running | ForEach-Object ProcessId) -contains 30)
Check "children are found by parent id" "11,12" ((Get-ChildProcesses $running 10 | ForEach-Object ProcessId) -join ",")
Check "a browser that has started nothing has no children" 0 @(Get-ChildProcesses $running 20).Count
Check "the crash handler, which starts before the engine, isn't a browser child" "12" ((Get-BrowserChildren $running 10 | ForEach-Object ProcessId) -join ",")
Check "a waiting launch with only its crash handler has no browser children" 0 @(Get-BrowserChildren @((Process 40 1 'x'), (Process 41 40 'Ardia.exe --type=crashpad-handler --monitor-self')) 40).Count

$waited = Read-LaunchGuard @(
  "launch 270 process started inside the engine",
  "engine 0 launch guard: waited 2875 ms for the previous Ardia on this profile to finish exiting",
  "engine 0 launch guard: waited 2875 ms for a previous Ardia, 0 unfinished starts before this one, restore state kept"
)
Check "the wait for a previous Ardia is read" 2875 $waited.WaitedMs
Check "unfinished starts are read" 0 $waited.UnfinishedBefore
Check "kept restore state is not set aside" $false $waited.SetAside
Check "a clean log has no fatal lines" 0 $waited.Fatal.Count

$recovered = Read-LaunchGuard @("engine 0 launch guard: waited 0 ms for a previous Ardia, 2 unfinished starts before this one, restore state set aside")
Check "two unfinished starts are read" 2 $recovered.UnfinishedBefore
Check "set-aside restore state is read" $true $recovered.SetAside

$failed = Read-LaunchGuard @(
  "error 317 the app could not start inside the engine: Class not registered",
  "engine 0 app start failed: the app could not start inside the engine: Class not registered (code 13).",
  "[3088:1728:1116/002259.416:FATAL:chrome\browser\browser_process_impl.cc:1959] Check failed: base::RunLoop::IsRunningOnCurrentThread().",
  "fatal 330 crash 0x80000003 at chrome.dll+0x82104BA"
)
Check "a start failure's reason is read" "the app could not start inside the engine: Class not registered (code 13)." $failed.StartFailure
Check "the engine's CHECK and the crash handler's lines are fatal" 2 $failed.Fatal.Count
Check "a log without guard lines reads as unknown" "" (Read-LaunchGuard @("info 1 hello")).WaitedMs

$paused = Read-SyncTrace @(
  "info 812 [sync] test: recoveredStart true, status paused",
  "info 4100 [sync] test: left as it was, status paused",
  "warn 9000 [sync] couldn't read sync.json"
)
Check "a recovered start is read from the sync trace" $true $paused.Recovered
Check "a paused start shows only the paused status" "paused" ($paused.Statuses -join ",")
Check "a paused start has no unlock or cycle line" 0 $paused.UnlocksOrCycles.Count
$ordinary = Read-SyncTrace @(
  "info 700 [sync] test: recoveredStart false, status starting",
  "info 1900 [sync] test: status updating",
  "info 2100 [sync] test: status updated",
  "warn 2200 [sync] unlocking at launch failed",
  "warn 2300 [sync] cycle failed"
)
Check "an ordinary start is read from the sync trace" $false $ordinary.Recovered
Check "an ordinary start's statuses are read in order" "starting,updating,updated" ($ordinary.Statuses -join ",")
Check "unlock and cycle lines are found" 2 $ordinary.UnlocksOrCycles.Count
Check "turning Sync on is read" "turned on" (Read-SyncTrace @("info 5000 [sync] test: turned on")).TurnedOn
Check "a log without the sync trace reads as unknown" $null (Read-SyncTrace @("info 1 hello")).Recovered

$scratch = Join-Path ([IO.Path]::GetTempPath()) "relaunch-facts-$([guid]::NewGuid())"
try {
  $syncData = Join-Path $scratch "data"
  $syncFolder = Join-Path $scratch "folder"
  New-Item -ItemType Directory -Force -Path $syncData, (Join-Path $syncFolder "chain") | Out-Null
  Set-Content -LiteralPath (Join-Path $syncData "sync-state.nns") -Value "state" -NoNewline
  Set-Content -LiteralPath (Join-Path $syncData "sync-journal-1.nns") -Value "journal" -NoNewline
  Set-Content -LiteralPath (Join-Path $syncData "session.json") -Value "{}" -NoNewline
  Set-Content -LiteralPath (Join-Path $syncFolder "chain/a.nns") -Value "a" -NoNewline
  $before = Get-SyncDigests $syncData $syncFolder
  Check "the sealed files and the sync folder are hashed, nothing else" "data/sync-journal-1.nns,data/sync-state.nns,folder/chain/a.nns" (@($before.Keys) -join ",")
  Check "unchanged files compare equal" 0 (Compare-SyncDigests $before (Get-SyncDigests $syncData $syncFolder)).Count
  Set-Content -LiteralPath (Join-Path $syncData "sync-journal-1.nns") -Value "journal2" -NoNewline
  Set-Content -LiteralPath (Join-Path $syncData "sync-journal-2.nns") -Value "new" -NoNewline
  Remove-Item -LiteralPath (Join-Path $syncFolder "chain/a.nns")
  Check "a changed, an added and a removed file are each reported" "data/sync-journal-1.nns changed,folder/chain/a.nns was removed,data/sync-journal-2.nns was added" ((Compare-SyncDigests $before (Get-SyncDigests $syncData $syncFolder)) -join ",")

  $docPath = Join-Path $syncData "sync.json"
  Set-Content -LiteralPath $docPath -Value '{"enabled":true,"seqs":{"b":2,"a":{"y":1,"x":0}},"pausedByGuard":true}'
  $doc = Read-SyncDoc $docPath
  Check "pausedByGuard is read from sync.json" $true $doc.PausedByGuard
  Check "seqs are read with sorted keys" '{"a":{"x":0,"y":1},"b":2}' $doc.Seqs
  Set-Content -LiteralPath $docPath -Value '{"enabled":true,"seqs":{"a":{"x":0,"y":1},"b":2}}'
  Check "the same seqs in another order read the same" '{"a":{"x":0,"y":1},"b":2}' (Read-SyncDoc $docPath).Seqs
  Check "a doc without the pause reads as not paused" $false (Read-SyncDoc $docPath).PausedByGuard
  Check "a missing sync.json is not found" $false (Read-SyncDoc (Join-Path $syncData "absent.json")).Found
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

$local = @(
  '{"at":1000,"kind":"event","sent":false,"event":"usage_counts","uuid":"1","distinct_id":null,"properties":{"sync_paused_by_launch_guard":1}}',
  '{"at":2000,"kind":"event","sent":false,"event":"usage_counts","uuid":"2","distinct_id":null,"properties":{"sync_paused_by_launch_guard":0,"sync_resumes":0}}',
  '{"at":500,"kind":"event","sent":false,"event":"usage_counts","uuid":"3","distinct_id":null,"properties":{"sync_paused_by_launch_guard":1}}',
  '{"at":1500,"kind":"log","sent":false,"level":"warn","message":"sync_paused_by_launch_guard","attributes":{}}',
  'not json "sync_paused_by_launch_guard"'
)
Check "the pause count is summed over one start's local events" 1 (Measure-LocalCount $local "usage_counts" "sync_paused_by_launch_guard" 900 2500)
Check "events outside the start aren't counted" 2 (Measure-LocalCount $local "usage_counts" "sync_paused_by_launch_guard" 0 2500)

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "Launch logs and process lists read as the relaunch check expects."
