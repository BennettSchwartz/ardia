import AppKit
import ArdiaCore

extension WindowManager {
  static let fullScreenTransitionLimit: TimeInterval = 6
  static let fullScreenRecoveryLimit: TimeInterval = 30
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
    if let owner = FullScreenRequest.owners[id] {
      guard owner.age >= Self.fullScreenRecoveryLimit else { return done(marked(id, "transition", "busy")) }
      owner.release()
    }
    guard let window = window(id), inFullScreen(id, window) != on, isMainWindow(window),
          !ArdiaChromeWindowHost.windowFullScreenIs(forPage: window)
    else { return done(geometry(id: id)) }
    let request = FullScreenRequest(windowId: id, done: done)
    let finished = on ? NSWindow.didEnterFullScreenNotification : NSWindow.didExitFullScreenNotification
    for name in [finished, NSWindow.willCloseNotification] {
      request.observe(name, of: window) { [weak self, weak request] in
        guard let request, request.owns else { return }
        request.release()
        request.reply(self?.geometry(id: id))
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.fullScreenTransitionLimit) { [weak self, weak request] in
      guard let request, request.owns else { return }
      request.reply(self?.marked(id, "transition", "timeout"))
    }
    window.toggleFullScreen(nil)
  }

  private func marked(_ id: String, _ key: String, _ value: String) -> [String: Any]? {
    guard var answer = geometry(id: id) else { return nil }
    answer[key] = value
    return answer
  }

  private func refused(_ id: String, _ reason: String) -> [String: Any]? { marked(id, "refused", reason) }

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

final class FullScreenRequest {
  static var owners: [String: FullScreenRequest] = [:]

  let windowId: String
  private let started = Date()
  private var observers: [NSObjectProtocol] = []
  private var done: (([String: Any]?) -> Void)?

  init(windowId: String, done: @escaping ([String: Any]?) -> Void) {
    self.windowId = windowId
    self.done = done
    Self.owners[windowId] = self
  }

  var owns: Bool { Self.owners[windowId] === self }
  var age: TimeInterval { Date().timeIntervalSince(started) }

  func observe(_ name: NSNotification.Name, of window: NSWindow, then: @escaping () -> Void) {
    observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { _ in
      DispatchQueue.main.async(execute: then)
    })
  }

  func release() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    if owns { Self.owners[windowId] = nil }
  }

  func reply(_ answer: [String: Any]?) {
    guard let done else { return }
    self.done = nil
    done(answer)
  }
}
