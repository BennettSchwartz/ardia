import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("every focus hand-off outcome is counted only if sharing hasn't changed since the hand-off began", () => {
  const source = read("../ios/FocusHandoff.swift");
  const calls = source.match(/outcomes\.(?:add|delivered)\(.*\)$/gm) ?? [];
  assert.ok(calls.length >= 5, `found ${calls.length} outcome calls`);
  for (const call of calls) assert.match(call, /since: /, call);
  assert.match(read("../ios/FocusModule.swift"), /Function\("setConsentEpoch"\)/);
});

test("the consent epoch is an opaque string, and nothing is counted before JS has set one", () => {
  const source = read("../ios/FocusHandoff.swift");
  assert.match(source, /func setConsentEpoch\(_ epoch: String\)/);
  assert.match(source, /var epoch = ""/);
  assert.match(source, /func add\(_ outcome: String, _ by: Int = 1, since epoch: String\)/);
  assert.match(source, /if !current\.isEmpty, epoch == current \{/);
  assert.doesNotMatch(source, /since epoch: Int/);
});

test("one setConsentEpoch call moves ArdiaCore's epoch, the hand-off counts and forgets earlier presses", () => {
  const module = read("../ios/FocusModule.swift");
  const call = module.match(/Function\("setConsentEpoch"\) \{ \(epoch: String\) in([^}]*)\}/)?.[1];
  assert.ok(call, "setConsentEpoch takes a String");
  assert.match(call, /ArdiaEvents\.consentEpoch = epoch/);
  assert.match(call, /FocusHandoff\.shared\.setConsentEpoch\(epoch\)/);
  assert.match(call, /PressRelease\.forgetPresses\(\)/);
  const area = read("../ios/ContextMenuArea.swift");
  const forget = area.slice(area.indexOf("static func forgetPresses"));
  assert.match(forget, /^static func forgetPresses\(\) \{\s*pressLock\.lock\(\)\s*presses = \(nil, nil\)\s*pressLock\.unlock\(\)/);
  assert.equal(area.match(/presses = /g)?.length, 2, "only the monitor and forgetPresses write the history");
});
