#import "ArdiaExtensionStaging.h"

#import "ArdiaExtensionPackage.h"
#import "ArdiaHost.h"

#import <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

namespace ardia_extensions {

namespace {

constexpr unsigned long long kMaxFileBytes = 4ull << 20;
constexpr unsigned long long kMaxPackageBytes = 1ull << 30;
constexpr NSUInteger kMaxPackageFiles = 20000;
constexpr int kMaxDepth = 64;
constexpr NSTimeInterval kAbandonedAfter = 24 * 60 * 60;
NSString *const kPendingMark = @".pending-";
NSString *const kChromiumMetadata = @"_metadata";

NSString *Hex(const unsigned char *bytes, size_t length) {
  NSMutableString *hex = [NSMutableString stringWithCapacity:length * 2];
  for (size_t i = 0; i < length; i++) [hex appendFormat:@"%02x", bytes[i]];
  return hex;
}

NSString *Fail(NSString **error, NSString *message) {
  *error = message;
  return nil;
}

NSString *Shown(NSString *relative) { return relative.length ? relative : @"The folder"; }

bool Collect(NSString *root, NSString *relative, int depth, NSMutableDictionary<NSString *, NSString *> *files, NSString **error) {
  NSString *dir = relative.length ? [root stringByAppendingPathComponent:relative] : root;
  if (depth > kMaxDepth) return Fail(error, [NSString stringWithFormat:@"%@ is nested too deeply", relative]), false;
  int fd = open(dir.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  DIR *listing = fd >= 0 ? fdopendir(fd) : nullptr;
  if (!listing) {
    if (fd >= 0) close(fd);
    return Fail(error, [NSString stringWithFormat:@"%@ couldn't be read", Shown(relative)]), false;
  }
  NSString *inside = [root stringByAppendingString:@"/"];
  bool ok = true;
  errno = 0;
  for (struct dirent *entry; ok && (entry = readdir(listing));) {
    NSString *name = [NSFileManager.defaultManager stringWithFileSystemRepresentation:entry->d_name length:strlen(entry->d_name)];
    if ([name hasPrefix:@"."] || (!relative.length && [name isEqualToString:kChromiumMetadata])) continue;
    NSString *child = relative.length ? [relative stringByAppendingPathComponent:name] : name;
    NSString *path = [root stringByAppendingPathComponent:child];
    struct stat info;
    if (lstat(path.fileSystemRepresentation, &info) != 0) {
      ok = Fail(error, [NSString stringWithFormat:@"%@ couldn't be read", child]) != nil;
    } else if (S_ISDIR(info.st_mode)) {
      ok = Collect(root, child, depth + 1, files, error);
    } else if (S_ISLNK(info.st_mode)) {
      char resolved[PATH_MAX];
      struct stat target;
      NSString *real = realpath(path.fileSystemRepresentation, resolved) ? @(resolved) : nil;
      if (!real || ![real hasPrefix:inside] || stat(resolved, &target) != 0 || !S_ISREG(target.st_mode))
        ok = Fail(error, [NSString stringWithFormat:@"%@ links outside the extension's folder or to a folder", child]) != nil;
      else
        files[child] = real;
    } else if (S_ISREG(info.st_mode)) {
      files[child] = path;
    } else {
      ok = Fail(error, [NSString stringWithFormat:@"%@ isn't a regular file", child]) != nil;
    }
    if (ok && files.count > kMaxPackageFiles) ok = Fail(error, [NSString stringWithFormat:@"The folder holds more than %lu files", (unsigned long)kMaxPackageFiles]) != nil;
    errno = 0;
  }
  if (ok && errno != 0) ok = Fail(error, [NSString stringWithFormat:@"%@ couldn't be read", Shown(relative)]) != nil;
  closedir(listing);
  return ok;
}

NSData *ReadWhole(NSString *path, NSString *relative, NSString **error) {
  int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return (NSData *)Fail(error, [NSString stringWithFormat:@"%@ couldn't be read", relative]);
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    close(fd);
    return (NSData *)Fail(error, [NSString stringWithFormat:@"%@ isn't a regular file", relative]);
  }
  if ((unsigned long long)info.st_size > kMaxFileBytes) {
    close(fd);
    return (NSData *)Fail(error, [NSString stringWithFormat:@"%@ is bigger than 4 MB", relative]);
  }
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)info.st_size + 1];
  size_t used = 0;
  for (;;) {
    ssize_t got = read(fd, (char *)data.mutableBytes + used, data.length - used);
    if (got < 0) {
      close(fd);
      return (NSData *)Fail(error, [NSString stringWithFormat:@"%@ couldn't be read", relative]);
    }
    if (got == 0) break;
    used += (size_t)got;
    if (used == data.length) break;
  }
  close(fd);
  if (used != (size_t)info.st_size) return (NSData *)Fail(error, [NSString stringWithFormat:@"%@ changed while Ardia read it", relative]);
  data.length = used;
  return data;
}

bool WriteNew(NSString *path, NSData *data) {
  NSString *parent = path.stringByDeletingLastPathComponent;
  if (![NSFileManager.defaultManager createDirectoryAtPath:parent withIntermediateDirectories:YES attributes:nil error:nil]) return false;
  int fd = open(path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0644);
  if (fd < 0) return false;
  size_t done = 0;
  while (done < data.length) {
    ssize_t wrote = write(fd, (const char *)data.bytes + done, data.length - done);
    if (wrote <= 0) break;
    done += (size_t)wrote;
  }
  return close(fd) == 0 && done == data.length;
}

NSString *HashTree(NSString *root, NSString *copyTo, NSString **error) {
  NSMutableDictionary<NSString *, NSString *> *files = [NSMutableDictionary dictionary];
  if (!Collect(root, @"", 0, files, error)) return nil;
  if (!files[@"manifest.json"]) return Fail(error, @"Manifest file is missing or unreadable");
  CC_SHA256_CTX sha;
  CC_SHA256_Init(&sha);
  unsigned long long total = 0;
  for (NSString *relative in [files.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
    NSData *data = ReadWhole(files[relative], relative, error);
    if (!data) return nil;
    total += data.length;
    if (total > kMaxPackageBytes) return Fail(error, @"The folder holds more than 1 GB");
    NSData *name = [relative dataUsingEncoding:NSUTF8StringEncoding];
    uint64_t size = data.length;
    CC_SHA256_Update(&sha, name.bytes, (CC_LONG)name.length);
    CC_SHA256_Update(&sha, "", 1);
    CC_SHA256_Update(&sha, &size, sizeof size);
    CC_SHA256_Update(&sha, data.bytes, (CC_LONG)data.length);
    if (copyTo && !WriteNew([copyTo stringByAppendingPathComponent:relative], data))
      return Fail(error, [NSString stringWithFormat:@"Ardia couldn't copy %@", relative]);
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &sha);
  return Hex(digest, sizeof digest);
}

NSString *SourceKey(NSString *source) {
  NSData *bytes = [source dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
  return Hex(digest, 16);
}

void SweepAbandoned(NSString *root) {
  NSFileManager *files = NSFileManager.defaultManager;
  for (NSString *name in [files contentsOfDirectoryAtPath:root error:nil] ?: @[]) {
    if (![name containsString:kPendingMark]) continue;
    NSString *path = [root stringByAppendingPathComponent:name];
    NSDate *changed = [files attributesOfItemAtPath:path error:nil].fileModificationDate;
    if (changed && -changed.timeIntervalSinceNow > kAbandonedAfter) [files removeItemAtPath:path error:nil];
  }
}

NSString *PendingKey(NSString *staged) {
  NSString *root = StagingRoot();
  if (!root.length || ![staged.stringByDeletingLastPathComponent isEqualToString:root]) return nil;
  NSString *name = staged.lastPathComponent;
  NSRange mark = [name rangeOfString:kPendingMark];
  if (mark.location != 32 || name.length <= NSMaxRange(mark)) return nil;
  NSString *key = [name substringToIndex:32];
  NSCharacterSet *notHex = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
  return [key rangeOfCharacterFromSet:notHex].location == NSNotFound ? key : nil;
}

}

NSString *StagingRoot() {
  NSString *data = ArdiaHost.dataDirectory;
  return data.length ? [data stringByAppendingPathComponent:@"Ardia Unpacked Extensions"] : nil;
}

NSDictionary *StageUnpacked(NSString *path) {
  NSString *error = nil;
  NSString *source = CanonicalFolder(path, &error);
  if (!source) return @{@"error" : error};
  NSString *root = StagingRoot();
  if (!root.length) return @{@"error" : @"Ardia has no data folder to copy the extension into"};
  if ([[source stringByAppendingString:@"/"] hasPrefix:[root stringByAppendingString:@"/"]] || [[root stringByAppendingString:@"/"] hasPrefix:[source stringByAppendingString:@"/"]])
    return @{@"error" : @"That folder holds Ardia's own copies of extensions"};
  if (![NSFileManager.defaultManager createDirectoryAtPath:root withIntermediateDirectories:YES attributes:nil error:nil])
    return @{@"error" : @"Ardia couldn't make its folder for unpacked extensions"};
  SweepAbandoned(root);
  NSString *pending = [root stringByAppendingPathComponent:[NSString stringWithFormat:@"%@%@%@", SourceKey(source), kPendingMark, NSUUID.UUID.UUIDString]];
  if (mkdir(pending.fileSystemRepresentation, 0755) != 0) return @{@"error" : @"Ardia couldn't make a copy of the extension"};
  NSString *digest = HashTree(source, pending, &error);
  NSMutableDictionary *info = digest ? [ReadManifest(pending) mutableCopy] : nil;
  if (!digest || info[@"error"]) {
    [NSFileManager.defaultManager removeItemAtPath:pending error:nil];
    return @{@"error" : error ?: info[@"error"]};
  }
  info[@"path"] = source;
  info[@"staged"] = pending;
  info[@"digest"] = digest;
  return info;
}

NSString *PromoteStaged(NSString *staged, NSString *digest, NSString **error) {
  NSString *key = PendingKey(staged);
  if (!key) return Fail(error, @"That isn't a copy Ardia made of an extension");
  NSString *now = HashTree(staged, nil, error);
  if (!now) return nil;
  if (![now isEqualToString:digest]) return Fail(error, @"Ardia's copy of the extension changed after the sheet showed it, so nothing was added. Load it again.");
  NSString *final = [StagingRoot() stringByAppendingPathComponent:key];
  struct stat info;
  if (lstat(final.fileSystemRepresentation, &info) == 0) {
    if (renamex_np(staged.fileSystemRepresentation, final.fileSystemRepresentation, RENAME_SWAP) != 0) return Fail(error, @"Ardia couldn't replace its earlier copy of the extension");
    [NSFileManager.defaultManager removeItemAtPath:staged error:nil];
  } else if (rename(staged.fileSystemRepresentation, final.fileSystemRepresentation) != 0) {
    return Fail(error, @"Ardia couldn't keep its copy of the extension");
  }
  return final;
}

void DiscardStaged(NSString *staged) {
  if (PendingKey(staged)) [NSFileManager.defaultManager removeItemAtPath:staged error:nil];
}

}
