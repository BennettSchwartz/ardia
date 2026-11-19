import AppKit

final class FullScreenLifecycle {
  static let shared = FullScreenLifecycle()

  struct Timing {
    var settleCheckAfter: TimeInterval = 6
    var checkEvery: TimeInterval = 1
    var giveUpAfter: TimeInterval = 30
  }

  private struct Waiter {
    let window: ObjectIdentifier
    let after: Int
    let settle: () -> Void
  }

  private struct Transition {
    let generation: Int
    weak var window: NSWindow?
    let began: Date
    var lastState: Bool?
  }

  var timing = Timing()
  var stateOf: (NSWindow) -> Bool = { $0.styleMask.contains(.fullScreen) }
  var log: (String) -> Void = { NSLog("%@", $0) }

  private var generation = 0
  private var inFlight: [ObjectIdentifier: Transition] = [:]
  private var waiters: [Int: Waiter] = [:]
  private var nextWaiter = 0
  private var observers: [NSObjectProtocol] = []

  var latestGeneration: Int { generation }

  func start() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    for name in [NSWindow.willEnterFullScreenNotification, NSWindow.willExitFullScreenNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in self?.began(note.object) })
    }
    for name in [NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification, NSWindow.willCloseNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
        guard let window = note.object as? NSWindow else { return }
        self?.end(ObjectIdentifier(window))
      })
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
    let key = ObjectIdentifier(window)
    let transition = Transition(generation: generation, window: window, began: Date(), lastState: nil)
    inFlight[key] = transition
    scheduleCheck(key, generation: transition.generation, after: timing.settleCheckAfter)
  }

  private func scheduleCheck(_ key: ObjectIdentifier, generation: Int, after delay: TimeInterval) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.check(key, generation: generation) }
  }

  private func check(_ key: ObjectIdentifier, generation: Int) {
    guard var transition = inFlight[key], transition.generation == generation else { return }
    guard let window = transition.window else { return end(key) }
    if Date().timeIntervalSince(transition.began) >= timing.giveUpAfter {
      log("[fullscreen] window \(window.windowNumber): no end to the full-screen transition after \(Int(timing.giveUpAfter)) s; clearing it")
      return end(key)
    }
    let state = stateOf(window)
    if transition.lastState == state { return end(key) }
    transition.lastState = state
    inFlight[key] = transition
    scheduleCheck(key, generation: generation, after: timing.checkEvery)
  }

  private func end(_ key: ObjectIdentifier) {
    guard let finished = inFlight.removeValue(forKey: key) else { return }
    let ready = waiters.filter { $0.value.window == key && $0.value.after < finished.generation }
    for (token, waiter) in ready {
      waiters[token] = nil
      DispatchQueue.main.async(execute: waiter.settle)
    }
  }
}
