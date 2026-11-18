#import "ArdiaTabPresses.h"

#import <os/lock.h>

namespace {

constexpr NSUInteger kMaxUnclaimed = 64;

os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;
NSUInteger gLastPress = 0;
NSMutableArray<NSArray *> *gUnclaimed;
NSMutableDictionary<NSString *, NSNumber *> *gSwitchPress;
NSSet<NSString *> *gSplitKeys;

struct Locked {
  Locked() { os_unfair_lock_lock(&gLock); }
  ~Locked() { os_unfair_lock_unlock(&gLock); }
};

}

NSUInteger ArdiaTabPressBegan(NSString *key) {
  Locked lock;
  if (!gUnclaimed) gUnclaimed = [NSMutableArray array];
  if (gUnclaimed.count >= kMaxUnclaimed) [gUnclaimed removeObjectAtIndex:0];
  const NSUInteger press = ++gLastPress;
  [gUnclaimed addObject:@[ [key copy], @(press) ]];
  return press;
}

NSUInteger ArdiaTabPressClaim(NSString *key) {
  Locked lock;
  for (NSUInteger i = 0; i < gUnclaimed.count; i++) {
    NSArray *entry = gUnclaimed[i];
    if (![entry[0] isEqualToString:key]) continue;
    const NSUInteger press = [entry[1] unsignedIntegerValue];
    [gUnclaimed removeObjectAtIndex:i];
    return press;
  }
  return 0;
}

NSUInteger ArdiaTabPressLatestUnclaimed(void) {
  Locked lock;
  return [gUnclaimed.lastObject[1] unsignedIntegerValue];
}

NSArray<NSNumber *> *ArdiaTabPressesTakeUnclaimed(NSUInteger upTo) {
  Locked lock;
  NSMutableArray<NSNumber *> *taken = [NSMutableArray array];
  while (gUnclaimed.count && [gUnclaimed.firstObject[1] unsignedIntegerValue] <= upTo) {
    [taken addObject:gUnclaimed.firstObject[1]];
    [gUnclaimed removeObjectAtIndex:0];
  }
  return taken;
}

void ArdiaTabSwitchNotePress(NSString *key, NSUInteger press) {
  if (!key.length) return;
  Locked lock;
  if (!gSwitchPress) gSwitchPress = [NSMutableDictionary dictionary];
  if (press) gSwitchPress[key] = @(press);
  else [gSwitchPress removeObjectForKey:key];
}

NSUInteger ArdiaTabSwitchTakePress(NSString *key) {
  if (!key.length) return 0;
  Locked lock;
  const NSUInteger press = gSwitchPress[key].unsignedIntegerValue;
  [gSwitchPress removeObjectForKey:key];
  return press;
}

void ArdiaTabSplitsSet(NSArray<NSString *> *keys) {
  NSSet<NSString *> *set = [NSSet setWithArray:keys ?: @[]];
  Locked lock;
  gSplitKeys = set;
}

BOOL ArdiaTabInSplit(NSString *key) {
  Locked lock;
  return [gSplitKeys containsObject:key];
}
