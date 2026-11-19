import AppKit
import ArdiaCore

extension WindowManager {
  static let fullScreenTransitionLimit: TimeInterval = 6
  static let coordinateLimit: CGFloat = 100_000

  func geometry(id: String) -> [String: Any]? {
    guard let window = window(id) else { return nil }
    let f = window.frame
    let fullScreen = inFullScreen(id, window)
    return [
      "frame": [f.minX, f.minY, f.width, f.height],
      "zoomed": !fullScreen && window.isZoomed,
      "fullScreen": fullScreen,
      "pageFullScreen": ArdiaChromeWindowHost.windowFullScreenIs(forPage: window),
      "miniaturized": window.isMiniaturized,
      "visible": window.isVisible,
      "display": ArdiaDisplayIdentity.identifier(of: window.screen) ?? NSNull(),
    ]
  }

  func setFrame(id: String, frame: CGRect) -> [String: Any]? {
    guard let window = window(id), !inFullScreen(id, window), window.parent == nil else { return geometry(id: id) }
    guard Self.isUsable(frame) else { return refused(id, "invalid") }
    guard let screen = Self.screen(holding: frame) else { return refused(id, "offscreen") }
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

  func setFullScreen(id: String, on: Bool, done: @escaping ([String: Any]?) -> Void) {
    guard let window = window(id), inFullScreen(id, window) != on, isMainWindow(window),
          !ArdiaChromeWindowHost.windowFullScreenIs(forPage: window)
    else { return done(geometry(id: id)) }
    var observers: [NSObjectProtocol] = []
    var finished = false
    let finish = { [weak self] in
      guard !finished else { return }
      finished = true
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      done(self?.geometry(id: id))
    }
    let ended: [NSNotification.Name] = [NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification, NSWindow.willCloseNotification]
    for name in ended {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { _ in
        DispatchQueue.main.async(execute: finish)
      })
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.fullScreenTransitionLimit, execute: finish)
    window.toggleFullScreen(nil)
  }

  private func refused(_ id: String, _ reason: String) -> [String: Any]? {
    guard var answer = geometry(id: id) else { return nil }
    answer["refused"] = reason
    return answer
  }

  private func inFullScreen(_ id: String, _ window: NSWindow) -> Bool {
    isFullScreen(id) || window.styleMask.contains(.fullScreen)
  }

  private static func isUsable(_ frame: CGRect) -> Bool {
    let values = [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height]
    return values.allSatisfy { $0.isFinite && abs($0) <= coordinateLimit } && frame.width > 0 && frame.height > 0
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
