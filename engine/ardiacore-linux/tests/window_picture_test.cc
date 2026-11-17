#include <cassert>
#include <cstdio>
#include <optional>
#include <string>
#include <string_view>

#include "ardia/linux/ac_linux_window_picture.h"

namespace picture = ardia::linux_window_picture;

int main() {
  static_assert(std::string_view(picture::kSnapshotCall) == "ArdiaApp.devSnapshotWindow");
  static_assert(sizeof(picture::kWindowPictureCapabilities) / sizeof(picture::kWindowPictureCapabilities[0]) == 1);
  assert(std::string_view(picture::kWindowPictureCapabilities[0]) == picture::kSnapshotCall);

  // The Mac's contract: (windowId, absolutePath, transparent?). The background is filled unless the caller asks
  // for the window's own alpha.
  auto opaque = picture::ParseRequest("main", "/tmp/shot.png", std::nullopt);
  assert(opaque && opaque->window_id == "main" && opaque->path == "/tmp/shot.png" && !opaque->transparent);
  auto clear = picture::ParseRequest("window-7", "/tmp/a b/shot.png", true);
  assert(clear && clear->window_id == "window-7" && clear->path == "/tmp/a b/shot.png" && clear->transparent);
  auto filled = picture::ParseRequest("main", "/shot.png", false);
  assert(filled && !filled->transparent);

  // A relative path would land in the engine's working directory, which no caller means, so it is refused.
  for (const char* relative : {"", "shot.png", "./shot.png", "../shot.png", "~/shot.png", "tmp/shot.png", " /tmp/shot.png"}) {
    assert(!picture::ParseRequest("main", relative, std::nullopt));
  }
  // The root directory and a trailing separator name a directory, not a file.
  assert(!picture::ParseRequest("main", "/", std::nullopt));
  assert(!picture::ParseRequest("main", "/tmp/", std::nullopt));
  // A NUL would end the path early in the C library, so the file would land somewhere else than the text says.
  assert(!picture::ParseRequest("main", std::string("/tmp/shot\0.png", 14), std::nullopt));
  assert(!picture::ParseRequest(std::string("ma\0in", 5), "/tmp/shot.png", std::nullopt));
  // A window needs an id.
  assert(!picture::ParseRequest("", "/tmp/shot.png", std::nullopt));
  std::puts("ok");
  return 0;
}
