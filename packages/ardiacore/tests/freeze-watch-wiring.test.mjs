import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const watch = readFileSync(new URL("../ios/ArdiaFreezeWatch.mm", import.meta.url), "utf8");

const body = (header, closer = "\n}\n") => {
  const start = watch.indexOf(header);
  assert.ok(start >= 0, `${header} is in ArdiaFreezeWatch.mm`);
  const end = watch.indexOf(closer, start);
  return watch.slice(start, end < 0 ? watch.length : end);
};

test("a loop that wakes with sharing off measures nothing: no busy span, no GC read", () => {
  const activity = body("void LoopActivity(");
  const wake = activity.slice(activity.indexOf("if (activity == kCFRunLoopAfterWaiting) {"), activity.indexOf("return;\n  }\n  ", activity.indexOf("kCFRunLoopAfterWaiting")));
  assert.match(wake, /const uint64_t epoch = gEpoch\.load\(/);
  assert.match(wake, /watch\.start\.store\(epoch \? now : 0,/, "the busy span starts only with a consent epoch");
  assert.match(wake, /watch\.gcAtStartMs = epoch && js && watch\.depth == 1 \? ReadGcMs\(watch\.runtime\) : -1;/, "GC time is read only with a consent epoch");
  assert.doesNotMatch(wake, /watch\.start\.store\(now,/);
});

test("an input noted with sharing off is dropped before it is stored", () => {
  const note = body("void ArdiaFreezeNoteInput(");
  const gate = note.indexOf("if (!gEpoch.load(std::memory_order_relaxed)) return;");
  assert.ok(gate > 0 && gate < note.indexOf("gInputs["), "the epoch check comes before the input ring is written");
});

test("the first input during a JS busy span is kept however many inputs follow it", () => {
  const note = body("void ArdiaFreezeNoteInput(");
  assert.match(note, /gJsFirstInputMs\.compare_exchange_strong\(noInputYet, eventMs,/, "only the first input of the span is stored");
  const activity = body("void LoopActivity(");
  assert.match(activity, /if \(js\) gJsFirstInputMs\.store\(-1,/, "a new span forgets the last span's first input");
  assert.match(activity, /gJsFirstInputMs\.exchange\(-1,/, "a span that ends takes its first input");
  assert.match(activity, /FirstInputWaitMs\(TicksToMs\(start\), endMs, earliestInputMs\)/);
  const first = body("double FirstInputWaitMs(");
  assert.match(first, /double first = earliestMs >= startMs && earliestMs <= endMs \? earliestMs : -1;/, "the kept first input counts when it falls in the span");
});
