#import "ArdiaExtensionWalk.h"

#import <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace ardia_extensions {

namespace {

constexpr unsigned long long kMaxPackageBytes = 512ull << 20;
constexpr NSUInteger kMaxPackageEntries = 50000;
constexpr int kMaxDepth = 64;
constexpr size_t kChunk = 1 << 20;

WalkHook gHook;

struct Walk {
  CC_SHA256_CTX sha;
  unsigned long long bytes = 0;
  NSUInteger entries = 0;
  NSString *error = nil;
  NSMutableData *buffer = [NSMutableData dataWithLength:kChunk];
};

bool Refuse(Walk &walk, NSString *format, NSString *relative) {
  walk.error = [NSString stringWithFormat:format, relative.length ? relative : @"The folder"];
  return false;
}

bool Skipped(NSString *name, bool top) {
  static NSSet<NSString *> *names = [NSSet setWithArray:@[ @".git", @".hg", @".svn", @".DS_Store" ]];
  return [names containsObject:name] || (top && [name isEqualToString:@"_metadata"]);
}

void HashEntry(Walk &walk, char kind, NSString *relative, uint64_t size) {
  NSData *name = [relative dataUsingEncoding:NSUTF8StringEncoding];
  CC_SHA256_Update(&walk.sha, &kind, 1);
  CC_SHA256_Update(&walk.sha, name.bytes, (CC_LONG)name.length);
  CC_SHA256_Update(&walk.sha, "", 1);
  if (kind == 'F') CC_SHA256_Update(&walk.sha, &size, sizeof size);
}

NSArray<NSString *> *Names(int dirfd, bool *ok) {
  int listed = dup(dirfd);
  DIR *dir = listed >= 0 ? fdopendir(listed) : nullptr;
  if (!dir) {
    if (listed >= 0) close(listed);
    *ok = false;
    return nil;
  }
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  errno = 0;
  for (struct dirent *entry; (entry = readdir(dir));) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    [names addObject:[NSFileManager.defaultManager stringWithFileSystemRepresentation:entry->d_name length:strlen(entry->d_name)]];
    errno = 0;
  }
  *ok = errno == 0;
  closedir(dir);
  return [names sortedArrayUsingSelector:@selector(compare:)];
}

bool SameNode(const struct stat &a, const struct stat &b) { return a.st_dev == b.st_dev && a.st_ino == b.st_ino; }

bool CopyFile(Walk &walk, int dirfd, const char *name, const struct stat &seen, NSString *relative, int destfd) {
  int fd = openat(dirfd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  struct stat opened;
  if (fd < 0) return Refuse(walk, @"%@ couldn't be read", relative);
  if (fstat(fd, &opened) != 0 || !S_ISREG(opened.st_mode) || !SameNode(seen, opened)) {
    close(fd);
    return Refuse(walk, @"%@ changed while Ardia read it", relative);
  }
  int out = destfd >= 0 ? openat(destfd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0444) : -1;
  if (destfd >= 0 && out < 0) {
    close(fd);
    return Refuse(walk, @"Ardia couldn't copy %@", relative);
  }
  HashEntry(walk, 'F', relative, (uint64_t)opened.st_size);
  uint64_t total = 0;
  bool ok = true;
  for (;;) {
    ssize_t got = read(fd, walk.buffer.mutableBytes, kChunk);
    if (got < 0) ok = Refuse(walk, @"%@ couldn't be read", relative);
    if (got <= 0) break;
    total += (uint64_t)got;
    walk.bytes += (unsigned long long)got;
    if (walk.bytes > kMaxPackageBytes) {
      walk.error = @"The folder holds more than 512 MB";
      ok = false;
      break;
    }
    CC_SHA256_Update(&walk.sha, walk.buffer.bytes, (CC_LONG)got);
    for (ssize_t done = 0; out >= 0 && done < got;) {
      ssize_t wrote = write(out, (const char *)walk.buffer.bytes + done, (size_t)(got - done));
      if (wrote <= 0) {
        ok = Refuse(walk, @"Ardia couldn't copy %@", relative);
        break;
      }
      done += wrote;
    }
    if (!ok) break;
  }
  close(fd);
  if (out >= 0 && close(out) != 0 && ok) ok = Refuse(walk, @"Ardia couldn't copy %@", relative);
  if (ok && total != (uint64_t)opened.st_size) ok = Refuse(walk, @"%@ changed while Ardia read it", relative);
  return ok;
}

bool WalkFolder(Walk &walk, int dirfd, NSString *relative, int destfd, int depth) {
  if (depth > kMaxDepth) return Refuse(walk, @"%@ is nested too deeply", relative);
  bool listed = true;
  NSArray<NSString *> *names = Names(dirfd, &listed);
  if (!listed) return Refuse(walk, @"%@ couldn't be read", relative);
  for (NSString *name in names) {
    if (Skipped(name, !relative.length)) continue;
    NSString *child = relative.length ? [relative stringByAppendingPathComponent:name] : name;
    const char *raw = name.fileSystemRepresentation;
    if (++walk.entries > kMaxPackageEntries) {
      walk.error = [NSString stringWithFormat:@"The folder holds more than %lu entries", (unsigned long)kMaxPackageEntries];
      return false;
    }
    struct stat seen;
    if (fstatat(dirfd, raw, &seen, AT_SYMLINK_NOFOLLOW) != 0) return Refuse(walk, @"%@ couldn't be read", child);
    if (S_ISLNK(seen.st_mode)) return Refuse(walk, @"%@ is a link; an extension's folder can't hold links", child);
    if (S_ISREG(seen.st_mode)) {
      if (!CopyFile(walk, dirfd, raw, seen, child, destfd)) return false;
      continue;
    }
    if (!S_ISDIR(seen.st_mode)) return Refuse(walk, @"%@ isn't a file or a folder", child);
    int fd = openat(dirfd, raw, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
    struct stat opened;
    if (fd < 0) return Refuse(walk, @"%@ couldn't be read", child);
    if (fstat(fd, &opened) != 0 || !S_ISDIR(opened.st_mode) || !SameNode(seen, opened)) {
      close(fd);
      return Refuse(walk, @"%@ changed while Ardia read it", child);
    }
    int childDest = -1;
    if (destfd >= 0 && (mkdirat(destfd, raw, 0755) != 0 || (childDest = openat(destfd, raw, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)) < 0)) {
      close(fd);
      return Refuse(walk, @"Ardia couldn't copy %@", child);
    }
    HashEntry(walk, 'D', child, 0);
    if (gHook) gHook(child);
    bool ok = WalkFolder(walk, fd, child, childDest, depth + 1);
    close(fd);
    if (childDest >= 0) close(childDest);
    if (!ok) return false;
  }
  return true;
}

}

void SetWalkHook(WalkHook hook) { gHook = hook; }

NSString *TreeDigest(NSString *root, NSString *copyTo, NSString **error) {
  int rootfd = open(root.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
  if (rootfd < 0) {
    *error = @"The folder couldn't be read";
    return nil;
  }
  int destfd = copyTo ? open(copyTo.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) : -1;
  if (copyTo && destfd < 0) {
    close(rootfd);
    *error = @"Ardia couldn't make a copy of the extension";
    return nil;
  }
  Walk walk;
  CC_SHA256_Init(&walk.sha);
  bool ok = WalkFolder(walk, rootfd, @"", destfd, 0);
  close(rootfd);
  if (destfd >= 0) close(destfd);
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &walk.sha);
  if (!ok) {
    *error = walk.error;
    return nil;
  }
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
  return hex;
}

}
