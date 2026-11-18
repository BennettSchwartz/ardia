import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = (name) => read(`../../windows/Ardia/${name}`);
const engine = (name) => read(`../../../../scripts/windows/engine/src/ardia/win/${name}`);
const engineInput = (name) => read(`../../../../scripts/windows/engine/${name}`);
const script = (name) => read(`../../../../scripts/windows/${name}`);

const body = (source, signature) => {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is missing`);
  let depth = 0;
  for (let at = source.indexOf("{", start); at < source.length; at++) {
    if (source[at] === "{") depth++;
    if (source[at] === "}" && --depth === 0) return source.slice(start, at + 1);
  }
  throw new Error(`${signature} has no end`);
};

const before = (source, first, second, why) => {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.ok(a >= 0, `${first} is missing`);
  assert.ok(b >= 0, `${second} is missing`);
  assert.ok(a < b, why ?? `${first} comes after ${second}`);
};

test("the app tells the engine each phase of a quit: asking before willQuit, cancelled before quitCancelled, final before the unload", () => {
  const windows = app("WindowManager.h");
  before(body(windows, "void Quit(std::string_view reason) noexcept {"), 'TellEngineQuitting("asking")', 'EmitApp("willQuit")');
  before(body(windows, "void CancelQuit() noexcept {"), 'TellEngineQuitting("cancelled")', 'EmitApp("quitCancelled")');
  before(body(windows, "void Finish() noexcept {"), "TellEngineFinal()", "UnloadInstance()");
  assert.match(body(windows, "void TellEngineFinal() const noexcept {"), /"\{\\"phase\\":\\"final\\",\\"reason\\":\\""[\s\S]*\\"waitMs\\":[\s\S]*\\"answer\\":\\"/);
});

test("a relaunch during the quit's wait cancels it, except an update's, and the windows asked for during the quit open then", () => {
  const windows = app("WindowManager.h");
  const arrived = body(windows, "void LaunchArrived() noexcept {");
  before(arrived, "if (m_quitReason == kUpdateQuit)", "CancelQuit()", "an update's quit is cancelled by a launch");
  assert.match(arrived, /if \(m_finished\) return;/);
  const open = body(windows, "void Open(OpenWindowRequest const &request, bool heldForTest = false) noexcept {");
  before(open, "if (m_quitting) {", "Find(request.id)", "Open() reaches a window before its quit check");
  assert.match(body(open, "if (m_quitting) {"), /m_opensDuringQuit\.push_back\(request\)/);
  assert.match(body(windows, "void CancelQuit() noexcept {"), /for \(auto const &request : remembered\) Open\(request, true\);/);
  assert.match(body(windows, "void Finish() noexcept {"), /m_opensDuringQuit\.clear\(\);/);
  const event = body(app("EngineHostModule.h"), "inline void OnEvent(");
  before(event, "WindowManager::Shared().LaunchArrived()", "EmitEvent(", "the quit is cancelled after the relaunch reaches the app's script");
});

test("an answer to a cancelled quit never finishes a later one", () => {
  const windows = app("WindowManager.h");
  before(body(windows, "void Quit(std::string_view reason) noexcept {"), "m_answersOwed++", 'EmitApp("willQuit")');
  const reply = body(windows, "void ReplyToTerminate(bool ok) noexcept {");
  before(reply, "if (m_answersOwed > 0) m_answersOwed--;", "Finish()");
  before(reply, "if (m_answersOwed > 0) {", "Finish()", "an earlier quit's answer can finish this one");
  assert.match(body(windows, "void AnswerTerminate(bool ok) noexcept {"), /"quitAnswerHoldMs"/);
  assert.match(body(app("WindowsModule.h"), "void replyToTerminate("), /AnswerTerminate\(ok\)/);
});

test("a launch that arrived after the last window closed holds the quit until its window opens, for at most 5 s", () => {
  const windows = app("WindowManager.h");
  assert.match(body(windows, "void Closed(std::string const &id) noexcept {"), /QuitWhenWindowless\(\)/);
  const windowless = body(windows, "void QuitWhenWindowless() noexcept {");
  before(windowless, "if (m_launchAwaitingWindow) {", "Quit(WindowlessQuitReason())");
  assert.match(windows, /kLaunchWindowWaitMs = 5000;/);
  before(body(windows, "void Open(OpenWindowRequest const &request, bool heldForTest = false) noexcept {"), "HoldOpenForTest(request)", "m_launchAwaitingWindow = 0;");
});

test("the engine cancels the quit for a launch while the app asks, ignores one during an update's quit, and never clears the exiting mark", () => {
  const main = engine("main.cc");
  const relaunched = body(main, "bool Relaunched(");
  before(relaunched, "if (quit.past_no_return) {", "EmitRelaunch(", "a launch past the point of no return reaches the app");
  before(relaunched, "quit.reason == kUpdateQuit", "EmitRelaunch(");
  assert.match(relaunched, /quit\.cancelled_by_launch\+\+;/);
  assert.ok(!main.includes("ClearExiting"), "something still clears the exiting mark");
  assert.ok(!engine("launch_guard.h").includes("ClearExiting"));
  const quitting = body(main, "void AppQuitting(");
  assert.match(quitting, /phase == "final"\) \{\s*PassPointOfNoReturn\(\);/);
  assert.match(body(main, "void PassPointOfNoReturn() {"), /MarkExiting\(\);/);
  assert.match(body(engine("host.cc"), "void Host::Call("), /verb == "app\.quitting"\) \{\s*AppQuitting\(Text\(args, "phase"\)/);
});

test("past the point of no return, Chromium's single-instance callback turns a launch away instead of taking it", () => {
  const patch = engineInput("patches/chromium-win-hand-off-refused-after-quit.patch");
  assert.match(patch, /^\+\+\+ b\/chrome\/browser\/chrome_browser_main\.cc$/m);
  assert.match(patch, /^\+bool \(\*g_ardia_win_refuses_hand_off\)\(\) = nullptr;$/m);
  assert.match(patch, /^\+  if \(g_ardia_win_refuses_hand_off && g_ardia_win_refuses_hand_off\(\)\) \{\n\+    return false;/m);
  assert.match(engineInput("series-win"), /^chromium chromium-win-hand-off-refused-after-quit\.patch$/m);
  assert.match(engineInput("accepted-patches.txt"), /^chromium-win-hand-off-refused-after-quit\.patch$/m);
  assert.match(engine("hooks.h"), /extern bool \(\*g_ardia_win_refuses_hand_off\)\(\);/);
  const main = engine("main.cc");
  assert.match(body(main, "void BeforeChromeMain() {"), /g_ardia_win_refuses_hand_off = &RefusesHandOff;/);
  assert.match(body(main, "bool RefusesHandOff() {"), /TheQuit\(\)\.past_no_return/);
});

test("the engine's quit closes every tab without asking it, and ends the process after the flush if Chromium still lingers", () => {
  const main = engine("main.cc");
  const quit = body(main, "void QuitApp() {");
  assert.match(quit, /chrome::ExitIgnoreUnloadHandlers\(\);/);
  assert.ok(!quit.includes("CloseAllBrowsersAndQuit"), "the quit can still be cancelled by a page");
  before(quit, "PostDelayedTask(", "chrome::ExitIgnoreUnloadHandlers()");
  const stalled = body(main, "void EndStalledQuit() {");
  before(stalled, "WriteLaunchLog(", "StopApp()", "a line is written after the flush's 'process ending'");
  before(stalled, "StopApp()", "TerminateCurrentProcessImmediately");
});

test("a launch Chromium turns away waits for the closing Ardia, then starts itself once with its own command line, folder and environment", () => {
  const main = engine("main.cc");
  assert.match(body(main, "void AfterChromeMain(int exit_code) {"), /exit_code == CHROME_RESULT_CODE_PROFILE_IN_USE\) \{\s*exit_code = AnswerTurnedAwayLaunch\(exit_code\);/);
  const turned = body(main, "int AnswerTurnedAwayLaunch(int exit_code) {");
  before(turned, "GuardFacts().restarted_after_refusal", "StartAgain(", "a restarted launch can restart again");
  before(turned, "FindQuittingOwner(&owner)", "WaitForOwnerToEnd(");
  before(turned, "WaitForOwnerToEnd(", "WaitForLockFileFree(");
  before(turned, "WaitForLockFileFree(", "StartAgain(");
  const afterWait = turned.slice(turned.indexOf("WaitForOwnerToEnd("));
  const restartBranch = afterWait.slice(afterWait.indexOf("WaitForLockFileFree("), afterWait.indexOf("return 0;"));
  assert.ok(!restartBranch.includes("WriteLaunchLog"), "the restart writes after the closing Ardia's 'process ending'");
  const again = body(main, "bool StartAgain(DWORD* process_id, DWORD* error) {");
  assert.match(again, /std::wstring command_line\(::GetCommandLineW\(\)\);/);
  assert.match(again, /CREATE_UNICODE_ENVIRONMENT, environment\.data\(\),\s*start\.directory\.empty\(\) \? nullptr : start\.directory\.c_str\(\)/);
  assert.match(body(main, "std::vector<wchar_t> EnvironmentForRestart() {"), /kRestartedAfterRefusalVariable\) \+ L"=1"/);
  const startup = body(main, "void BeforeChromeMain() {");
  before(startup, "RememberOwnStart()", "DecideTestGate(");
  before(startup, "::SetEnvironmentVariableW(kRestartedAfterRefusalVariable, nullptr);", "GuardBrowserLaunch(");
});

test("the guard publishes the profile's owner and writes its wait after the log rotation, so 'process ending' stays the closing Ardia's last line", () => {
  const guard = engine("launch_guard.cc");
  const launch = body(guard, "void GuardBrowserLaunch(");
  before(launch, "RotateLaunchLog();\n  WriteWaitingLines();", "WriteUnfinishedStarts(starts, next)");
  before(launch, "PublishOwner();", "RotateLaunchLog();");
  assert.ok(!body(guard, "bool WaitForExitingPredecessor(").includes("AppendLog("), "the guard's wait is written into the closing Ardia's log");
  assert.match(body(guard, "void ClaimGuard() {"), /PublishOwner\(\);/);
  const owner = body(guard, "bool FindQuittingOwner(QuittingOwner* owner) {");
  assert.match(owner, /ProcessCreated\(process\) != record\.created/);
  assert.match(owner, /owner->exiting = ::WaitForSingleObject\(exiting, 0\) == WAIT_OBJECT_0;/);
});

test("the quit's stretches are test-only keys, the update installer quits with its reason, and close-and-reopen runs every case", () => {
  const config = app("LaunchConfig.h");
  for (const key of ["quitWaitMs", "quitUnloadHoldMs", "quitFlushHoldMs", "handOffHoldMs", "lastWindowWaitMs", "windowOpenHoldMs", "quitReason", "quitByMessage", "quitAnswerHoldMs"]) {
    assert.ok(body(config, "TestKeys() noexcept {").includes(`"${key}"`), key);
  }
  assert.match(body(engine("main.cc"), "void HoldHandOffForTest() {"), /if \(!TheGate\(\)\.refusal\.empty\(\)\) \{\s*return;/);
  assert.match(read("../../../../packages/expo-windows/src/updater/index.ts"), /\?\.quit\("update"\)/);
  assert.match(body(app("WindowsModule.h"), "void quit(std::string reason, Promise promise) noexcept {"), /Quit\(reason\)/);
  const check = script("relaunch-check.ps1");
  assert.match(check, /\. \(Join-Path \$PSScriptRoot "relaunch-during-quit\.ps1"\)/);
  assert.match(check, /\n  Test-LaunchesDuringQuit\n/);
  const during = script("relaunch-during-quit.ps1");
  for (const step of [
    "Test-LaunchBeforeTheQuitBegins",
    "Test-LaunchAtTheQuitSeam",
    "Test-LaunchDuringTheQuitWait",
    "Test-LaunchDuringAnUpdateQuit",
    "Test-LateAnswerAfterACancelledQuit",
    "Test-LaunchAfterThePointOfNoReturn",
    "Test-LaunchTurnedAwayAfterThePointOfNoReturn",
    "Test-QuitWithABeforeUnloadPage",
    "Test-TurnedAwayLaunchKeepsItsUserDataDir",
    "Test-LaunchRefusedForGood",
  ]) {
    assert.match(during, new RegExp(`\\n    ${step}\\n`), step);
  }
});
