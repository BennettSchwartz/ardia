#import "ArdiaExtensionStaging.h"

#import "ArdiaExtensionPackage.h"
#import "ArdiaExtensionWalk.h"

#import <CommonCrypto/CommonDigest.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

namespace ardia_extensions {

namespace {

constexpr NSTimeInterval kAbandonedAfter = 24 * 60 * 60;
NSString *const kLive = @"live";
NSString *const kRecord = @"source.json";

NSMutableDictionary<NSString *, NSString *> *Active() {
  static NSMutableDictionary<NSString *, NSString *> *active = [NSMutableDictionary dictionary];
  return active;
}

NSMutableDictionary<NSString *, NSDictionary *> *Promoting() {
  static NSMutableDictionary<NSString *, NSDictionary *> *promoting = [NSMutableDictionary dictionary];
  return promoting;
}

NSObject *Lock() {
  static NSObject *lock = [NSObject new];
  return lock;
}

NSString *Fail(NSString **error, NSString *message) {
  *error = message;
  return nil;
}

NSString *Hex(NSData *data, NSUInteger bytes) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString string];
  for (NSUInteger i = 0; i < bytes; i++) [hex appendFormat:@"%02x", digest[i]];
  return hex;
}

NSString *ProfileFolder(NSString *profile) { return [@"p-" stringByAppendingString:Hex([profile ?: @"" dataUsingEncoding:NSUTF8StringEncoding], 8)]; }

NSString *SourceKey(NSString *source) { return Hex([source dataUsingEncoding:NSUTF8StringEncoding], 16); }

bool Matches(NSString *pattern, NSString *name) {
  return [name rangeOfString:[NSString stringWithFormat:@"^%@$", pattern] options:NSRegularExpressionSearch].location != NSNotFound;
}

NSString *const kStagePattern = @"[0-9]{13}-[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\\.stage";
NSString *const kKeyPattern = @"[0-9a-f]{32}";
NSString *const kProfilePattern = @"p-[0-9a-f]{16}";

bool PrivateFolder(NSString *path, bool create) {
  if (create) mkdir(path.fileSystemRepresentation, 0700);
  struct stat info;
  return lstat(path.fileSystemRepresentation, &info) == 0 && S_ISDIR(info.st_mode) && info.st_uid == getuid() && (info.st_mode & 0077) == 0;
}

NSString *CheckedRoot(NSString *root, bool create, NSString **error) {
  if (!root.length) return Fail(error, @"Ardia has no data folder to copy the extension into");
  if (!PrivateFolder(root, create)) return Fail(error, @"Ardia's folder for unpacked extensions isn't private to you, so it isn't used");
  char resolved[PATH_MAX];
  return realpath(root.fileSystemRepresentation, resolved) ? @(resolved) : Fail(error, @"Ardia's folder for unpacked extensions couldn't be read");
}

NSString *StageKeyFolder(NSString *staged, NSString *profile, NSString *root) {
  NSString *keyFolder = staged.stringByDeletingLastPathComponent;
  NSString *profileFolder = keyFolder.stringByDeletingLastPathComponent;
  if (![profileFolder isEqualToString:[root stringByAppendingPathComponent:ProfileFolder(profile)]]) return nil;
  if (!Matches(kStagePattern, staged.lastPathComponent) || !Matches(kKeyPattern, keyFolder.lastPathComponent)) return nil;
  return keyFolder;
}

void Remove(NSString *path) { [NSFileManager.defaultManager removeItemAtPath:path error:nil]; }

void SweepAbandoned(NSString *root) {
  NSFileManager *files = NSFileManager.defaultManager;
  NSSet<NSString *> *busy;
  @synchronized(Lock()) {
    NSMutableSet *held = [NSMutableSet setWithArray:Active().allKeys];
    for (NSDictionary *promotion in Promoting().allValues)
      if ([promotion[@"previous"] isKindOfClass:NSString.class]) [held addObject:promotion[@"previous"]];
    busy = held;
  }
  for (NSString *profile in [files contentsOfDirectoryAtPath:root error:nil] ?: @[]) {
    if (!Matches(kProfilePattern, profile)) continue;
    NSString *profileFolder = [root stringByAppendingPathComponent:profile];
    for (NSString *key in [files contentsOfDirectoryAtPath:profileFolder error:nil] ?: @[]) {
      if (!Matches(kKeyPattern, key)) continue;
      NSString *keyFolder = [profileFolder stringByAppendingPathComponent:key];
      for (NSString *name in [files contentsOfDirectoryAtPath:keyFolder error:nil] ?: @[]) {
        NSString *path = [keyFolder stringByAppendingPathComponent:name];
        if (!Matches(kStagePattern, name) || [busy containsObject:path]) continue;
        NSDate *changed = [files attributesOfItemAtPath:path error:nil].fileModificationDate;
        if (changed && -changed.timeIntervalSinceNow > kAbandonedAfter) Remove(path);
      }
    }
  }
}

}

NSString *IdForPath(NSString *path) {
  NSData *bytes = [path dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
  NSMutableString *id = [NSMutableString stringWithCapacity:32];
  for (int i = 0; i < 16; i++) [id appendFormat:@"%c%c", 'a' + (digest[i] >> 4), 'a' + (digest[i] & 15)];
  return id;
}

NSString *StagingRoot(NSString *dataDirectory) {
  return dataDirectory.length ? [dataDirectory stringByAppendingPathComponent:@"Ardia Unpacked Extensions"] : nil;
}

NSDictionary *StageUnpacked(NSString *path, NSString *profile, NSString *root) {
  NSString *error = nil;
  NSString *source = CanonicalFolder(path, &error);
  if (!source) return @{@"error" : error};
  if (!(root = CheckedRoot(root, true, &error))) return @{@"error" : error};
  NSString *inside = [root stringByAppendingString:@"/"];
  if ([[source stringByAppendingString:@"/"] hasPrefix:inside] || [inside hasPrefix:[source stringByAppendingString:@"/"]])
    return @{@"error" : @"That folder holds Ardia's own copies of extensions"};
  SweepAbandoned(root);
  NSString *profileFolder = [root stringByAppendingPathComponent:ProfileFolder(profile)];
  NSString *keyFolder = [profileFolder stringByAppendingPathComponent:SourceKey(source)];
  if (!PrivateFolder(profileFolder, true) || !PrivateFolder(keyFolder, true)) return @{@"error" : @"Ardia couldn't make a private copy of the extension"};
  NSString *name = [NSString stringWithFormat:@"%013llu-%@.stage", (unsigned long long)(NSDate.date.timeIntervalSince1970 * 1000), NSUUID.UUID.UUIDString];
  NSString *staged = [keyFolder stringByAppendingPathComponent:name];
  if (mkdir(staged.fileSystemRepresentation, 0755) != 0) return @{@"error" : @"Ardia couldn't make a copy of the extension"};
  NSString *digest = TreeDigest(source, staged, &error);
  NSMutableDictionary *info = digest ? [ReadManifest(staged) mutableCopy] : nil;
  if (!digest || info[@"error"]) {
    Remove(staged);
    return @{@"error" : error ?: info[@"error"]};
  }
  @synchronized(Lock()) {
    Active()[staged] = source;
  }
  NSString *live = [keyFolder stringByAppendingPathComponent:kLive];
  info[@"path"] = source;
  info[@"staged"] = staged;
  info[@"digest"] = digest;
  info[@"installPath"] = live;
  info[@"installId"] = info[@"id"] ?: IdForPath(live);
  return info;
}

NSString *BeginPromotion(NSString *staged, NSString *digest, NSString *profile, NSString *root, NSString **error) {
  if (!(root = CheckedRoot(root, false, error))) return nil;
  NSString *keyFolder = StageKeyFolder(staged, profile, root);
  NSString *source;
  @synchronized(Lock()) {
    source = Active()[staged];
  }
  if (!keyFolder || !source) return Fail(error, @"That isn't a copy Ardia made of an extension for this profile");
  NSString *now = TreeDigest(staged, nil, error);
  if (!now) return nil;
  if (![now isEqualToString:digest]) return Fail(error, @"Ardia's copy of the extension changed after the sheet showed it, so nothing was added. Load it again.");
  NSString *live = [keyFolder stringByAppendingPathComponent:kLive];
  @synchronized(Lock()) {
    if (Promoting()[live]) return Fail(error, @"This extension is already being added; try again once that ends");
    struct stat info;
    const bool replacing = lstat(live.fileSystemRepresentation, &info) == 0;
    const int moved = replacing ? renamex_np(staged.fileSystemRepresentation, live.fileSystemRepresentation, RENAME_SWAP)
                                : rename(staged.fileSystemRepresentation, live.fileSystemRepresentation);
    if (moved != 0) return Fail(error, @"Ardia couldn't put its copy of the extension in place");
    [Active() removeObjectForKey:staged];
    Promoting()[live] = @{@"previous" : replacing ? staged : NSNull.null, @"source" : source, @"digest" : digest};
  }
  return live;
}

void FinishPromotion(NSString *live, bool accepted) {
  NSDictionary *promotion;
  @synchronized(Lock()) {
    promotion = Promoting()[live];
    [Promoting() removeObjectForKey:live];
  }
  if (!promotion) return;
  NSString *previous = [promotion[@"previous"] isKindOfClass:NSString.class] ? promotion[@"previous"] : nil;
  if (accepted) {
    if (previous) Remove(previous);
    NSData *record = [NSJSONSerialization dataWithJSONObject:@{@"source" : promotion[@"source"], @"digest" : promotion[@"digest"]} options:0 error:nil];
    [record writeToFile:[live.stringByDeletingLastPathComponent stringByAppendingPathComponent:kRecord] atomically:YES];
    return;
  }
  if (previous && renamex_np(previous.fileSystemRepresentation, live.fileSystemRepresentation, RENAME_SWAP) == 0) Remove(previous);
  else if (!previous) Remove(live);
}

void DiscardStaged(NSString *staged, NSString *root) {
  NSString *error = nil;
  if (!(root = CheckedRoot(root, false, &error))) return;
  NSString *keyFolder = staged.stringByDeletingLastPathComponent;
  if (![keyFolder.stringByDeletingLastPathComponent.stringByDeletingLastPathComponent isEqualToString:root] || !Matches(kStagePattern, staged.lastPathComponent)) return;
  @synchronized(Lock()) {
    if (!Active()[staged]) return;
    [Active() removeObjectForKey:staged];
  }
  Remove(staged);
}

void RemoveManaged(NSString *live, NSString *profile, NSString *root) {
  NSString *error = nil;
  if (!(root = CheckedRoot(root, false, &error)) || ![live.lastPathComponent isEqualToString:kLive]) return;
  NSString *keyFolder = live.stringByDeletingLastPathComponent;
  if (![keyFolder.stringByDeletingLastPathComponent isEqualToString:[root stringByAppendingPathComponent:ProfileFolder(profile)]] || !Matches(kKeyPattern, keyFolder.lastPathComponent)) return;
  @synchronized(Lock()) {
    if (Promoting()[live]) return;
    for (NSString *staged in Active().allKeys)
      if ([staged.stringByDeletingLastPathComponent isEqualToString:keyFolder]) return;
  }
  Remove(keyFolder);
}

NSDictionary *ManagedInfo(NSString *live, NSString *root) {
  NSString *error = nil;
  if (!live.length || !(root = CheckedRoot(root, false, &error)) || ![live hasPrefix:[root stringByAppendingString:@"/"]]) return nil;
  NSData *data = [NSData dataWithContentsOfFile:[live.stringByDeletingLastPathComponent stringByAppendingPathComponent:kRecord]];
  id record = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![record isKindOfClass:NSDictionary.class] || ![record[@"source"] isKindOfClass:NSString.class] || ![record[@"digest"] isKindOfClass:NSString.class]) return @{};
  return @{@"source" : record[@"source"], @"digest" : record[@"digest"]};
}

}
