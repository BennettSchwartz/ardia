#import "ArdiaWebViewInternal.h"
#import "ArdiaTabParking.h"
#import "ArdiaFieldTiming.h"

#import <objc/runtime.h>

#include <atomic>

using namespace ardia_web_view;

namespace {

constexpr CFTimeInterval kRevealBackstopSeconds = 5;
constexpr NSEventModifierFlags kClickModifiers =
    NSEventModifierFlagCommand | NSEventModifierFlagOption | NSEventModifierFlagShift | NSEventModifierFlagControl;

std::atomic<bool> gNativeTabSwitch{false};

NSString *const kTabSwitchTag = @"tab-switch:";
NSString *const kTabSelectedTag = @"tab-selected:";
constexpr NSInteger kPointerEventsAuto = 0;
constexpr NSInteger kPointerEventsNone = 1;
constexpr NSInteger kNoPointerEvents = -1;

NSInteger PointerEventsOf(NSView *view) {
  return [view respondsToSelector:NSSelectorFromString(@"pointerEvents")] ? [[view valueForKey:@"pointerEvents"] integerValue] : kNoPointerEvents;
}

BOOL gWritingPointerEvents = NO;

NSMapTable<NSView *, NSNumber *> *ReactPointerEvents() {
  static NSMapTable<NSView *, NSNumber *> *requested = [NSMapTable weakToStrongObjectsMapTable];
  return requested;
}

Class ReactViewClass() {
  static Class cls = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    cls = NSClassFromString(@"RCTView");
    SEL setter = NSSelectorFromString(@"setPointerEvents:");
    Method method = cls ? class_getInstanceMethod(cls, setter) : nil;
    if (!method) {
      cls = nil;
      return;
    }
    IMP original = method_getImplementation(method);
    method_setImplementation(method, imp_implementationWithBlock(^(NSView *view, NSInteger value) {
      if (!gWritingPointerEvents) [ReactPointerEvents() removeObjectForKey:view];
      ((void (*)(id, SEL, NSInteger))original)(view, setter, value);
    }));
  });
  return cls;
}

void WritePointerEvents(NSView *view, NSInteger value) {
  gWritingPointerEvents = YES;
  [view setValue:@(value) forKey:@"pointerEvents"];
  gWritingPointerEvents = NO;
}

void OverridePointerEvents(NSHashTable<NSView *> *overridden, NSView *view, NSInteger value) {
  Class react = ReactViewClass();
  const NSInteger was = PointerEventsOf(view);
  if (!react || ![view isKindOfClass:react] || was == kNoPointerEvents || was == value) return;
  if (![ReactPointerEvents() objectForKey:view]) [ReactPointerEvents() setObject:@(was) forKey:view];
  [overridden addObject:view];
  WritePointerEvents(view, value);
}

BOOL ResponderUnder(NSWindow *window, NSView *ancestor) {
  NSResponder *responder = window.firstResponder;
  return ancestor && [responder isKindOfClass:NSView.class] && [(NSView *)responder isDescendantOf:ancestor];
}

BOOL IsRowControl(NSView *view) {
  if ([view isKindOfClass:NSControl.class] || [view isKindOfClass:NSText.class]) return YES;
  NSAccessibilityRole role = view.accessibilityRole;
  return [role isEqualToString:NSAccessibilityButtonRole] || [role isEqualToString:NSAccessibilityTextFieldRole] ||
         [role isEqualToString:NSAccessibilityTextAreaRole] || [role isEqualToString:NSAccessibilityCheckBoxRole] ||
         [role isEqualToString:NSAccessibilityPopUpButtonRole] || [role isEqualToString:NSAccessibilityMenuButtonRole];
}

NSString *ReactTagOf(NSView *view) {
  for (NSString *name in @[ @"nativeID", @"nativeId" ]) {
    if (![view respondsToSelector:NSSelectorFromString(name)]) continue;
    id tag = [view valueForKey:name];
    if ([tag isKindOfClass:NSString.class]) return tag;
  }
  return nil;
}

NSString *TabSwitchKeyOf(NSView *view) {
  NSString *tag = ReactTagOf(view);
  if (![tag hasPrefix:kTabSwitchTag] && ![tag hasPrefix:kTabSelectedTag]) return nil;
  return [tag substringFromIndex:[tag rangeOfString:@":"].location + 1].length ? tag : nil;
}

NSView *HitInWindow(NSEvent *event) {
  NSView *content = event.window.contentView;
  NSView *outer = content.superview;
  return content && outer ? [content hitTest:[outer convertPoint:event.locationInWindow fromView:nil]] : nil;
}

NSString *PressedTabTag(NSEvent *event) {
  NSWindow *window = event.window;
  NSView *content = window.contentView;
  NSView *hit = HitInWindow(event);
  if (!hit || !(window.isKeyWindow || [hit acceptsFirstMouse:event])) return nil;
  for (NSView *view = hit; view && view != content; view = view.superview) {
    if (NSString *key = TabSwitchKeyOf(view)) return key;
    if (IsRowControl(view)) return nil;
  }
  return nil;
}

void OnMain(void (^block)(void)) {
  if (NSThread.isMainThread) block();
  else dispatch_async(dispatch_get_main_queue(), block);
}
}

namespace ardia_web_view {

NSView *PaneUnder(NSView *view, NSView *ancestor) {
  for (NSView *v = view; v; v = v.superview)
    if (v.superview == ancestor) return v;
  return nil;
}

NSView *SharedAncestor(NSView *a, NSView *b) {
  NSHashTable<NSView *> *chain = [NSHashTable weakObjectsHashTable];
  for (NSView *v = a.superview; v; v = v.superview) [chain addObject:v];
  for (NSView *v = b.superview; v; v = v.superview)
    if ([chain containsObject:v]) return v;
  return nil;
}
}

@implementation ArdiaWebView (Reveals)

static ArdiaWebView *ViewForKey(NSString *key) {
  for (ArdiaWebView *view in LiveViews().allObjects)
    if (view->_tab && [view->_transferKey isEqualToString:key]) return view;
  return nil;
}

+ (void)revealTab:(NSString *)transferKey {
  if (!transferKey.length) return;
  NSString *key = [transferKey copy];
  OnMain(^{
    ArdiaWebView *view = ViewForKey(key);
    if (!view.window || [ArdiaWebView nativeRevealInWindow:view.window except:view]) return;
    [ArdiaWebView dropRevealsInWindow:view.window except:view];
    [view revealAhead];
  });
}

+ (void)setNativeTabSwitch:(BOOL)enabled {
  gNativeTabSwitch.store(enabled, std::memory_order_relaxed);
}

+ (BOOL)revealForPress:(NSEvent *)event {
  if (!gNativeTabSwitch.load(std::memory_order_relaxed) || event.type != NSEventTypeLeftMouseDown || event.clickCount > 1 || (event.modifierFlags & kClickModifiers)) return NO;
  NSWindow *window = event.window;
  NSString *tag = window ? PressedTabTag(event) : nil;
  NSString *key = !tag ? nil : [tag substringFromIndex:[tag rangeOfString:@":"].location + 1];
  ArdiaWebView *view = key.length ? ViewForKey(key) : nil;
  if (!view || view.window != window) return NO;
  if (view->_visible) {
    [ArdiaWebView dropNativeRevealsInWindow:window];
    return NO;
  }
  ArdiaWebView *shown = [tag hasPrefix:kTabSwitchTag] && view.revealsFirst ? [view revealableOver:YES] : nil;
  if (!shown) return NO;
  [ArdiaWebView dropRevealsInWindow:window except:view];
  [view revealAhead];
  if (!view->_reveal.active) return NO;
  view->_reveal.native = YES;
  ArdiaFieldMarkNow(key, @"nativeReveal");
  ArdiaFieldMarkAtCommit(key, @"view");
  [view takeHitTesting];
  [view takeFocusFrom:shown];
  return YES;
}

- (void)takeHitTesting {
  NSView *lowered = _reveal.loweredPane;
  NSView *shared = lowered.superview;
  if (!shared) return;
  NSHashTable<NSView *> *overridden = [NSHashTable weakObjectsHashTable];
  for (NSView *view = self.superview; view && view != shared; view = view.superview)
    if (PointerEventsOf(view) == kPointerEventsNone) OverridePointerEvents(overridden, view, kPointerEventsAuto);
  OverridePointerEvents(overridden, lowered, kPointerEventsNone);
  _reveal.hitSwaps = overridden;
}

- (void)giveHitTestingBack {
  NSHashTable<NSView *> *overridden = _reveal.hitSwaps;
  _reveal.hitSwaps = nil;
  for (NSView *view in overridden.allObjects) {
    NSNumber *requested = [ReactPointerEvents() objectForKey:view];
    if (!requested) continue;
    [ReactPointerEvents() removeObjectForKey:view];
    WritePointerEvents(view, requested.integerValue);
  }
}

- (void)takeFocusFrom:(ArdiaWebView *)shown {
  NSWindow *window = self.window;
  NSResponder *responder = window.firstResponder;
  if (!ResponderUnder(window, _reveal.loweredPane)) return;
  [shown storePageFocusFrom:responder];
  shown->_focus.storedAtReveal = YES;
  _reveal.focusOwner = shown;
  _reveal.focusFrom = (NSView *)responder;
  [self focusPage];
  ArdiaFieldMarkNow(_transferKey, @"nativeRevealFocus");
}

- (void)giveFocusBack {
  ArdiaWebView *owner = _reveal.focusOwner;
  NSView *from = _reveal.focusFrom;
  _reveal.focusOwner = nil;
  _reveal.focusFrom = nil;
  if (!owner) return;
  owner->_focus.storedAtReveal = NO;
  NSWindow *window = owner.window;
  NSResponder *responder = window.firstResponder;
  const BOOL focusStayedHere = !responder || responder == window || ([responder isKindOfClass:NSView.class] && [(NSView *)responder isDescendantOf:self]);
  if (window && owner->_visible && from.window == window && focusStayedHere) [window makeFirstResponder:from];
}

+ (ArdiaWebView *)nativeRevealInWindow:(NSWindow *)window except:(ArdiaWebView *)skip {
  for (ArdiaWebView *other in LiveViews().allObjects)
    if (other != skip && other.window == window && other->_reveal.active && other->_reveal.native) return other;
  return nil;
}

- (BOOL)stayOver:(ArdiaWebView *)shown {
  NSView *shared = SharedAncestor(self, shown);
  NSView *pane = PaneUnder(self, shared);
  NSView *shownPane = PaneUnder(shown, shared);
  if (!shared || !pane || !shownPane.layer || pane == shownPane) return NO;
  if (!NSEqualRects([self convertRect:self.bounds toView:nil], [shown convertRect:shown.bounds toView:nil])) return NO;
  [self giveHitTestingBack];
  if (NSView *lowered = _reveal.loweredPane) lowered.layer.zPosition = _reveal.loweredPaneZ;
  _reveal.loweredPane = shownPane;
  _reveal.loweredPaneZ = shownPane.layer.zPosition;
  shownPane.layer.zPosition = _reveal.loweredPaneZ - 1;
  [self takeHitTesting];
  return YES;
}

+ (void)dropNativeRevealsInWindow:(NSWindow *)window {
  for (ArdiaWebView *other in LiveViews().allObjects)
    if (other.window == window && other->_reveal.native) [other dropReveal];
}

+ (void)dropTabReveals:(NSString *)transferKey {
  if (!transferKey.length) return;
  NSString *key = [transferKey copy];
  OnMain(^{
    ArdiaWebView *view = ViewForKey(key);
    if (view.window) [ArdiaWebView dropRevealsInWindow:view.window except:nil];
  });
}

+ (void)dropRevealsInWindow:(NSWindow *)window except:(ArdiaWebView *)keep {
  for (ArdiaWebView *other in LiveViews().allObjects) {
    if (other.window != window) continue;
    [other dropFront];
    if (other != keep) [other dropReveal];
  }
}

+ (void)revealOffered:(NSString *)adoptId over:(NSString *)transferKey {
  if (!adoptId.length || !transferKey.length) return;
  NSString *offer = [adoptId copy], *key = [transferKey copy];
  OnMain(^{
    ArdiaWebView *view = ViewForKey(key);
    if (!view.window) return;
    [ArdiaWebView dropRevealsInWindow:view.window except:nil];
    ArdiaCoreTab *tab = [ArdiaTabRegistry offeredTab:offer];
    NSView *page = tab.view;
    if (TraceVisibility())
      NSLog(@"[ardiacore-vis] %@ front %@ offered=%d closed=%d superview=%@ adopted=%d", key, offer, tab != nil, tab.closed,
            page.superview.className, [ArdiaTabRegistry viewForTab:tab] != nil);
    if (!tab || tab.closed || !page || page.superview || [ArdiaTabRegistry viewForTab:tab]) return;
    [tab noteInShownSlot];
    [view frontPage:page profile:tab.profile];
  });
}

+ (BOOL)discardOffered:(NSString *)adoptId {
  if (![adoptId hasPrefix:@"ardiacore:"]) return NO;
  ArdiaCoreTab *tab = [ArdiaTabRegistry offeredTab:adoptId];
  if (!tab || tab.closed || [ArdiaTabRegistry viewForTab:tab] || [ArdiaTabParking linkMarkForTab:tab]) return NO;
  if (NSView *page = tab.view)
    for (ArdiaWebView *view in LiveViews().allObjects)
      if (view->_reveal.frontedPage == page) [view dropFront];
  if ([ArdiaTabRegistry takeOffered:adoptId] != tab) return NO;
  [tab close];
  return YES;
}

- (BOOL)onlyShownInWindow {
  NSWindow *window = self.window;
  if (!_visible || _warm || _reveal.active || _standalone || _life.closed() || !window || self.alphaValue < 1 || self.isHiddenOrHasHiddenAncestor) return NO;
  for (ArdiaWebView *other in LiveViews().allObjects)
    if (other != self && other.window == window && (other->_visible || other->_warm || other->_reveal.active)) return NO;
  return YES;
}

- (void)frontPage:(NSView *)page profile:(ArdiaCoreProfile *)profile {
  NSView *mine = _tab.view;
  if (_reveal.frontedPage || _devtoolsView || !mine || mine.superview != self || mine.hidden || _tab.profile != profile || ![self onlyShownInWindow]) return;
  page.frame = self.bounds;
  page.hidden = NO;
  [self addSubview:page positioned:NSWindowAbove relativeTo:mine];
  _reveal.frontedPage = page;
  if (TraceVisibility()) NSLog(@"[ardiacore-vis] %@ fronts a new tab's page", _transferKey);
  const NSUInteger generation = ++_reveal.frontGeneration;
  __weak ArdiaWebView *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kRevealBackstopSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ArdiaWebView *view = weakSelf;
    if (view && view->_reveal.frontGeneration == generation) [view dropFront];
  });
}

- (void)dropFront {
  NSView *fronted = _reveal.frontedPage;
  _reveal.frontedPage = nil;
  _reveal.frontGeneration++;
  if (fronted.superview == self) [fronted removeFromSuperview];
}

- (BOOL)revealsFirst {
  if (!_tab || _tab.closed || _tab.discarded || _reports.crashed || _life.closed() || _visible || _reveal.active || _warm || _standalone) return NO;
  NSString *url = _tab.url;
  if (![url hasPrefix:@"https:"] && ![url hasPrefix:@"http:"] && ![url hasPrefix:@"file:"]) return NO;
  for (ArdiaWebView *other in LiveViews().allObjects)
    if (other != self && other.window == self.window && other->_visible) return other->_tab.profile == _tab.profile;
  return NO;
}

- (ArdiaWebView *)revealableOver:(BOOL)pastOtherReveals {
  NSWindow *window = self.window;
  NSView *page = _tab.view;
  if (_visible || _reveal.active || _warm || _standalone || _life.closed() || !window || !page || page.superview != self) return nil;
  ArdiaWebView *shown = nil;
  for (ArdiaWebView *other in LiveViews().allObjects) {
    if (other == self || other.window != window) continue;
    if (other->_warm || (other->_reveal.active && !pastOtherReveals)) return nil;
    if (!other->_visible) continue;
    if (shown) return nil;
    shown = other;
  }
  if (!shown || shown.alphaValue < 1 || (shown->_reveal.frontedPage && !pastOtherReveals)) return nil;
  const NSRect mine = [self convertRect:self.bounds toView:nil];
  if (NSIsEmptyRect(mine) || !NSEqualRects(mine, [shown convertRect:shown.bounds toView:nil])) return nil;
  NSView *shared = SharedAncestor(self, shown);
  NSView *pane = PaneUnder(self, shared);
  NSView *shownPane = PaneUnder(shown, shared);
  if (!shared || !pane || !shownPane || !shownPane.layer || pane == shownPane || pane.isHiddenOrHasHiddenAncestor || pane.alphaValue < 1) return nil;
  return shown;
}

- (void)revealAhead {
  ArdiaWebView *shown = [self revealableOver:NO];
  if (!shown) return;
  NSView *shared = SharedAncestor(self, shown);
  NSView *shownPane = PaneUnder(shown, shared);
  if (TraceVisibility()) NSLog(@"[ardiacore-vis] %@ revealed over %@", _transferKey, shown->_transferKey);
  [self exposePage];
  _reveal.active = YES;
  _reveal.loweredPane = shownPane;
  _reveal.loweredPaneZ = shownPane.layer.zPosition;
  shownPane.layer.zPosition = _reveal.loweredPaneZ - 1;
  [self applyPainting];
  const NSUInteger generation = ++_reveal.generation;
  __weak ArdiaWebView *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kRevealBackstopSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ArdiaWebView *view = weakSelf;
    if (view && view->_reveal.generation == generation && view->_reveal.active) [view dropReveal];
  });
}

- (void)endReveal {
  if (!_reveal.active) return;
  [self giveHitTestingBack];
  [self giveFocusBack];
  _reveal.active = NO;
  _reveal.native = NO;
  _reveal.generation++;
  if (NSView *pane = _reveal.loweredPane) pane.layer.zPosition = _reveal.loweredPaneZ;
  _reveal.loweredPane = nil;
}

- (void)keepAtSettle {
  __weak ArdiaWebView *owner = _reveal.focusOwner;
  _reveal.focusOwner = nil;
  _reveal.focusFrom = nil;
  if (!owner) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    ArdiaWebView *outgoing = owner;
    if (outgoing) outgoing->_focus.storedAtReveal = NO;
  });
}

- (void)dropReveal {
  if (!_reveal.active) return;
  if (_reveal.native) ArdiaFieldMarkNow(_transferKey, @"nativeRevealDropped");
  [self endReveal];
  [self schedulePainting];
}

- (void)settleRevealsInWindow {
  NSWindow *window = self.window;
  ArdiaWebView *pressedLater = window && !_reveal.active ? [ArdiaWebView nativeRevealInWindow:window except:self] : nil;
  if ([pressedLater stayOver:self]) return;
  [self keepAtSettle];
  [self endReveal];
  if (window) [ArdiaWebView dropRevealsInWindow:window except:self];
}

@end
