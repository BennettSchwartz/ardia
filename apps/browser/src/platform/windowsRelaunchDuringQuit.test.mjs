import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = (name) => read(`../../windows/Ardia/${name}`);
const engine = (name) => read(`../../../../scripts/windows/engine/src/ardia/win/${name}`);
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

test("the app tells the engine a quit began before it asks the page to save, and that it stopped when it is cancelled", () => {
  const windows = app("WindowManager.h");
  const quit = body(windows, "void Quit() noexcept {");
  assert.ok(quit.indexOf("TellEngineQuitting(true)") > 0);
  assert.ok(quit.indexOf("TellEngineQuitting(true)") < quit.indexOf('EmitApp("willQuit")'));
  assert.ok(quit.indexOf("TellEngineQuitting(true)") < quit.indexOf("Finish()"));
  const reply = body(windows, "void ReplyToTerminate(bool ok) noexcept {");
  assert.match(reply, /if \(!m_quitting \|\| m_finished\) return;/);
  assert.ok(reply.indexOf("TellEngineQuitting(false)") < reply.indexOf('EmitApp("quitCancelled")'));
  assert.match(body(windows, "static void TellEngineQuitting(bool quitting) noexcept {"), /engine->hostCall\("app\.quitting"/);
});

test("a quitting app opens, refocuses and restores no window", () => {
  const windows = app("WindowManager.h");
  for (const signature of ["void Open(OpenWindowRequest const &request) noexcept {", "void Focus(std::string_view id) noexcept {", "void RestoreFullScreen("]) {
    const whole = body(windows, signature);
    const opening = whole.slice(whole.indexOf("{"));
    const guard = opening.indexOf("if (m_quitting)");
    assert.ok(guard > 0, `${signature} has no quit guard`);
    for (const shows of ["Find(", ".Show(", "Focus(", "SetPresenter("]) {
      const at = opening.indexOf(shows);
      if (at >= 0) assert.ok(guard < at, `${signature} reaches ${shows} before its quit guard`);
    }
  }
});

test("the engine marks the profile exiting when the app's quit begins and clears it when the quit is cancelled", () => {
  assert.match(body(engine("host.cc"), "void Host::Call("), /verb == "app\.quitting"\) \{\s*AppQuitting\(args\.FindBool\("quitting"\)\.value_or\(false\)\);/);
  const quitting = body(engine("main.cc"), "void AppQuitting(bool quitting) {");
  assert.ok(quitting.indexOf("MarkExiting()") > 0 && quitting.indexOf("MarkExiting()") < quitting.indexOf("ClearExiting()"));
  assert.match(quitting, /if \(held > 0\) \{\s*EmitRelaunch\(links\);/);
});

test("a launch that reaches a quitting Ardia is held, not handed to the app, and started again as the process's last act", () => {
  const main = engine("main.cc");
  const relaunched = body(main, "bool Relaunched(");
  const held = relaunched.indexOf("HoldLaunchForReplay(");
  assert.ok(held > 0);
  assert.ok(held < relaunched.indexOf("ClearExiting()") && held < relaunched.indexOf("EmitRelaunch("), "a held launch neither clears the exiting mark nor reaches the app");
  const after = body(main, "void AfterChromeMain(int exit_code) {");
  assert.ok(after.indexOf("ReplayHeldLaunches()") < after.indexOf("TerminateCurrentProcessImmediately"));
  assert.ok(after.indexOf("AnswerRefusedLaunch(") < after.indexOf("TerminateCurrentProcessImmediately"));
  assert.match(after, /exit_code == CHROME_RESULT_CODE_PROFILE_IN_USE/);
  assert.match(body(main, "void ReplayHeldLaunches() {"), /ReplayedLaunchValue\(kReplayedFromQuittingApp, quit\.held_launches\)/);
  for (const marks of ["void QuitApp() {", "void PostMainMessageLoopRun() override {"]) assert.match(body(main, marks), /TheQuit\(\)\.engine_quitting = true;/, marks);
});

test("a launch Chromium refuses is started again once after the last Ardia ends, or fails with a reason, never silently", () => {
  const refused = body(engine("main.cc"), "int AnswerRefusedLaunch(int exit_code) {");
  assert.match(refused, /facts\.replayed_from != kReplayedAfterRefusal/);
  assert.match(refused, /LetGoOfGuard\(\);[\s\S]*StartCopyOfArdia\(/);
  assert.match(refused, /CountRefusedStart\(\);[\s\S]*WriteLaunchLog\("app start failed: "[\s\S]*ShowStartFailure\(/);
});

test("the replay switch is read before a launch that isn't the guard's owner returns, and passed on to a de-elevated copy", () => {
  const guard = body(engine("launch_guard.cc"), "void GuardBrowserLaunch(");
  assert.ok(guard.indexOf("ReadReplayedLaunch(") < guard.indexOf("if (!primary)"));
  assert.ok(guard.indexOf("RemoveSwitch(kReplayedLaunchSwitch)") < guard.indexOf("if (!primary)"));
  assert.match(body(guard, "if (HandsOverToDeElevatedCopy(*command_line)) {"), /AppendSwitchASCII\(\s*kReplayedLaunchSwitch/);
});

test("the quit stretches are test-only keys, and close-and-reopen runs the launches during a quit", () => {
  const config = app("LaunchConfig.h");
  for (const key of ["quitWaitMs", "quitUnloadHoldMs", "quitFlushHoldMs", "handOffHoldMs"]) assert.ok(body(config, "TestKeys() noexcept {").includes(`"${key}"`), key);
  assert.match(body(engine("main.cc"), "void HoldHandOffForTest() {"), /if \(!TheGate\(\)\.refusal\.empty\(\)\) \{\s*return;/);
  const check = script("relaunch-check.ps1");
  assert.match(check, /\. \(Join-Path \$PSScriptRoot "relaunch-during-quit\.ps1"\)/);
  assert.match(check, /\n  Test-LaunchesDuringQuit\n/);
  const during = script("relaunch-during-quit.ps1");
  for (const phase of ["test: the quit waits", "test: the engine is asked to quit", "test: the flush is held"]) assert.ok(during.includes(`'${phase}'`), phase);
  for (const step of ["Test-LaunchHandedToQuittingArdia", "Test-LaunchRefusedByAnEndingArdia", "Test-LaunchRefusedForGood"]) assert.match(during, new RegExp(`\\n    ${step}\\n`), step);
});
