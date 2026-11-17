#ifndef ARDIA_LINUX_AC_LINUX_WINDOW_PICTURE_H_
#define ARDIA_LINUX_AC_LINUX_WINDOW_PICTURE_H_

#include <optional>
#include <string>
#include <string_view>

// The window snapshot the Mac's DevModule serves as devSnapshotWindow(windowId, path, transparent?): the
// window's composited contents written as a PNG. The host offers it to an isolated dev instance only.
namespace ardia::linux_window_picture {

inline constexpr char kSnapshotCall[] = "ArdiaApp.devSnapshotWindow";
inline constexpr const char* kWindowPictureCapabilities[] = {"ArdiaApp.devSnapshotWindow"};

struct SnapshotRequest {
  std::string window_id;
  std::string path;
  bool transparent;
};

// A snapshot is written where the caller says, so the path must name one file by its full path: a relative one
// would land in the engine's working directory, and a NUL would end it early in the C library. The background is
// filled unless the caller asks for the window's own alpha.
inline std::optional<SnapshotRequest> ParseRequest(std::string_view window_id,
                                                   std::string_view path,
                                                   std::optional<bool> transparent) {
  if (window_id.empty() || window_id.find('\0') != std::string_view::npos) return std::nullopt;
  if (path.empty() || path.front() != '/' || path.back() == '/' || path.find('\0') != std::string_view::npos) {
    return std::nullopt;
  }
  return SnapshotRequest{std::string(window_id), std::string(path), transparent.value_or(false)};
}

}  // namespace ardia::linux_window_picture

#endif  // ARDIA_LINUX_AC_LINUX_WINDOW_PICTURE_H_
