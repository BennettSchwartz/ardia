import assert from "node:assert/strict";
import test from "node:test";
import { designFor } from "./design.ts";

test("iPhone is always redesigned, Android takes Material You, and the lab's switch still gives Android the redesign", () => {
  assert.equal(designFor("ios"), "redesigned");
  assert.equal(designFor("android"), "material");
  assert.equal(designFor("android", true), "redesigned");
  assert.equal(designFor("ios", false), "redesigned");
});
