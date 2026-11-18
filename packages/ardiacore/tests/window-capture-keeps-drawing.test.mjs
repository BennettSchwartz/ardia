import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const body = (source, signature) => {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} is missing`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${signature} never closes`);
};

const CAPTURE = "../ios/ArdiaWindowCapture.mm";

test("a window that is being captured answers NO to Chrome's isOccluded, and any other window answers as it did", () => {
  assert.ok(existsSync(new URL(CAPTURE, import.meta.url)), "ArdiaWindowCapture.mm holds the shared windows");
  const source = read(CAPTURE);
  assert.match(source, /NSSelectorFromString\(@"isOccluded"\)/);
  assert.match(source, /class_getInstanceMethod\(NSWindow\.class, isOccluded\)/);
  assert.match(source, /method_getImplementation/, "a window nobody shares still asks the original isOccluded");
  assert.match(source, /dispatch_once/, "the swizzle is installed once");
  assert.match(source, /\^BOOL\(NSWindow \*\w+\)/, "the replacement takes the window it is asked about");
});

test("holding a window posts the occlusion notification, so Chrome re-checks at once, and never fakes occlusionState", () => {
  const source = read(CAPTURE);
  assert.match(source, /postNotificationName:NSWindowDidChangeOcclusionStateNotification/);
  assert.doesNotMatch(source, /ActOcclusion/, "ActOcclusion would corrupt ArdiaWindowFullScreen's occlusion bookkeeping");
  assert.doesNotMatch(source, /setImplementation:[^;]*occlusionState/);
});

test("the picker's approval of a window or screen source is kept, after the engine allows the capture", () => {
  const source = read("../ios/ArdiaWebView+PageMessages.mm");
  const resolve = body(source, "- (void)resolveDisplayMedia:");
  const allow = resolve.indexOf("allowDesktopCapture");
  const kept = resolve.indexOf("captureSource");
  assert.notEqual(allow, -1);
  assert.notEqual(kept, -1, "resolveDisplayMedia remembers the source it approved");
  assert.ok(kept > allow, "a source the engine refused is never kept");
  assert.match(resolve, /window:/, "the window id is read from the approved window: source");
  assert.match(resolve, /screen:/, "a whole-screen share holds every Ardia window");
});

test("the hold starts when the engine reports the share running, and lets go when it ends and when the page goes away", () => {
  const site = read("../ios/ArdiaWebView+Site.mm");
  const changed = body(site, "- (void)tab:(ArdiaCoreTab *)tab didChangeMediaAccess:");
  assert.match(changed, /HoldWindowsForCapture\(self, _reports\.captureSource\)/, "a share the page then fails is never held");
  assert.match(changed, /ReleaseWindowsForCapture/);
  assert.match(changed, /@"screen"/, "the engine's screen flag is the start and the end of a window or screen share");

  const view = read("../ios/ArdiaWebView.mm");
  assert.match(body(view, "- (void)dealloc"), /ReleaseWindowsForCapture/, "a page closed mid-share does not leave its window held");
});

test("the hold is declared next to the other window helpers and built with the app", () => {
  const header = read("../ios/ArdiaChromeWindowInternal.h");
  assert.match(header, /HoldWindowsForCapture/);
  assert.match(header, /ReleaseWindowsForCapture/);
});
