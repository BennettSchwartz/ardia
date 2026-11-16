import assert from "node:assert/strict";
import { test } from "node:test";
const { isScalerCrash, freshGuard, afterReports } = await import("./upscalingGuard.ts");

const frame = (symbol, image = "VideoToolbox") => ({ image, symbol });
const report = (overrides = {}) => ({ time: 2_000, fileTime: 2_100, process: "gpu", frames: [frame("-[VTFrameProcessor endSession]")], ...overrides });

test("a graphics process crash inside VideoToolbox's frame processor or super-resolution scaler is a scaler crash", () => {
  assert.equal(isScalerCrash(report()), true);
  assert.equal(isScalerCrash(report({ frames: [frame("-[VTLowLatencySuperResolutionScalerImplementation processWithParams:error:]")] })), true);
  assert.equal(isScalerCrash(report({ frames: [], exceptionFrames: [frame("-[VTFrameProcessor processWithCommandBuffer:parameters:]")] })), true);
});

test("hardware decoding, other processes and unsymbolized frames are not scaler crashes", () => {
  assert.equal(isScalerCrash(report({ frames: [frame("VTDecompressionSessionDecodeFrame")] })), false);
  assert.equal(isScalerCrash(report({ frames: [frame(undefined)] })), false);
  assert.equal(isScalerCrash(report({ process: "renderer" })), false);
  assert.equal(isScalerCrash(report({ process: "browser" })), false);
});

test("a new app version starts unsuspended and ignores crashes from before it launched", () => {
  const old = { appVersion: "0.2.46", since: 0, checkedUntil: 500, suspended: true };
  const guard = freshGuard(old, "0.2.47", 1_000);
  assert.deepEqual(guard, { appVersion: "0.2.47", since: 1_000, checkedUntil: 1_000, suspended: false });
  assert.equal(freshGuard(old, "0.2.46", 1_000), old);
  const { guard: after, scalerCrashes } = afterReports(guard, [report({ time: 900, fileTime: 950 })]);
  assert.equal(scalerCrashes, 0);
  assert.equal(after.suspended, false);
});

test("one scaler crash on this version suspends upscaling and moves the cursor past every report read", () => {
  const guard = freshGuard(null, "0.2.47", 1_000);
  const { guard: after, scalerCrashes } = afterReports(guard, [report({ process: "renderer", time: 1_500, fileTime: 3_000 }), report()]);
  assert.equal(scalerCrashes, 1);
  assert.equal(after.suspended, true);
  assert.equal(after.checkedUntil, 3_000);
  assert.equal(afterReports(after, []).guard.suspended, true);
});
