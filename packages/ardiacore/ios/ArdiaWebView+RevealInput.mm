#import "ArdiaWebViewInternal.h"
#import "ArdiaFieldTiming.h"

#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

using namespace ardia_web_view;

namespace {

NSString *const kPageIdentityTag = @"page-identity";
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

void CollectPageIdentity(NSView *root, NSHashTable<NSView *> *found) {
  for (NSView *view in root.subviews) {
    if ([ReactTagOf(view) isEqualToString:kPageIdentityTag]) [found addObject:view];
    else CollectPageIdentity(view, found);
  }
}

}

namespace ardia_web_view {

NSString *ReactTagOf(NSView *view) {
  for (NSString *name in @[ @"nativeID", @"nativeId" ]) {
    if (![view respondsToSelector:NSSelectorFromString(name)]) continue;
    id tag = [view valueForKey:name];
    if ([tag isKindOfClass:NSString.class]) return tag;
  }
  return nil;
}

}

@implementation ArdiaWebView (RevealInput)

- (void)takeInputIfShown {
  if (!_reveal.active || !_reveal.native || _reveal.inputTaken || _frameHold.awaiting || self.alphaValue < 1) return;
  ArdiaWebView *covered = _reveal.covered;
  if (!covered) return;
  _reveal.inputTaken = YES;
  [self hidePageIdentity];
  [self takeHitTesting];
  [self takeFocusFrom:covered];
  ArdiaFieldMarkAtCommit(_transferKey, @"view");
}

- (void)giveInputBack {
  _reveal.inputTaken = NO;
  [self giveHitTestingBack];
  [self giveFocusBack];
  [self showPageIdentity];
}

- (void)hidePageIdentity {
  NSView *content = self.window.contentView;
  if (!content) return;
  NSMapTable<NSView *, NSNumber *> *hidden = _reveal.identityHidden ?: [NSMapTable weakToStrongObjectsMapTable];
  NSHashTable<NSView *> *found = [NSHashTable weakObjectsHashTable];
  CollectPageIdentity(content, found);
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (NSView *view in found.allObjects) {
    if (![hidden objectForKey:view]) [hidden setObject:@(view.alphaValue) forKey:view];
    view.alphaValue = 0;
  }
  [CATransaction commit];
  _reveal.identityHidden = hidden;
}

- (void)showPageIdentity {
  NSMapTable<NSView *, NSNumber *> *hidden = _reveal.identityHidden;
  _reveal.identityHidden = nil;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (NSView *view in hidden.keyEnumerator.allObjects) view.alphaValue = [hidden objectForKey:view].doubleValue;
  [CATransaction commit];
}

- (void)hidePageIdentityAfterMount {
  __weak ArdiaWebView *weakSelf = self;
  const NSUInteger generation = _reveal.generation;
  CFRunLoopObserverRef observer = CFRunLoopObserverCreateWithHandler(nil, kCFRunLoopBeforeWaiting | kCFRunLoopExit, false, 0, ^(CFRunLoopObserverRef, CFRunLoopActivity) {
    ArdiaWebView *view = weakSelf;
    if (view && view->_reveal.active && view->_reveal.inputTaken && view->_reveal.generation == generation) [view hidePageIdentity];
  });
  CFRunLoopAddObserver(CFRunLoopGetMain(), observer, kCFRunLoopCommonModes);
  CFRelease(observer);
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
  if (ResponderUnder(window, self)) ArdiaFieldMarkNow(_transferKey, @"nativeRevealFocus");
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
  if (!window || !owner->_visible || !focusStayedHere) return;
  if (from && from.window == window) [window makeFirstResponder:from];
  else [owner focusPage];
}

- (void)moveFocusOwnerTo:(ArdiaWebView *)shown {
  ArdiaWebView *owner = _reveal.focusOwner;
  if (!owner || owner == shown) return;
  owner->_focus.storedAtReveal = NO;
  _reveal.focusOwner = shown;
  _reveal.focusFrom = nil;
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

- (BOOL)underNativeReveal {
  NSWindow *window = self.window;
  if (!window || _reveal.active) return NO;
  for (ArdiaWebView *other in LiveViews().allObjects)
    if (other != self && other.window == window && other->_reveal.active && other->_reveal.inputTaken) return YES;
  return NO;
}

@end
