import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const reveals = read("../ios/ArdiaWebView+Reveals.mm");
const monitors = read("../ios/ArdiaWebView+InputMonitors.mm");
const focus = read("../ios/ArdiaWebView+Focus.mm");
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
  assert.equal(install.includes("NSEventMaskKeyDown"), false, "keys follow the focus, nothing holds them");
  assert.match(install, /return event;/, "the press still goes on to the row");
});

test("only a plain single left press, while JS allows it, on a row of this window reveals its tab", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.match(press, /!gNativeTabSwitch\.load\(/);
  assert.match(reveals, /std::atomic<bool> gNativeTabSwitch/, "JS writes the flag off the main thread");
  assert.match(press, /event\.type != NSEventTypeLeftMouseDown/);
  assert.match(press, /event\.clickCount > 1/);
  assert.match(press, /event\.modifierFlags & kClickModifiers/);
  assert.match(press, /view\.window != window/);
  assert.match(press, /view\.revealsFirst/);
  assert.ok(press.indexOf("[view revealableOver:YES]") >= 0 && press.indexOf("[view revealableOver:YES]") < press.indexOf("dropRevealsInWindow:window except:view"), "nothing is dropped for a reveal that would be refused");
  assert.ok(press.indexOf("dropRevealsInWindow:window except:view") < press.indexOf("[view revealAhead]"));
  assert.match(body(reveals, "- (void)revealAhead"), /\[self revealableOver:NO\]/);
  const check = body(reveals, "- (ArdiaWebView *)revealableOver:(BOOL)pastOtherReveals");
  assert.match(check, /other->_reveal\.active && !pastOtherReveals/);
  assert.match(check, /NSEqualRects/);
  assert.match(press, /view->_reveal\.native = YES;/);
  assert.match(press, /ArdiaFieldMarkNow\(key, @"nativeReveal"\)/);
  assert.match(press, /ArdiaFieldMarkAtCommit\(key, @"view"\)/);
  assert.match(reveals, /NSEventModifierFlagCommand \| NSEventModifierFlagOption \| NSEventModifierFlagShift \| NSEventModifierFlagControl/);
});

test("a press on a control inside the row, or anywhere but a tagged row, reveals nothing", () => {
  const key = body(reveals, "NSString *PressedTabTag(NSEvent *event)");
  const loop = key.slice(key.indexOf("for ("));
  assert.ok(loop.indexOf("TabSwitchKeyOf(view)") < loop.indexOf("IsRowControl(view)"), "the row itself is found before a control above it would stop the walk");
  assert.match(key, /view != content/);
  assert.match(key, /window\.isKeyWindow \|\| \[hit acceptsFirstMouse:event\]/, "a click that only brings the window forward never reaches the row");
  const control = body(reveals, "BOOL IsRowControl(NSView *view)");
  for (const kind of ["NSControl", "NSText", "NSAccessibilityButtonRole", "NSAccessibilityTextFieldRole", "NSAccessibilityTextAreaRole"]) assert.ok(control.includes(kind), kind);
  assert.match(body(reveals, "NSString *TabSwitchKeyOf(NSView *view)"), /hasPrefix:kTabSwitchTag\] && !\[tag hasPrefix:kTabSelectedTag/);
  const reactTag = body(reveals, "NSString *ReactTagOf(NSView *view)");
  assert.match(reactTag, /@"nativeID", @"nativeId"/, "the old architecture spells it nativeID, Fabric nativeId");
  assert.match(reactTag, /isKindOfClass:NSString\.class\]\) return tag;/, "a nil nativeID still falls back to nativeId");
  assert.match(reveals, /kTabSwitchTag = @"tab-switch:"/);
});

test("pressing the shown tab's row takes back a native reveal still waiting for JS; a multi-selected row never starts one", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  const visible = press.indexOf("if (view->_visible) {");
  assert.ok(visible >= 0 && visible < press.indexOf("[tag hasPrefix:kTabSwitchTag]"), "the active row is tagged tab-switch, so visibility decides before the tag");
  assert.ok(press.slice(visible).indexOf("[ArdiaWebView dropNativeRevealsInWindow:window];") < press.slice(visible).indexOf("return NO;"));
  assert.match(press, /\[tag hasPrefix:kTabSwitchTag\] && view\.revealsFirst \? \[view revealableOver:YES\] : nil/);
  assert.match(body(reveals, "+ (void)dropNativeRevealsInWindow:(NSWindow *)window"), /other->_reveal\.native\) \[other dropReveal\]/);
  assert.match(reveals, /kTabSelectedTag = @"tab-selected:"/);
});

test("the keyboard moves to a page shown natively, and comes back when no switch follows", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.ok(press.indexOf("[view takeFocusFrom:shown]") > press.indexOf("view->_reveal.native = YES;"));
  const take = body(reveals, "- (void)takeFocusFrom:(ArdiaWebView *)shown");
  assert.match(take, /if \(!ResponderUnder\(window, _reveal\.loweredPane\)\) return;/, "only focus inside the page being covered moves");
  assert.ok(take.indexOf("[shown storePageFocusFrom:responder]") < take.indexOf("[self focusPage]"), "the outgoing tab remembers its focus before it moves");
  assert.match(take, /shown->_focus\.storedAtReveal = YES;/);
  assert.match(body(focus, "- (void)storePageFocus"), /if \(_focus\.storedAtReveal\) \{/, "hiding the outgoing tab keeps what it remembered at the reveal");
  const back = body(reveals, "- (void)giveFocusBack");
  assert.match(back, /owner->_visible && from\.window == window && focusStayedHere\) \[window makeFirstResponder:from\]/);
  const end = body(reveals, "- (void)endReveal");
  assert.ok(end.indexOf("[self giveFocusBack]") >= 0, "a drop, the backstop or a detach all give focus back");
  const settle = body(reveals, "- (void)settleRevealsInWindow");
  assert.ok(settle.indexOf("[self keepAtSettle]") < settle.indexOf("[self endReveal]"), "a switch JS commits keeps the focus where it went");
});

test("while a page is shown natively ahead of JS, hit testing follows the screen, and goes back when the reveal ends", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.ok(press.indexOf("[view takeHitTesting]") > press.indexOf("view->_reveal.native = YES;"));
  const take = body(reveals, "- (void)takeHitTesting");
  assert.match(take, /for \(NSView \*view = self\.superview; view && view != shared; view = view\.superview\)/);
  assert.match(take, /PointerEventsOf\(view\) == kPointerEventsNone\) OverridePointerEvents\(overridden, view, kPointerEventsAuto\)/, "the shown page's pane takes clicks, scrolls, hover and the cursor");
  assert.match(take, /OverridePointerEvents\(overridden, lowered, kPointerEventsNone\)/, "the covered page's pane takes none");
  const watch = body(reveals, "Class ReactViewClass()");
  assert.match(watch, /if \(!gWritingPointerEvents\) \[ReactPointerEvents\(\) removeObjectForKey:view\]/, "any value React sets while overridden is React's, and ends the override for that view");
  const back = body(reveals, "- (void)giveHitTestingBack");
  assert.match(back, /NSNumber \*requested = \[ReactPointerEvents\(\) objectForKey:view\];\n    if \(!requested\) continue;/, "a pane React set during the reveal, a sibling included, is left as React set it");
  assert.match(back, /WritePointerEvents\(view, requested\.integerValue\)/);
  assert.ok(body(reveals, "- (void)endReveal").indexOf("[self giveHitTestingBack]") >= 0, "settle, drop, backstop and detach all give back what React never took");
  assert.match(reveals, /respondsToSelector:NSSelectorFromString\(@"pointerEvents"\)/);
  assert.equal(monitors.includes("redirectsInput"), false, "no input is rerouted by hand");
});

test("a page pressed later stays on screen while JS catches up on the presses before it", () => {
  const settle = body(reveals, "- (void)settleRevealsInWindow");
  assert.match(settle, /pressedLater = window && !_reveal\.active \? \[ArdiaWebView nativeRevealInWindow:window except:self\] : nil;/);
  assert.ok(settle.indexOf("if ([pressedLater stayOver:self]) return;") < settle.indexOf("[self keepAtSettle]"), "the commit of an earlier press ends nothing");
  const stay = body(reveals, "- (BOOL)stayOver:(ArdiaWebView *)shown");
  assert.match(stay, /NSEqualRects/, "a page laid out elsewhere (a split) is never covered");
  assert.ok(stay.indexOf("[self giveHitTestingBack]") < stay.indexOf("_reveal.loweredPane = shownPane;"));
  assert.ok(stay.indexOf("lowered.layer.zPosition = _reveal.loweredPaneZ;") < stay.indexOf("_reveal.loweredPane = shownPane;"), "the pane covered until now gets its place back");
  assert.ok(stay.indexOf("shownPane.layer.zPosition = _reveal.loweredPaneZ - 1;") < stay.indexOf("[self takeHitTesting]"), "input follows the screen again");
  assert.match(body(reveals, "+ (ArdiaWebView *)nativeRevealInWindow:(NSWindow *)window except:(ArdiaWebView *)skip"), /other->_reveal\.active && other->_reveal\.native\) return other;/);
  const reveal = body(reveals, "+ (void)revealTab:(NSString *)transferKey");
  assert.match(reveal, /!view\.window \|\| \[ArdiaWebView nativeRevealInWindow:view\.window except:view\]\) return;/, "JS's own reveal of an earlier press doesn't take the screen back");
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
  assert.match(pressArea, /nativeID=\{tabPressTag\(tab\.id, selected\)\}/);
  assert.match(pressArea, /collapsable=\{false\}/);
  assert.match(tabReveal, /`\$\{selected \? "tab-selected" : "tab-switch"\}:\$\{tabId\}`/, "a multi-selected row switches on release, so it never reveals natively");
  assert.match(tabReveal, /tabShares/);
  assert.match(heldPress, /activeTabId\(useBrowser\.getState\(\), windowId\) !== tabId\) dropTabReveals\(tabId\)/);
});
