import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("ArdiaCore holds the consent epoch JS sets, empty until JS has set one", () => {
  assert.match(read("../ios/ArdiaEvents.h"), /@property\(class, nonatomic, copy\) NSString \*consentEpoch;/);
  const events = read("../ios/ArdiaEvents.mm");
  assert.match(events, /NSString \*gConsentEpoch = @"";/);
  assert.match(events, /\+ \(NSString \*\)consentEpoch \{\s*os_unfair_lock_lock\(&gConsentEpochLock\);/);
  assert.match(events, /\+ \(void\)setConsentEpoch:\(NSString \*\)epoch \{\s*NSString \*copied = \[epoch copy\] \?: @"";\s*os_unfair_lock_lock\(&gConsentEpochLock\);/);
});

test("a press loop is stamped with the epoch when its outermost loop begins, and its report sends that stamp", () => {
  const focusState = read("../ios/ArdiaFocusState.mm");
  assert.match(focusState, /PointerTrace\(\)\.BeginLoop\(name\.UTF8String \?: "unnamed", Uptime\(\), ArdiaEvents\.consentEpoch\.UTF8String \?: ""\)/);
  assert.match(focusState, /@"epoch" : @\(epoch\.c_str\(\)\)/);
  assert.doesNotMatch(focusState, /seconds/);
  const trace = read("../ios/ArdiaPointerTrace.h");
  assert.match(trace, /unsigned long BeginLoop\(const std::string &name, double now, const std::string &epoch\)/);
  assert.match(trace, /bool EndLoop\(double now, std::string \*longName, std::string \*epoch\)/);
  assert.match(trace, /bool TakeLongLoop\(unsigned long generation, double now, std::string \*name, std::string \*epoch\)/);
  assert.doesNotMatch(trace, /double \*seconds/);
});

test("a paint check is stamped with the epoch when it is scheduled, and its record sends that stamp", () => {
  const probe = read("../ios/ArdiaPaintProbe.mm");
  const schedule = probe.slice(probe.indexOf("void SchedulePaintCheck"), probe.indexOf("NSString *PaintProbeLine"));
  assert.ok(schedule.indexOf("NSString *epoch = ArdiaEvents.consentEpoch;") >= 0, "SchedulePaintCheck reads the epoch");
  assert.ok(schedule.indexOf("NSString *epoch = ArdiaEvents.consentEpoch;") < schedule.indexOf("dispatch_after"), "the epoch is read before the check is deferred");
  assert.match(schedule, /CheckPainting\(checked, trigger, epoch\)/);
  assert.match(probe, /@"epoch" : epoch,/);
  assert.doesNotMatch(probe, /@"seconds"/);
});
