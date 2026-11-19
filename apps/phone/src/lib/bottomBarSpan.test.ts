import assert from "node:assert/strict";
import test from "node:test";
import { barSpanCenter, besideStrip, bottomBarLayout, DUO_PLUS_ABOVE } from "./bottomBarSpan.ts";

test("with no hinge every bottom bar pads by the larger side inset plus its own side, on both sides, and nothing goes to a strip", () => {
  assert.deepEqual(bottomBarLayout(402, { left: 0, right: 0 }, "none", 24), { span: { left: 24, right: 24 }, strip: null });
  assert.deepEqual(bottomBarLayout(852, { left: 59, right: 59 }, "none", 24), { span: { left: 83, right: 83 }, strip: null });
  assert.deepEqual(bottomBarLayout(874, { left: 62, right: 0 }, "none", 24), { span: { left: 86, right: 86 }, strip: null });
  assert.deepEqual(bottomBarLayout(1032, { left: 0, right: 0 }, "none", 24), { span: { left: 24, right: 24 }, strip: null });
});

test("on the closed Duo the capsule runs from 24 to 12 short of the strip, 24 to 370 on its 466 screen, and Tabs and + stack in the strip 48 from the edge, + 55 above", () => {
  const { span, strip } = bottomBarLayout(466, { left: 0, right: 84 }, "closed", 24);
  assert.deepEqual(span, { left: 24, right: 96 });
  assert.equal(466 - span.left - span.right, 346);
  assert.deepEqual(strip, { side: "right", centerX: 418 });
  assert.equal(DUO_PLUS_ABOVE, 55);
  assert.deepEqual(besideStrip(strip!, 466, 250, 16), { right: 80, width: 250 });
  assert.deepEqual(besideStrip(strip!, 466, 400, 16), { right: 80, width: 370 });
});

test("on the open Duo the capsule is 400 wide ending 12 short of the strip, 455 to 855 on 951, with the same strip buttons", () => {
  const { span, strip } = bottomBarLayout(951, { left: 0, right: 84 }, "fullyOpen", 24);
  assert.deepEqual(span, { left: 455, right: 96 });
  assert.equal(951 - span.left - span.right, 400);
  assert.equal(barSpanCenter(951, span), 655);
  assert.deepEqual(strip, { side: "right", centerX: 903 });
  assert.deepEqual(bottomBarLayout(600, { left: 0, right: 200 }, "fullyOpen", 24).span, { left: 24, right: 212 });
});

test("a strip on the leading side mirrors it all", () => {
  assert.deepEqual(bottomBarLayout(466, { left: 84, right: 0 }, "closed", 24), { span: { left: 96, right: 24 }, strip: { side: "left", centerX: 48 } });
  assert.deepEqual(bottomBarLayout(951, { left: 84, right: 0 }, "fullyOpen", 24), { span: { left: 96, right: 455 }, strip: { side: "left", centerX: 48 } });
  assert.deepEqual(besideStrip({ side: "left", centerX: 48 }, 466, 250, 16), { left: 80, width: 250 });
  assert.equal(bottomBarLayout(466, { left: 0, right: 60 }, "closed", 24).strip!.centerX, 466 - 36);
});
