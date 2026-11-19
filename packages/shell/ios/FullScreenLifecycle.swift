import AppKit

final class FullScreenLifecycle {
  static let shared = FullScreenLifecycle()
  static let didFailToEnter = NSNotification.Name("ArdiaWindowDidFailToEnterFullScreen")
  static let didFailToExit = NSNotification.Name("ArdiaWindowDidFailToExitFullScreen")

  private struct Waiter {
    let window: ObjectIdentifier
    let after: Int
    let settle: () -> Void
  }

  private var generation = 0
  private var inFlight: [ObjectIdentifier: Int] = [:]
  private var waiters: [Int: Waiter] = [:]
  private var nextWaiter = 0
  private var observers: [NSObjectProtocol] = []

  var latestGeneration: Int { generation }

  func start() {
    guard observers.isEmpty else { return }
    installFailureNotifications()
    let center = NotificationCenter.default
    for name in [NSWindow.willEnterFullScreenNotification, NSWindow.willExitFullScreenNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in self?.began(note.object) })
    }
    for name in [NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification, NSWindow.willCloseNotification, Self.didFailToEnter, Self.didFailToExit] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in self?.ended(note.object) })
    }
  }

  func isUnresolved(_ window: NSWindow) -> Bool { inFlight[ObjectIdentifier(window)] != nil }

  func waitForTransition(of window: NSWindow, startedAfter after: Int, settle: @escaping () -> Void) -> Int {
    nextWaiter += 1
    waiters[nextWaiter] = Waiter(window: ObjectIdentifier(window), after: after, settle: settle)
    return nextWaiter
  }

  func stopWaiting(_ token: Int) { waiters[token] = nil }

  private func began(_ object: Any?) {
    guard let window = object as? NSWindow else { return }
    generation += 1
    inFlight[ObjectIdentifier(window)] = generation
  }

  private func ended(_ object: Any?) {
    guard let window = object as? NSWindow else { return }
    let key = ObjectIdentifier(window)
    guard let finished = inFlight.removeValue(forKey: key) else { return }
    let ready = waiters.filter { $0.value.window == key && $0.value.after < finished }
    for (token, waiter) in ready {
      waiters[token] = nil
      waiter.settle()
    }
  }

  private func installFailureNotifications() {
    guard let cls = NSClassFromString("ViewsNSWindowDelegate") else { return }
    forward(#selector(NSWindowDelegate.windowDidFailToEnterFullScreen(_:)), on: cls, as: Self.didFailToEnter)
    forward(#selector(NSWindowDelegate.windowDidFailToExitFullScreen(_:)), on: cls, as: Self.didFailToExit)
  }

  private func forward(_ selector: Selector, on cls: AnyClass, as name: NSNotification.Name) {
    typealias Failed = @convention(c) (AnyObject, Selector, NSWindow) -> Void
    let original = class_getInstanceMethod(cls, selector).map { unsafeBitCast(method_getImplementation($0), to: Failed.self) }
    let block: @convention(block) (AnyObject, NSWindow) -> Void = { delegate, window in
      original?(delegate, selector, window)
      NotificationCenter.default.post(name: name, object: window)
    }
    let implementation = imp_implementationWithBlock(block)
    if let method = class_getInstanceMethod(cls, selector) {
      method_setImplementation(method, implementation)
    } else {
      class_addMethod(cls, selector, implementation, "v@:@")
    }
  }
}
