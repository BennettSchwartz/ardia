import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const reveals = read("../ios/ArdiaWebView+Reveals.mm");
const monitors = read("../ios/ArdiaWebView+InputMonitors.mm");
const tabsModule = read("../ios/TabsModule.swift");
const pressArea = read("../../../apps/browser/src/components/sidebar/TabPressArea.tsx");
const heldPress = read("../../../apps/browser/src/state/sidebar/heldTabPress.ts");
const tabReveal = read("../../../apps/browser/src/state/tabs/tabReveal.ts");

const body = (text, signature) => {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  assert.fail(`${signature} is not closed`);
};

test("the window's mouse monitor starts a row's reveal before anything else sees the press", () => {
  const install = body(monitors, "+ (void)installSwitchPrewarm");
  assert.ok(install.indexOf("[ArdiaWebView revealForPress:event]") >= 0);
  assert.ok(install.indexOf("[ArdiaWebView revealForPress:event]") < install.indexOf("[ArdiaWebView prewarmForMouseEvent:event]"));
  assert.match(install, /return event;/, "the press still goes on to the row");
});

test("only a plain single left press, while JS allows it, on a row of this window reveals its tab", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.match(press, /!gNativeTabSwitch/);
  assert.match(press, /event\.type != NSEventTypeLeftMouseDown/);
  assert.match(press, /event\.clickCount > 1/);
  assert.match(press, /event\.modifierFlags & kClickModifiers/);
  assert.match(press, /view\.window != window/);
  assert.match(press, /!view\.revealsFirst/);
  assert.ok(press.indexOf("dropRevealsInWindow:window except:view") < press.indexOf("[view revealAhead]"));
  assert.match(press, /view->_reveal\.native = YES;/);
  assert.match(press, /ArdiaFieldMarkNow\(key, @"nativeReveal"\)/);
  assert.match(press, /ArdiaFieldMarkAtCommit\(key, @"view"\)/);
  assert.match(reveals, /NSEventModifierFlagCommand \| NSEventModifierFlagOption \| NSEventModifierFlagShift \| NSEventModifierFlagControl/);
});

test("a press on a control inside the row, or anywhere but a tagged row, reveals nothing", () => {
  const key = body(reveals, "NSString *PressedTabKey(NSEvent *event)");
  const loop = key.slice(key.indexOf("for ("));
  assert.ok(loop.indexOf("TabSwitchKeyOf(view)") < loop.indexOf("IsRowControl(view)"), "the row itself is found before a control above it would stop the walk");
  assert.match(key, /view != content/);
  const control = body(reveals, "BOOL IsRowControl(NSView *view)");
  for (const kind of ["NSControl", "NSText", "NSAccessibilityButtonRole", "NSAccessibilityTextFieldRole", "NSAccessibilityTextAreaRole"]) assert.ok(control.includes(kind), kind);
  assert.match(body(reveals, "NSString *TabSwitchKeyOf(NSView *view)"), /hasPrefix:kTabSwitchTag/);
  assert.match(reveals, /kTabSwitchTag = @"tab-switch:"/);
});

test("a sleeping, closed, crashed, non-web or other profile's page is never shown ahead of JS", () => {
  const first = body(reveals, "- (BOOL)revealsFirst");
  for (const guard of ["_tab.closed", "_tab.discarded", "_reports.crashed", "_life.closed()", "_visible", "_reveal.active", "_warm", "_standalone"]) assert.ok(first.includes(guard), guard);
  assert.match(first, /hasPrefix:@"https:"/);
  assert.match(first, /other->_tab\.profile == _tab\.profile/);
});

test("a native reveal that is taken back is marked, and one JS settles is not", () => {
  const drop = body(reveals, "- (void)dropReveal");
  assert.ok(drop.indexOf('ArdiaFieldMarkNow(_transferKey, @"nativeRevealDropped")') < drop.indexOf("[self endReveal]"));
  assert.match(drop, /if \(_reveal\.native\)/);
  assert.match(body(reveals, "- (void)endReveal"), /_reveal\.native = NO;/);
});

test("JS tags rows, switches the native path with tab shares and takes back a press that doesn't switch", () => {
  assert.match(tabsModule, /Function\("setNativeTabSwitch"\) \{ \(enabled: Bool\) in ArdiaWebView\.setNativeTabSwitch\(enabled\) \}/);
  assert.match(pressArea, /nativeID=\{tabSwitchTag\(tab\.id\)\}/);
  assert.match(pressArea, /collapsable=\{false\}/);
  assert.match(tabReveal, /`tab-switch:\$\{tabId\}`/);
  assert.match(tabReveal, /tabShares/);
  assert.match(heldPress, /activeTabId\(useBrowser\.getState\(\), windowId\) !== tabId\) dropTabReveals\(tabId\)/);
});
