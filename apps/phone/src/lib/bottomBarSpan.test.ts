import assert from "node:assert/strict";
import test from "node:test";
import { barSpanCenter, bottomBarSpan } from "./bottomBarSpan.ts";

test("with no hinge every bottom bar pads by the larger side inset plus its own side, on both sides", () => {
  assert.deepEqual(bottomBarSpan(402, { left: 0, right: 0 }, "none", 24), { left: 24, right: 24 });
  assert.deepEqual(bottomBarSpan(852, { left: 59, right: 59 }, "none", 24), { left: 83, right: 83 });
  assert.deepEqual(bottomBarSpan(874, { left: 62, right: 0 }, "none", 24), { left: 86, right: 86 });
  assert.deepEqual(bottomBarSpan(1032, { left: 0, right: 0 }, "none", 24), { left: 24, right: 24 });
});

test("the closed Duo's bar runs edge to edge, 24 from both screen edges under the strip: 418 wide on its 466 screen", () => {
  const span = bottomBarSpan(466, { left: 0, right: 84 }, "closed", 24);
  assert.deepEqual(span, { left: 24, right: 24 });
  assert.equal(466 - span.left - span.right, 418);
});

test("the open Duo's bar is 400 wide at the bottom right, ending 12 before the strip, mirrors when the strip is on the left, and never comes nearer than 24 to the far edge", () => {
  const span = bottomBarSpan(951, { left: 0, right: 84 }, "fullyOpen", 24);
  assert.deepEqual(span, { left: 455, right: 96 });
  assert.equal(951 - span.left - span.right, 400);
  assert.equal(barSpanCenter(951, span), 655);
  assert.deepEqual(bottomBarSpan(951, { left: 84, right: 0 }, "fullyOpen", 24), { left: 96, right: 455 });
  assert.deepEqual(bottomBarSpan(620, { left: 0, right: 84 }, "fullyOpen", 24), { left: 124, right: 96 });
  assert.deepEqual(bottomBarSpan(600, { left: 0, right: 200 }, "fullyOpen", 24), { left: 24, right: 212 });
});
