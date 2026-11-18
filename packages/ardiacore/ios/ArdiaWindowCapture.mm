#import "ArdiaChromeWindowInternal.h"
#import "ArdiaLaunchConfig.h"

#import <AppKit/AppKit.h>
#import <objc/runtime.h>

namespace {

NSMutableDictionary<NSValue *, id> *HoldTable() {
  static NSMutableDictionary<NSValue *, id> *holds = [NSMutableDictionary dictionary];
  return holds;
}

NSValue *KeyFor(id owner) {
  return [NSValue valueWithNonretainedObject:owner];
}

BOOL Targets(id targets, NSWindow *window) {
  return targets == NSNull.null || [targets containsObject:@(window.windowNumber)];
}

BOOL IsHeld(NSWindow *window) {
  for (id targets in HoldTable().objectEnumerator)
    if (Targets(targets, window)) return YES;
  return NO;
}

BOOL InstallOcclusionHold() {
  static BOOL installed;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    SEL isOccluded = NSSelectorFromString(@"isOccluded");
    Method m = class_getInstanceMethod(NSWindow.class, isOccluded);
    if (!m) return;
    auto original = (BOOL(*)(id, SEL))method_getImplementation(m);
    method_setImplementation(m, imp_implementationWithBlock(^BOOL(NSWindow *window) {
      return IsHeld(window) ? NO : original(window, isOccluded);
    }));
    installed = YES;
  });
  return installed;
}

void Recheck(id targets) {
  for (NSWindow *window in NSApp.windows)
    if (Targets(targets, window))
      [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidChangeOcclusionStateNotification object:window];
}

}

namespace ardia_window {

BOOL HoldWindowsForCapture(id owner, NSString *sourceId) {
  id targets = nil;
  if ([sourceId hasPrefix:@"screen:"]) {
    targets = NSNull.null;
  } else if ([sourceId hasPrefix:@"window:"]) {
    NSInteger number = [[sourceId componentsSeparatedByString:@":"][1] integerValue];
    if (number > 0) targets = [NSSet setWithObject:@(number)];
  }
  if (!targets) return NO;
  if (!InstallOcclusionHold()) {
    NSLog(@"[ardiacore-vis] -[NSWindow isOccluded] is missing, so %@ cannot keep its window drawing", sourceId);
    return NO;
  }
  if ([HoldTable()[KeyFor(owner)] isEqual:targets]) return YES;
  HoldTable()[KeyFor(owner)] = targets;
  if ([ArdiaLaunchConfig.shared traced:@"visibility"]) NSLog(@"[ardiacore-vis] holding %@ visible while it is captured", sourceId);
  Recheck(targets);
  return YES;
}

BOOL ReleaseWindowsForCapture(id owner) {
  id targets = HoldTable()[KeyFor(owner)];
  if (!targets) return NO;
  [HoldTable() removeObjectForKey:KeyFor(owner)];
  if ([ArdiaLaunchConfig.shared traced:@"visibility"]) NSLog(@"[ardiacore-vis] capture ended, its windows may be occluded again");
  Recheck(targets);
  return YES;
}

}
