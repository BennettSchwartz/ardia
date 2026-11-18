import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const reveals = read("../ios/ArdiaWebView+Reveals.mm");
const input = read("../ios/ArdiaWebView+RevealInput.mm");
const presses = read("../ios/ArdiaTabPresses.mm");
const painting = read("../ios/ArdiaWebView+Painting.mm");
const tabFile = read("../ios/ArdiaWebView+Tab.mm");
const timing = read("../ios/ArdiaFieldTiming.mm");
const monitors = read("../ios/ArdiaWebView+InputMonitors.mm");
const focus = read("../ios/ArdiaWebView+Focus.mm");
const tabsModule = read("../ios/TabsModule.swift");
const pressArea = read("../../../apps/browser/src/components/sidebar/TabPressArea.tsx");
const heldPress = read("../../../apps/browser/src/state/sidebar/heldTabPress.ts");
const tabReveal = read("../../../apps/browser/src/state/tabs/tabReveal.ts");
const toolbar = read("../../../apps/browser/src/components/toolbar/Toolbar.tsx");
const sidebarField = read("../../../apps/browser/src/components/sidebar/AddressBar.tsx");

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
  assert.match(install, /NSEventMaskLeftMouseDown \| NSEventMaskLeftMouseUp/, "the release reaches it too, for the rollback");
  assert.equal(install.includes("NSEventMaskKeyDown"), false, "keys follow the focus, nothing holds them");
  assert.match(install, /return event;/, "the press still goes on to the row");
});

test("only a plain single left press, while JS allows it, on a row of this window reveals its tab", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.match(press, /!gNativeTabSwitch\.load\(/);
  assert.match(reveals, /std::atomic<bool> gNativeTabSwitch/, "JS writes the flag off the main thread");
  assert.match(press, /event\.type != NSEventTypeLeftMouseDown/);
  assert.match(press, /event\.clickCount > 1 \|\| \(event\.modifierFlags & kClickModifiers\)/);
  assert.match(press, /view\.window != window/);
  assert.match(press, /view\.revealsFirst/);
  assert.ok(press.indexOf("[view revealableOver:YES]") >= 0 && press.indexOf("[view revealableOver:YES]") < press.indexOf("replaceRevealsInWindow:window with:view"), "nothing is ended for a reveal that would be refused");
  assert.ok(press.indexOf("replaceRevealsInWindow:window with:view") < press.indexOf("[view revealAhead]"));
  assert.match(body(reveals, "- (void)revealAhead"), /\[self revealableOver:NO\]/);
  const check = body(reveals, "- (ArdiaWebView *)revealableOver:(BOOL)pastOtherReveals");
  assert.match(check, /other->_reveal\.active && !pastOtherReveals/);
  assert.match(check, /NSEqualRects/);
  assert.match(press, /view->_reveal\.native = YES;/);
  assert.match(press, /ArdiaFieldMarkNow\(key, @"nativeReveal"\)/);
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
  const reactTag = body(input, "NSString *ReactTagOf(NSView *view)");
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

test("the address and the page's other identity are hidden while a page shown ahead of JS takes input", () => {
  const take = body(input, "- (void)takeInputIfShown");
  assert.ok(take.indexOf("[self hidePageIdentity]") < take.indexOf("[self takeHitTesting]"), "the address goes before a click can land");
  assert.ok(take.indexOf("[self hidePageIdentity]") < take.indexOf("[self takeFocusFrom:covered]"), "and before a key can");
  const hide = body(input, "- (void)hidePageIdentity");
  assert.match(hide, /CollectPageIdentity\(content, found\)/, "every tagged view of the window: toolbar, auto-hide toolbar, sidebar field");
  assert.match(hide, /view\.alphaValue = 0;/);
  assert.match(hide, /setDisableActions:YES/, "in the same frame, no fade");
  assert.match(input, /kPageIdentityTag = @"page-identity"/);
  const back = body(input, "- (void)giveInputBack");
  assert.ok(back.includes("[self showPageIdentity]"));
  assert.ok(body(reveals, "- (void)endReveal").includes("[self giveInputBack]"), "settle, drop, backstop and detach all show it again");
  const stay = body(reveals, "- (BOOL)stayOver:(ArdiaWebView *)shown");
  assert.match(stay, /\[self hidePageIdentityAfterMount\]/, "an earlier press's commit renames the toolbar under the page on screen: still hidden");
  assert.match(tabReveal, /PAGE_IDENTITY_TAG = PLATFORM_FEATURES\.nativeTabSwitch \? "page-identity" : undefined/);
  assert.match(toolbar, /<View nativeID=\{PAGE_IDENTITY_TAG\} collapsable=\{false\} pointerEvents="box-none" style=\{StyleSheet\.absoluteFill\}>\s*\{tab\.url \? \(\s*<ToolbarUrlField/, "the field holds the address, the lock, the capture and pop-up marks");
  assert.match(sidebarField, /nativeID=\{PAGE_IDENTITY_TAG\}\s*collapsable=\{false\}/);
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.match(press, /isEqualToString:kSmallWindow\] \|\| TypingOutsidePages\(window\) \|\| ArdiaTabInSplit\(key\)\) return NO;/, "Little Ardia, an open address field and split rows keep the JS path");
  assert.match(tabReveal, /!Object\.keys\(useMedia\.getState\(\)\.tabShares\)\.length && !popoverOpen\(\)/, "a page popover names the page under it");
});

test("input follows pixels: nothing moves to a page still waiting for its first frame", () => {
  const take = body(input, "- (void)takeInputIfShown");
  assert.match(take, /_reveal\.inputTaken \|\| _frameHold\.awaiting \|\| self\.alphaValue < 1\) return;/);
  assert.match(take, /ArdiaFieldMarkAtCommit\(_transferKey, @"view"\)/, "the view mark is the frame the page is on screen");
  const paint = body(painting, "- (void)applyPainting");
  assert.ok(paint.indexOf("[self takeInputIfShown]") > paint.indexOf("[CATransaction commit]"), "once the hold ends, the same paint hands input over");
  assert.ok(body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event").includes("[view takeInputIfShown]"));
});

test("the keyboard moves to a page shown natively, comes back when no switch follows, and never goes to a page under it", () => {
  const take = body(input, "- (void)takeFocusFrom:(ArdiaWebView *)shown");
  assert.match(take, /if \(!ResponderUnder\(window, _reveal\.loweredPane\)\) return;/, "only focus inside the page being covered moves");
  assert.ok(take.indexOf("[shown storePageFocusFrom:responder]") < take.indexOf("[self focusPage]"), "the outgoing tab remembers its focus before it moves");
  assert.match(take, /shown->_focus\.storedAtReveal = YES;/);
  assert.match(take, /if \(ResponderUnder\(window, self\)\) ArdiaFieldMarkNow\(_transferKey, @"nativeRevealFocus"\)/, "counted only when the page is the first responder");
  assert.match(body(focus, "- (void)storePageFocus"), /if \(_focus\.storedAtReveal\) \{/, "hiding the outgoing tab keeps what it remembered at the reveal");
  const back = body(input, "- (void)giveFocusBack");
  assert.match(back, /if \(!window \|\| !owner->_visible \|\| !focusStayedHere\) return;/);
  assert.match(back, /if \(from && from\.window == window\) \[window makeFirstResponder:from\];\n  else \[owner focusPage\];/);
  assert.match(body(reveals, "- (BOOL)stayOver:(ArdiaWebView *)shown"), /\[self moveFocusOwnerTo:shown\]/, "a drop gives the keyboard to the page then under it");
  const settle = body(reveals, "- (void)settleRevealsInWindow");
  assert.ok(settle.indexOf("[self keepAtSettle]") < settle.indexOf("[self endReveal]"), "a switch JS commits keeps the focus where it went");
  const restore = body(focus, "- (void)restoreFocusIfDue");
  assert.ok(restore.indexOf("if (self.underNativeReveal) {") < restore.indexOf("[self focusPage]"), "an earlier press's activation doesn't pull keys under the page on screen");
  assert.match(body(focus, "- (void)focusAfterLoad"), /_visible && !self\.underNativeReveal/);
  assert.match(body(focus, "+ (BOOL)focusVisiblePageIn:(NSWindow *)window"), /view->_reveal\.active && view->_reveal\.inputTaken\) \{\n      \[view focusPage\];/);
  assert.match(body(input, "- (BOOL)underNativeReveal"), /other->_reveal\.active && other->_reveal\.inputTaken\) return YES;/);
});

test("while a page is shown natively ahead of JS, hit testing follows the screen, and goes back when the reveal ends", () => {
  const take = body(input, "- (void)takeHitTesting");
  assert.match(take, /for \(NSView \*view = self\.superview; view && view != shared; view = view\.superview\)/);
  assert.match(take, /PointerEventsOf\(view\) == kPointerEventsNone\) OverridePointerEvents\(overridden, view, kPointerEventsAuto\)/, "the shown page's pane takes clicks, scrolls, hover and the cursor");
  assert.match(take, /OverridePointerEvents\(overridden, lowered, kPointerEventsNone\)/, "the covered page's pane takes none");
  const watch = body(input, "Class ReactViewClass()");
  assert.match(watch, /if \(!gWritingPointerEvents\) \[ReactPointerEvents\(\) removeObjectForKey:view\]/, "any value React sets while overridden is React's, and ends the override for that view");
  const back = body(input, "- (void)giveHitTestingBack");
  assert.match(back, /NSNumber \*requested = \[ReactPointerEvents\(\) objectForKey:view\];\n    if \(!requested\) continue;/, "a pane React set during the reveal, a sibling included, is left as React set it");
  assert.match(back, /WritePointerEvents\(view, requested\.integerValue\)/);
  assert.ok(body(input, "- (void)giveInputBack").includes("[self giveHitTestingBack]"));
  assert.match(input, /respondsToSelector:NSSelectorFromString\(@"pointerEvents"\)/);
  assert.equal(monitors.includes("redirectsInput"), false, "no input is rerouted by hand");
});

test("every press has a sequence number: only the commit of an older press goes under the page on screen", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.ok(press.indexOf("ArdiaTabPressBegan(key)") < press.indexOf("event.clickCount > 1"), "every press JS will hear is numbered, revealed or not");
  assert.match(press, /view->_reveal\.press = press;/);
  assert.match(body(presses, "NSUInteger ArdiaTabPressBegan(NSString *key)"), /const NSUInteger press = \+\+gLastPress;/);
  assert.match(tabsModule, /Function\("claimTabPress"\) \{ \(key: String\) -> Int in Int\(ArdiaWebView\.claimTabPress\(key\)\) \}/);
  assert.match(heldPress, /const nativePress = claimPress\(tabId\);/);
  assert.match(heldPress, /switchingByPress\(nativePress, \(\) => clickTab\(windowId, tabId\)\)/);
  assert.match(tabReveal, /else revealTab\(change\.tabId, pressSwitching\);/);
  assert.match(tabReveal, /dropTabReveals\(change\.over, pressSwitching, change\.to\)/);
  const reveal = body(reveals, "+ (void)revealTab:(NSString *)transferKey press:(NSUInteger)press");
  assert.ok(reveal.indexOf("ArdiaTabSwitchNotePress(key, press)") < reveal.indexOf("OnMain("), "noted on the JS thread, so it is there before the commit reaches the main thread");
  assert.match(reveal, /if \(pressedLater && OlderPress\(press, pressedLater->_reveal\.press\)\) return;/, "JS's own reveal of an earlier press doesn't take the screen back");
  assert.ok(reveal.indexOf("OlderPress(press") < reveal.indexOf("[ArdiaWebView dropRevealsInWindow:view.window except:view]"), "any other selection ends the reveal and shows itself");
  assert.match(body(reveals, "BOOL OlderPress(NSUInteger press, NSUInteger than)"), /return press && press < than;/, "a selection no press made is never older");
  const settle = body(reveals, "- (void)settleRevealsInWindow");
  assert.match(settle, /const NSUInteger press = ArdiaTabSwitchTakePress\(_transferKey\);/);
  assert.match(settle, /if \(pressedLater && OlderPress\(press, pressedLater->_reveal\.press\) && \[pressedLater stayOver:self\]\) return;/);
  const stay = body(reveals, "- (BOOL)stayOver:(ArdiaWebView *)shown");
  assert.match(stay, /NSEqualRects/, "a page laid out elsewhere (a split) is never covered");
  assert.ok(stay.indexOf("[self giveHitTestingBack]") < stay.indexOf("_reveal.loweredPane = shownPane;"));
  assert.ok(stay.indexOf("lowered.layer.zPosition = _reveal.loweredPaneZ;") < stay.indexOf("_reveal.loweredPane = shownPane;"), "the pane covered until now gets its place back");
  assert.ok(stay.indexOf("shownPane.layer.zPosition = _reveal.loweredPaneZ - 1;") < stay.indexOf("[self takeHitTesting]"), "input follows the screen again");
});

test("a drop names its press and leaves newer reveals alone", () => {
  assert.match(heldPress, /if \(activeTabId\(useBrowser\.getState\(\), windowId\) !== tabId\) pressLeftTabBehind\(nativePress\);/);
  assert.match(tabReveal, /if \(press\) dropTabPress\(press\);/);
  assert.match(body(reveals, "+ (void)dropTabPress:(NSUInteger)press"), /view->_reveal\.native && view->_reveal\.press == press\) \[view dropReveal\]/);
  assert.match(body(reveals, "+ (void)dropRevealsInWindow:(NSWindow *)window pressedBy:(NSUInteger)press"), /if \(!\(other->_reveal\.native && OlderPress\(press, other->_reveal\.press\)\)\) \[other dropReveal\];/);
});

test("a press JS never hears is rolled back once JS has passed its release", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.match(press, /if \(event\.type == NSEventTypeLeftMouseUp\) \[ArdiaWebView tabPressReleased\];/);
  const released = body(reveals, "+ (void)tabPressReleased");
  assert.match(released, /onJavaScriptThread\(\^\{\n    dispatch_async\(dispatch_get_main_queue\(\), \^\{\n      onJavaScriptThread\(\^\{/, "twice round, so the touch the dispatcher queued on the first pass is behind it");
  assert.match(released, /for \(NSNumber \*unheard in ArdiaTabPressesTakeUnclaimed\(pressed\)\) \[ArdiaWebView dropTabPress:unheard\.unsignedIntegerValue\];/);
  assert.match(tabsModule, /ArdiaWebView\.setJavaScriptThread \{ \[weak self\] block in self\?\.appContext\?\.executeOnJavaScriptThread\(runBlock: block\) \}/);
  assert.match(body(presses, "NSUInteger ArdiaTabPressClaim(NSString *key)"), /removeObjectAtIndex:i/);
});

test("a sleeping, closed, crashed, non-web, split or other profile's page is never shown ahead of JS, and one that fails while shown is taken back", () => {
  const first = body(reveals, "- (BOOL)revealsFirst");
  for (const guard of ["_tab.closed", "_tab.discarded", "_reports.crashed", "_life.closed()", "_visible", "_reveal.active", "_warm", "_standalone", "ArdiaTabInSplit(_transferKey)"]) assert.ok(first.includes(guard), guard);
  assert.match(first, /hasPrefix:@"https:"/);
  assert.match(first, /other->_tab\.profile == _tab\.profile/);
  assert.match(tabReveal, /PLATFORM_FEATURES\.nativeTabSwitch && !inSplit \? `\$\{selected \? "tab-selected" : "tab-switch"\}:\$\{tabId\}` : undefined/);
  assert.match(pressArea, /const inSplit = !!useSplitOf\(tab\.id\);/);
  assert.match(tabReveal, /if \(PLATFORM_FEATURES\.nativeTabSwitch && s\.splits !== prev\.splits\) setTabsInSplits\(tabsInSplits\(s\)\);/);
  assert.match(body(tabFile, "- (void)tab:(ArdiaCoreTab *)tab rendererGone:(NSString *)status code:(int)code"), /\[self dropReveal\];/);
  assert.match(body(tabFile, "- (void)tabDidChangeDiscarded:(ArdiaCoreTab *)tab"), /if \(tab\.discarded\) \[self dropReveal\];/);
  assert.match(body(tabFile, "- (void)detach"), /\[self dropReveal\];/, "a tab closed while shown counts as taken back");
});

test("another Space's warm page blocks the reveal only while it is awake", () => {
  const check = body(reveals, "- (ArdiaWebView *)revealableOver:(BOOL)pastOtherReveals");
  assert.match(check, /if \(\(other->_warm && !other\.neighbourPageAsleep\) \|\| \(other->_reveal\.active && !pastOtherReveals\)\) return nil;/);
  assert.match(body(painting, "- (BOOL)neighbourPageAsleep"), /if \(!_warm \|\| !_neighbour \|\| _visible\) return NO;/, "asleep means another Space's page that is not painting");
});

test("a native reveal that is taken back is marked, one a later press replaces or JS settles is not, and the press time is kept", () => {
  const drop = body(reveals, "- (void)dropReveal");
  assert.ok(drop.indexOf('ArdiaFieldMarkNow(_transferKey, @"nativeRevealDropped")') < drop.indexOf("[self endReveal]"));
  assert.match(drop, /if \(native\)/);
  assert.equal(body(reveals, "+ (void)replaceRevealsInWindow:(NSWindow *)window with:(ArdiaWebView *)pressed").includes("dropReveal"), false, "its own switch still follows");
  assert.match(body(reveals, "- (void)endReveal"), /_reveal\.native = NO;/);
  assert.match(body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event"), /ArdiaFieldMark\(key, @"nativePress", ArdiaFieldEventTime\(event\)\)/);
  assert.match(timing, /double ArdiaFieldEventTime\(NSEvent \*event\)/);
});

test("JS tags rows and switches the native path off with tab shares", () => {
  assert.match(tabsModule, /Function\("setNativeTabSwitch"\) \{ \(enabled: Bool\) in ArdiaWebView\.setNativeTabSwitch\(enabled\) \}/);
  assert.match(pressArea, /nativeID=\{tabPressTag\(tab\.id, selected, inSplit\)\}/);
  assert.match(pressArea, /collapsable=\{false\}/);
  assert.match(tabReveal, /tabShares/);
});
