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
  before(body(windows, "void AnnounceCancelledQuit() noexcept {"), 'TellEngineQuitting("cancelled")', 'EmitApp("quitCancelled")');
  before(body(windows, "void Finish() noexcept {"), "TellEngineFinal()", "UnloadInstance()");
  assert.match(body(windows, "void TellEngineFinal() const noexcept {"), /"\{\\"phase\\":\\"final\\",\\"reason\\":\\""[\s\S]*\\"waitMs\\":[\s\S]*\\"answer\\":\\"/);
});

test("inside the hand-off message the app only reads and sets plain state; the rest runs after the message from a posted task", () => {
  const windows = app("WindowManager.h");
  const arriving = body(windows, "int LaunchArriving() noexcept {");
  before(arriving, "m_quitReason == kUpdateQuit && (m_quitting || m_finished)", "if (m_finished) return ARDIA_APP_LAUNCH_TURNED_AWAY;", "an update's quit turns a launch away into a waiting launch after Finish()");
  before(arriving, "m_launchesUndelivered++", "m_quitGeneration++");
  assert.match(arriving, /return ARDIA_APP_LAUNCH_KEPT_BY_CANCELLING_QUIT;/);
  for (const call of ["LaunchLog::", "After(", "Emit", "TellEngine", "Open(", "TryEnqueue", "Stop(", "CancelQuit(", "HoldQuitForLaunch(", "NoteQuitWait(", "Host::"]) {
    assert.ok(!arriving.includes(call), `LaunchArriving calls ${call} inside the sent message`);
  }
  const after = body(windows, "void AfterLaunchArriving() noexcept {");
  before(after, "AnnounceCancelledQuit()", "ArmLaunchHold()");
  assert.match(body(windows, "void AnnounceCancelledQuit() noexcept {"), /TellEngineQuitting\("cancelled"\);\s*EmitApp\("quitCancelled"\);/);
  assert.match(body(app("Ardia.cpp"), "__declspec(dllexport) int ArdiaAppLaunchArriving(void) {"), /WindowManager::Shared\(\)\.LaunchArriving\(\)/);
  assert.match(body(app("Ardia.cpp"), "__declspec(dllexport) void ArdiaAppAfterLaunchArriving(void) {"), /WindowManager::Shared\(\)\.AfterLaunchArriving\(\)/);
  assert.ok(!app("EngineHostModule.h").includes("LaunchArrived"), "the quit is still cancelled only when the relaunch event reaches the app");
  const takes = body(engine("main.cc"), "bool TakesHandOff() {");
  assert.match(takes, /PostTask\(\s*FROM_HERE, base::BindOnce\(&AfterLaunchTaken, answer\)\);/);
  assert.ok(!takes.includes("WriteLaunchLog("), "the engine writes the log inside the sent message");
  assert.match(body(engine("main.cc"), "void AfterLaunchTaken(int answer) {"), /app\.after_launch_arriving\(\);/);
  const open = body(windows, "void Open(OpenWindowRequest const &request, bool heldForTest = false) noexcept {");
  before(open, "if (m_quitting) {", "Find(request.id)", "Open() reaches a window before its quit check");
  assert.match(body(open, "if (m_quitting) {"), /m_opensDuringQuit\.push_back\(request\)/);
  assert.match(body(windows, "void Finish() noexcept {"), /m_opensDuringQuit\.clear\(\);/);
});

test("an update's quit takes and drops every launch while it can still answer, and a launch that meets it anywhere else ends at once instead of waiting", () => {
  const patch = engineInput("patches/chromium-win-hand-off-asks-the-app.patch");
  assert.match(patch, /^\+bool \(\*g_ardia_win_drops_hand_off\)\(\) = nullptr;$/m);
  assert.match(patch, /^\+  if \(g_ardia_win_drops_hand_off && g_ardia_win_drops_hand_off\(\)\) \{\n\+    return true;\n\+  \}\n\+#endif\n   if \(!g_browser_process \|\| g_browser_process->IsShuttingDown\(\)\) \{/m, "the drop must come before Chromium's own shutdown refusal");
  const main = engine("main.cc");
  assert.match(body(main, "bool DropsHandOff() {"), /quit\.reason != kUpdateQuit \|\| !\(quit\.asking \|\| quit\.past_no_return\)/);
  assert.match(body(main, "void BeforeChromeMain() {"), /g_ardia_win_drops_hand_off = &DropsHandOff;/);
  assert.match(body(main, "void AppQuitting("), /if \(quit\.reason == kUpdateQuit\) \{\s*MarkUpdating\(\);/);
  const startup = body(main, "void BeforeChromeMain() {");
  before(startup, "GuardBrowserLaunch(", "if (GuardFacts().update_under_way) {");
  assert.match(startup, /if \(GuardFacts\(\)\.update_under_way\) \{[\s\S]*?TerminateCurrentProcessImmediately\(0\);/);
  before(body(main, "int AnswerTurnedAwayLaunch(int exit_code) {"), "if (UpdateUnderWay()) {", "FindQuittingOwner(");
  before(body(engine("launch_guard.cc"), "void GuardBrowserLaunch("), "if (UpdateUnderWay()) {", "WaitForExitingPredecessor(", "a launch waits in the guard during an update's quit");
});

test("no quit begins while a taken launch hasn't reached the app, and a hold or cancel that leaves no window ends in a quit 5 s after the first launch", () => {
  const windows = app("WindowManager.h");
  before(body(windows, "void Quit(std::string_view reason) noexcept {"), "if (m_launchesUndelivered > 0 && LaunchHoldsQuit()) {", "m_quitting = true;");
  assert.match(body(windows, "void HoldQuitForLaunch() noexcept {"), /if \(!m_launchHoldSince\) m_launchHoldSince = GetTickCount64\(\);/, "a later launch extends the hold");
  const arm = body(windows, "void ArmLaunchHold() noexcept {");
  assert.match(arm, /if \(!since \|\| m_launchHoldArmedFor == since\) return;/);
  assert.match(arm, /\[this, since\]\(\) noexcept \{ LaunchHoldEnded\(since\); \}/);
  const ended = body(windows, "void LaunchHoldEnded(ULONGLONG since) noexcept {");
  before(ended, "if (m_launchHoldSince != since) return;", "Quit(kUserQuit)");
  assert.match(ended, /!m_hadWindow \|\| !NoWindowStays\(\)\) return;/);
  assert.match(body(windows, "void AnnounceCancelledQuit() noexcept {"), /if \(NoWindowStays\(\)\) HoldQuitForLaunch\(\);/);
  assert.match(body(windows, "void Closed(std::string const &id) noexcept {"), /QuitWhenWindowless\(\)/);
  before(body(windows, "void QuitWhenWindowless() noexcept {"), "if (LaunchHoldsQuit()) {", "Quit(WindowlessQuitReason())");
  assert.match(windows, /kLaunchWindowWaitMs = 5000;/);
  assert.match(body(windows, "void LaunchDelivered() noexcept {"), /m_launchesUndelivered--/);
});

test("the app counts the answers it owes, so an answer to a cancelled quit never finishes a later one", () => {
  const windows = app("WindowManager.h");
  before(body(windows, "void Quit(std::string_view reason) noexcept {"), "m_answersOwed++", 'EmitApp("willQuit")');
  const reply = body(windows, "void ReplyToTerminate(bool ok) noexcept {");
  before(reply, "if (m_answersOwed > 0) m_answersOwed--;", "Finish()");
  before(reply, "if (m_answersOwed > 0) {", "Finish()", "an earlier quit's answer can finish this one");
  assert.match(body(windows, "void Attach("), /m_answersOwed = 0;/);
  assert.match(body(app("WindowsModule.h"), "void replyToTerminate("), /AnswerTerminate\(ok\)/);
  assert.match(read("../state/app/nativeSync.ts"), /void answerQuitAfterSaves\(QUIT_SAVES_WAIT_MS, \(\) => replyToTerminate\(true\)\);/, "the willQuit branch the feedback thread edits stays as it was");
});

test("a process that never becomes the browser writes refused lines with its pid and never 'process ending'; the app's first line carries the pid", () => {
  const guard = engine("launch_guard.cc");
  const line = body(guard, "std::string LaunchLogLine(const std::string& text) {");
  before(line, "(state.owns_alive || state.became_browser) && !state.turned_away", '"engine 0 "');
  assert.match(line, /return "refused " \+ std::to_string\(since_start\) \+ " pid=" \+\s*std::to_string\(::GetCurrentProcessId\(\)\) \+ " " \+ text \+ "\\n";/);
  assert.match(body(guard, "void AppendLog("), /LaunchLogLine\(line\)/);
  const main = engine("main.cc");
  assert.match(body(main, "void WriteLaunchLog("), /LaunchLogLine\(line\)/);
  assert.match(body(main, "void PostBrowserStart() override {"), /^\s*void PostBrowserStart\(\) override \{\s*NoteBecameBrowser\(\);/);
  assert.match(body(main, "int AnswerTurnedAwayLaunch(int exit_code) {"), /^int AnswerTurnedAwayLaunch\(int exit_code\) \{\s*NoteTurnedAway\(\);/);
  const cpp = app("Ardia.cpp");
  assert.match(cpp, /L"process started inside the engine" : L"process started"\)\.append\(L" pid="\)/);
  assert.match(cpp, /LaunchLog::Write\(L"launch", L"process ending"\);/, "the line the reopen checks count changed");
});

test("the engine asks the app inside Chromium's single-instance callback, after its own drops, and delivers taken launches in order", () => {
  const patch = engineInput("patches/chromium-win-hand-off-asks-the-app.patch");
  assert.match(patch, /^\+\+\+ b\/chrome\/browser\/chrome_browser_main\.cc$/m);
  assert.match(patch, /^\+bool \(\*g_ardia_win_takes_hand_off\)\(\) = nullptr;$/m);
  assert.match(patch, /^\+  if \(g_ardia_win_takes_hand_off && !g_ardia_win_takes_hand_off\(\)\) \{\n\+    return false;\n\+  \}\n\+#endif\n   return base::SingleThreadTaskRunner::GetCurrentDefault\(\)->PostTask\(/m);
  assert.match(engineInput("series-win"), /^chromium chromium-win-hand-off-asks-the-app\.patch$/m);
  assert.match(engineInput("accepted-patches.txt"), /^chromium-win-hand-off-asks-the-app\.patch$/m);
  assert.match(engine("hooks.h"), /extern bool \(\*g_ardia_win_takes_hand_off\)\(\);/);
  const main = engine("main.cc");
  assert.match(body(main, "void BeforeChromeMain() {"), /g_ardia_win_takes_hand_off = &TakesHandOff;/);
  const takesHandOff = body(main, "bool TakesHandOff() {");
  before(takesHandOff, "quit.past_no_return", "app.launch_arriving()");
  before(takesHandOff, "app.launch_arriving()", "quit.answers.push_back(answer);");
  const relaunched = body(main, "bool Relaunched(");
  before(relaunched, "quit.answers.pop_front();", "DeliverLaunch(");
  const deliver = body(main, "void DeliverLaunch(");
  before(deliver, "if (TheQuit().past_no_return) {", "app.launch_delivered()");
  before(deliver, "app.launch_delivered()", "EmitRelaunch(");
  assert.ok(!main.includes("ClearExiting") && !engine("launch_guard.h").includes("ClearExiting"), "something still clears the exiting mark");
  assert.match(body(main, "void AppQuitting("), /phase == "final"\) \{\s*PassPointOfNoReturn\(\);/);
  assert.match(body(main, "void PassPointOfNoReturn() {"), /MarkExiting\(\);/);
});

test("the engine's quit closes every tab without asking it, and nothing forces the process down", () => {
  const main = engine("main.cc");
  const quit = body(main, "void QuitApp() {");
  assert.match(quit, /chrome::ExitIgnoreUnloadHandlers\(\);/);
  assert.ok(!quit.includes("CloseAllBrowsersAndQuit"), "the quit can still be cancelled by a page");
  assert.ok(!main.includes("EndStalledQuit") && !quit.includes("PostDelayedTask("), "a forced exit can end the process before Chromium's own data is written");
});

test("a turned-away launch starts itself once: after the closing Ardia ends, at once when that Ardia is gone or a healthy one holds the profile", () => {
  const main = engine("main.cc");
  assert.match(body(main, "void AfterChromeMain(int exit_code) {"), /exit_code == CHROME_RESULT_CODE_PROFILE_IN_USE\) \{\s*exit_code = AnswerTurnedAwayLaunch\(exit_code\);/);
  const turned = body(main, "int AnswerTurnedAwayLaunch(int exit_code) {");
  before(turned, "GuardFacts().restarted_after_refusal", "StartAgain(", "a restarted launch can restart again");
  before(turned, "if (owner_found && owner.exiting) {", "WaitForOwnerToEnd(");
  assert.equal((turned.match(/FailTurnedAwayLaunch\(/g) ?? []).length, 3, "only a second refusal, a wait that ran out and a failed start end in an error");
  assert.ok(!turned.includes("Another program or another computer is using Ardia's profile folder, so Ardia couldn't open it."), "a launch whose predecessor is gone still ends in an error");
  const again = body(main, "bool StartAgain(DWORD* process_id, DWORD* error) {");
  assert.match(again, /std::wstring command_line\(::GetCommandLineW\(\)\);/);
  assert.match(again, /CREATE_UNICODE_ENVIRONMENT, environment\.data\(\),\s*start\.directory\.empty\(\) \? nullptr : start\.directory\.c_str\(\)/);
  assert.match(body(main, "std::vector<wchar_t> EnvironmentForRestart() {"), /kRestartedAfterRefusalVariable\) \+ L"=1"/);
  const startup = body(main, "void BeforeChromeMain() {");
  before(startup, "RememberOwnStart()", "DecideTestGate(");
  before(startup, "command_line->RemoveSwitch(kRestartedAfterRefusalSwitch);", "GuardBrowserLaunch(");
  assert.match(body(engine("launch_guard.cc"), "void GuardBrowserLaunch("), /if \(state\.facts\.restarted_after_refusal\) \{\s*command_line->AppendSwitch\(kRestartedAfterRefusalSwitch\);/, "the restart bound is lost when the copy de-elevates");
});

test("the guard publishes the owner only once its launch has started, and writes its wait after the log rotation", () => {
  const guard = engine("launch_guard.cc");
  const launch = body(guard, "void GuardBrowserLaunch(");
  assert.ok(!launch.includes("PublishOwner"), "a launch that fails publishes itself as the profile's owner");
  before(launch, "RotateLaunchLog();\n  WriteWaitingLines();", "WriteUnfinishedStarts(starts, next)");
  assert.ok(!body(guard, "bool WaitForExitingPredecessor(").includes("AppendLog("), "the guard's wait is written into the closing Ardia's log");
  assert.match(body(engine("main.cc"), "void PostBrowserStart() override {"), /PublishOwnerIfOwned\(\);/);
  assert.match(body(guard, "void ClaimGuard() {"), /PublishOwner\(\);/);
  const owner = body(guard, "bool FindQuittingOwner(QuittingOwner* owner) {");
  assert.match(owner, /ProcessCreated\(process\) != record\.created/);
  assert.match(owner, /owner->exiting = ::WaitForSingleObject\(exiting, 0\) == WAIT_OBJECT_0;/);
});

test("the quit's stretches are test-only keys, the update installer quits with its reason, and close-and-reopen runs every case", () => {
  const config = app("LaunchConfig.h");
  for (const key of ["quitWaitMs", "quitUnloadHoldMs", "quitFlushHoldMs", "handOffHoldMs", "handOffDeliveryHoldMs", "lastWindowWaitMs", "windowOpenHoldMs", "quitReason", "quitByMessage", "quitAnswerHoldMs"]) {
    assert.ok(body(config, "TestKeys() noexcept {").includes(`"${key}"`), key);
  }
  assert.match(body(engine("main.cc"), "int TestMillisecondsFromEnvironment("), /if \(!TheGate\(\)\.refusal\.empty\(\)\) \{\s*return 0;/);
  assert.match(read("../../../../packages/expo-windows/src/updater/index.ts"), /\?\.quit\("update"\)/);
  assert.match(body(app("WindowsModule.h"), "void quit(std::string reason, Promise promise) noexcept {"), /Quit\(reason\)/);
  const check = script("relaunch-check.ps1");
  assert.match(check, /\. \(Join-Path \$PSScriptRoot "relaunch-during-quit\.ps1"\)/);
  assert.match(check, /\n  Test-LaunchesDuringQuit\n/);
  const during = script("relaunch-during-quit.ps1");
  const steps = [
    "Test-LaunchBeforeTheQuitBegins",
    "Test-LaunchAtTheQuitSeam",
    "Test-LaunchDuringTheQuitWait",
    "Test-LaunchTakenInTheTurnOfTheAnswer",
    "Test-LaunchDuringAnUpdateQuit",
    "Test-LateAnswerAfterACancelledQuit",
    "Test-CancelWhoseWindowNeverOpens",
    "Test-LaunchAfterThePointOfNoReturn",
    "Test-LaunchTurnedAwayAfterThePointOfNoReturn",
    "Test-TurnedAwayWhosePredecessorIsGone",
    "Test-QuitWithABeforeUnloadPage",
    "Test-TurnedAwayLaunchKeepsItsUserDataDir",
    "Test-LaunchRefusedForGood",
  ];
  for (const step of steps) assert.match(during, new RegExp(`\\n    ${step}\\n`), step);
  assert.match(during, new RegExp(`${steps.length} cases in`));
  assert.match(during, /\[QuitPages\]::LoadsOf\(\$name\)/, "a link counts as opened by its loads on the test server");
});
