import AppKit
import ArdiaCore

extension WindowManager {
  func geometry(id: String) -> [String: Any]? {
    guard let window = window(id) else { return nil }
    let f = window.frame
    let fullScreen = inFullScreen(id, window)
    return [
      "frame": [f.minX, f.minY, f.width, f.height],
      "zoomed": !fullScreen && window.isZoomed,
      "fullScreen": fullScreen,
      "miniaturized": window.isMiniaturized,
      "visible": window.isVisible,
      "display": ArdiaDisplayIdentity.identifier(of: window.screen) ?? NSNull(),
    ]
  }

  func setFrame(id: String, frame: CGRect) -> [String: Any]? {
    guard let window = window(id), !inFullScreen(id, window), window.parent == nil else { return geometry(id: id) }
    guard let screen = Self.screen(holding: frame) ?? window.screen ?? NSScreen.main else { return geometry(id: id) }
    let room = screen.visibleFrame.size
    let size = CGSize(
      width: min(max(frame.width, window.minSize.width), max(room.width, window.minSize.width)),
      height: min(max(frame.height, window.minSize.height), max(room.height, window.minSize.height))
    )
    let wanted = CGRect(origin: frame.origin, size: size)
    window.setFrame(window.constrainFrameRect(wanted, to: screen), display: window.isVisible)
    flushFrameReports()
    return geometry(id: id)
  }

  func setZoomed(id: String, on: Bool) -> [String: Any]? {
    guard let window = window(id), !inFullScreen(id, window), window.isZoomed != on else { return geometry(id: id) }
    window.zoom(nil)
    flushFrameReports()
    return geometry(id: id)
  }

  func setFullScreen(id: String, on: Bool) -> [String: Any]? {
    guard let window = window(id), inFullScreen(id, window) != on, isMainWindow(window) else { return geometry(id: id) }
    guard !ArdiaChromeWindowHost.windowFullScreenIs(forPage: window) else { return geometry(id: id) }
    window.toggleFullScreen(nil)
    return geometry(id: id)
  }

  private func inFullScreen(_ id: String, _ window: NSWindow) -> Bool {
    isFullScreen(id) || window.styleMask.contains(.fullScreen)
  }

  private static func screen(holding frame: CGRect) -> NSScreen? {
    let overlap = { (screen: NSScreen) -> CGFloat in
      let shared = screen.frame.intersection(frame)
      return shared.isNull ? 0 : shared.width * shared.height
    }
    guard let best = NSScreen.screens.max(by: { overlap($0) < overlap($1) }), overlap(best) > 0 else { return nil }
    return best
  }
}
