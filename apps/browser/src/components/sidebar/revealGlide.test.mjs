import assert from "node:assert/strict";
import { test } from "node:test";
import { glideOffsets, landingStart, stillOurs } from "./useRevealTabs.ts";
import { REVEAL_GLIDE } from "./tokens.ts";

test("a reveal glides from where the list is to the row, eased, and lands exactly", () => {
  assert.deepEqual(glideOffsets(100, 500, 0), { y: 100, done: false });
  const middle = glideOffsets(100, 500, REVEAL_GLIDE.duration / 2);
  assert.ok(Math.abs(middle.y - 300) < 1, `halfway is halfway on an even ease, got ${middle.y}`);
  assert.deepEqual(glideOffsets(100, 500, REVEAL_GLIDE.duration), { y: 500, done: true });
  assert.deepEqual(glideOffsets(100, 500, REVEAL_GLIDE.duration * 3), { y: 500, done: true });
  assert.deepEqual(glideOffsets(500, 100, REVEAL_GLIDE.duration), { y: 100, done: true });
});

test("a glide goes on while the list reports an offset it was sent, however late, and stops when the list is somewhere else", () => {
  const sent = [5, 30, 54, 112, 200, 320];
  assert.deepEqual(stillOurs(sent, 0, 0), sent, "six frames behind, still where the glide began");
  assert.deepEqual(stillOurs(sent, 0, 31), [54, 112, 200, 320], "offsets already reported are forgotten");
  assert.deepEqual(stillOurs(sent, 0, 320), [], "all caught up");
  assert.equal(stillOurs(sent, 0, 80), null, "an offset the glide never asked for: someone else scrolled");
  assert.equal(stillOurs([54, 112], 30, 4), null);
  assert.deepEqual(stillOurs([], 0, 999), [], "nothing sent, nothing to check");
});

test("a row more than two screens away is glided to from one screen short of it, a nearer one all the way", () => {
  assert.equal(landingStart(0, 1600, 800), null);
  assert.equal(landingStart(0, 1601, 800), 801);
  assert.equal(landingStart(9000, 300, 800), 1100);
  assert.equal(landingStart(0, 9000, 0), null, "before the list is laid out");
});
