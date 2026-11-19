import AppKit
import ArdiaCore

final class OpenSurfaces: NSObject {
  static let shared = OpenSurfaces()
  static let capturedLifetime: TimeInterval = 60

  enum Problem: Error {
    case missing(String)
    case refused(String)
  }

  private struct Captured {
    let link: String
    let items: [Any]
  }

  private final class Tracked {
    let id: String
    let kind: String
    let menu: NSMenu?
    let captured: Captured?
    let tab: String?
    let window: String?
    let keyless: Bool
    var pathPrefix: [Int] = []
    let openedAt = Date()
    init(id: String, kind: String, menu: NSMenu?, captured: Captured?, tab: String?, window: String?, keyless: Bool = false) {
      self.id = id
      self.kind = kind
      self.menu = menu
      self.captured = captured
      self.tab = tab
      self.window = window
      self.keyless = keyless
    }
    var expired: Bool { captured != nil && Date().timeIntervalSince(openedAt) > OpenSurfaces.capturedLifetime }
  }

  var send: ((String, [String: Any]) -> Void)?
  var capturesPageMenus = false {
    didSet { if !capturesPageMenus { dropCaptured { _ in true } } }
  }
  private var open: [Tracked] = []
  private var next = 0
  private var observers: [NSObjectProtocol] = []

  func start() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] in self?.began($0.object as? NSMenu) },
      center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] in self?.ended($0.object as? NSMenu) },
      center.addObserver(forName: Notification.Name("ArdiaPageMenuCaptured"), object: nil, queue: nil) { [weak self] in
        self?.captured($0.object as? [String: Any])
      },
    ]
  }

  private func newId(_ prefix: String) -> String {
    next += 1
    return "\(prefix)\(next)"
  }

  private static func targetClass(_ menu: NSMenu) -> String {
    for item in menu.items where !item.isSeparatorItem {
      if let target = item.target { return NSStringFromClass(type(of: target)) }
    }
    return ""
  }

  static func inMenuBar(_ menu: NSMenu) -> Bool {
    var current: NSMenu? = menu
    while let m = current {
      if m === NSApp.mainMenu { return true }
      current = m.supermenu
    }
    return false
  }

  private static func kind(of menu: NSMenu) -> String {
    if inMenuBar(menu) { return "menuBar" }
    let target = targetClass(menu)
    if target.contains("WebMenuRunner") { return "select" }
    if target.contains("MenuController") { return "page" }
    if target.contains("MenuChoice") { return "app" }
    return "other"
  }

  private static func focusedPage() -> (tab: String, window: String)? {
    guard let key = NSApp.keyWindow, let responder = key.firstResponder as? NSView,
          let tab = ArdiaWebView.appTabId(containing: responder), let window = WindowManager.shared.id(of: key) else { return nil }
    return (tab, window)
  }

  private static func selectOwner() -> (tab: String, window: String)? {
    for window in NSApp.windows where window.isVisible {
      if let anchor = selectAnchor(in: window.contentView), let tab = ArdiaWebView.appTabId(containing: anchor),
         let id = WindowManager.shared.id(of: anchor.window) {
        return (tab, id)
      }
    }
    return nil
  }

  private static func selectAnchor(in view: NSView?) -> NSView? {
    guard let view else { return nil }
    if NSStringFromClass(type(of: view)).contains("RenderWidgetHostViewCocoa"),
       view.subviews.contains(where: { type(of: $0) == NSView.self }) {
      return view
    }
    for sub in view.subviews { if let found = selectAnchor(in: sub) { return found } }
    return nil
  }

  private func barPrefix(_ menu: NSMenu) -> [Int]? {
    guard let bar = NSApp.mainMenu, menu.supermenu === bar, !open.contains(where: { $0.kind == "menuBar" }) else { return nil }
    let index = bar.indexOfItem(withSubmenu: menu)
    return index >= 0 ? [index] : nil
  }

  private func began(_ menu: NSMenu?) {
    guard let menu, !open.contains(where: { $0.menu === menu }) else { return }
    let prefix = barPrefix(menu)
    guard menu.supermenu == nil || menu === NSApp.mainMenu || prefix != nil else { return }
    let kind = Self.kind(of: menu)
    let owner: (tab: String?, window: String?) = switch kind {
    case "select": Self.selectOwner().map { ($0.tab, $0.window) } ?? (nil, nil)
    case "page": Self.focusedPage().map { ($0.tab, $0.window) } ?? (nil, nil)
    default: (nil, WindowManager.shared.id(of: NSApp.keyWindow))
    }
    let tracked = Tracked(id: newId("m"), kind: kind, menu: menu, captured: nil, tab: owner.tab, window: owner.window, keyless: NSApp.keyWindow == nil)
    tracked.pathPrefix = prefix ?? []
    open.append(tracked)
    send?("menuOpened", describe(tracked))
  }

  private func ended(_ menu: NSMenu?) {
    guard let menu, let index = open.firstIndex(where: { $0.menu === menu }) else { return }
    close(at: index)
  }

  private func close(at index: Int) {
    let tracked = open.remove(at: index)
    send?("menuClosed", ["id": tracked.id, "kind": tracked.kind])
  }

  private func dropCaptured(_ matching: (Tracked) -> Bool) {
    open.removeAll { $0.captured != nil && matching($0) }
  }

  private func captured(_ box: [String: Any]?) {
    guard let box, capturesPageMenus, let tab = box["tab"] as? String, let window = WindowManager.shared.id(of: box["window"] as? NSWindow) else { return }
    dropCaptured { _ in true }
    let menu = Captured(link: box["link"] as? String ?? "", items: box["items"] as? [Any] ?? [])
    let tracked = Tracked(id: newId("m"), kind: "page", menu: nil, captured: menu, tab: tab, window: window)
    open.append(tracked)
    send?("menuOpened", describe(tracked))
  }

  static func ref(of item: NSMenuItem) -> String {
    var titles: [String] = []
    var current: NSMenuItem? = item
    while let entry = current {
      titles.insert(entry.title, at: 0)
      current = entry.parent
    }
    let identity: String
    if let command = item as? CommandItem {
      identity = "cmd:" + (command.arg.map { "\(command.command):\($0)" } ?? command.command)
    } else if let action = item.action {
      identity = "sel:" + NSStringFromSelector(action)
    } else {
      identity = "none"
    }
    return identity + "@" + titles.joined(separator: "\u{1F}")
  }

  private static func row(_ item: NSMenuItem, path: [Int]) -> [String: Any] {
    var row: [String: Any] = [
      "path": path, "title": item.title, "enabled": item.isEnabled, "checked": item.state == .on, "mixed": item.state == .mixed,
      "separator": item.isSeparatorItem, "hidden": item.isHidden, "alternate": item.isAlternate, "ref": ref(of: item),
    ]
    if !item.keyEquivalent.isEmpty { row["key"] = item.keyEquivalent }
    if let command = item as? CommandItem {
      row["command"] = command.command
      if let arg = command.arg { row["arg"] = arg }
    } else if let action = item.action {
      row["action"] = NSStringFromSelector(action)
    }
    if let bound = boundWindow(of: item) { row["boundWindow"] = bound }
    if let submenu = item.submenu { row["submenu"] = rows(submenu, path: path, validate: false) }
    return row
  }

  private static func boundWindow(of item: NSMenuItem) -> String? {
    if let window = (item.target as? NSWindow) ?? (item.representedObject as? NSWindow) {
      return WindowManager.shared.id(of: window) ?? ""
    }
    guard let command = item as? CommandItem, let arg = command.arg else { return nil }
    if WindowManager.shared.window(arg) != nil { return arg }
    return command.command == "moveTabToWindow" && arg != "new" ? "" : nil
  }

  static func rows(_ menu: NSMenu, path: [Int], validate: Bool) -> [[String: Any]] {
    if validate { menu.update() }
    return menu.items.enumerated().compactMap { index, item in
      if let submenu = item.submenu, validate { submenu.update() }
      return item.isHidden ? nil : row(item, path: path + [index])
    }
  }

  private static func capturedRows(_ items: [Any], path: [Int]) -> [[String: Any]] {
    items.enumerated().compactMap { index, raw in
      guard let item = raw as? [String: Any], item["hidden"] as? Bool != true else { return nil }
      var row: [String: Any] = [
        "path": path + [index], "title": item["title"] ?? "", "enabled": item["enabled"] ?? false, "checked": item["checked"] ?? false,
        "separator": item["separator"] ?? false, "command": item["id"] ?? 0,
      ]
      if let submenu = item["submenu"] as? [Any] { row["submenu"] = capturedRows(submenu, path: path + [index]) }
      return row
    }
  }

  private func describe(_ tracked: Tracked) -> [String: Any] {
    var out: [String: Any] = ["id": tracked.id, "kind": tracked.kind, "openedAt": tracked.openedAt.timeIntervalSince1970 * 1000]
    if let tab = tracked.tab { out["tab"] = tab }
    if let window = tracked.window { out["window"] = window }
    if tracked.keyless { out["keyless"] = true }
    if tracked.kind == "menuBar", WindowManager.shared.anyIncognitoWindow { out["reflectsPrivate"] = true }
    if let menu = tracked.menu {
      out["items"] = Self.rows(menu, path: tracked.pathPrefix, validate: false)
    } else if let captured = tracked.captured {
      out["items"] = Self.capturedRows(captured.items, path: [])
      out["link"] = captured.link
      out["captured"] = true
    }
    return out
  }

  func list() -> [[String: Any]] {
    dropCaptured { $0.expired }
    return open.map(describe)
  }

  private func find(_ id: String) throws -> Tracked {
    dropCaptured { $0.expired }
    guard let tracked = open.first(where: { $0.id == id }) else { throw Problem.missing("There's no open menu \(id); menus.open lists them.") }
    return tracked
  }

  static let reflectsPrivate = "A private window is open and the menu bar can reflect it, so the ardia command can't read or use the menu bar until it closes."
  func trackedBarItem(_ id: String?, path: [Int], ref: String) throws -> NSMenuItem {
    guard !WindowManager.shared.anyIncognitoWindow else { throw Problem.refused(Self.reflectsPrivate) }
    var menu: NSMenu
    var steps = path
    if let id {
      let tracked = try find(id)
      guard tracked.kind == "menuBar", let root = tracked.menu else { throw Problem.refused("Menu \(id) isn't the menu bar.") }
      guard path.starts(with: tracked.pathPrefix) else { throw Problem.missing("That path isn't in menu \(id).") }
      menu = root
      steps = Array(path.dropFirst(tracked.pathPrefix.count))
    } else {
      guard let bar = NSApp.mainMenu else { throw Problem.missing("There's no menu bar.") }
      menu = bar
    }
    guard let last = steps.last else { throw Problem.missing("path names a menu bar item.") }
    for step in steps.dropLast() {
      guard step >= 0, step < menu.numberOfItems, let submenu = menu.item(at: step)?.submenu else { throw Problem.missing("There's no menu at that path.") }
      menu = submenu
    }
    menu.update()
    guard last >= 0, last < menu.numberOfItems, let item = menu.item(at: last), !item.isSeparatorItem, item.submenu == nil, !item.isHidden else {
      throw Problem.missing("There's no menu bar item at that path.")
    }
    guard Self.ref(of: item) == ref else { throw Problem.refused("The menu bar changed since it was read; read it again.") }
    guard item.isEnabled else { throw Problem.refused("\(item.title) is turned off.") }
    return item
  }

  func dismiss(_ id: String) throws {
    let tracked = try find(id)
    if tracked.captured != nil, let index = open.firstIndex(where: { $0 === tracked }) { close(at: index) } else { tracked.menu?.cancelTracking() }
  }
}

enum MenuBarAction {
  static let allowedActions: Set<String> = [
    "undo:", "redo:", "cut:", "copy:", "paste:", "pasteAndMatchStyle:", "pasteAsPlainText:", "delete:", "selectAll:",
    "performMiniaturize:", "performZoom:", "toggleFullScreen:", "miniaturizeAll:", "arrangeWindowsInFront:", "arrangeInFront:", "toggleKeepOnTop:",
    "toggleContinuousSpellChecking:", "toggleGrammarChecking:", "toggleAutomaticSpellingCorrection:", "toggleSmartInsertDelete:",
    "toggleAutomaticQuoteSubstitution:", "toggleAutomaticDashSubstitution:", "toggleAutomaticLinkDetection:", "toggleAutomaticDataDetection:",
    "toggleAutomaticTextReplacement:", "uppercaseWord:", "lowercaseWord:", "capitalizeWord:", "startSpeaking:", "stopSpeaking:",
  ]
  static let appWideActions: Set<String> = ["miniaturizeAll:", "arrangeInFront:", "arrangeWindowsInFront:"]

  static func perform(menu id: String?, path: [Int], ref: String, windowId: String) throws -> String {
    let item = try OpenSurfaces.shared.trackedBarItem(id, path: path, ref: ref)
    guard let action = item.action else { throw OpenSurfaces.Problem.missing("There's no menu bar item at that path.") }
    if item is CommandItem { throw OpenSurfaces.Problem.refused("That item runs an Ardia command; run it with run.") }
    let name = NSStringFromSelector(action)
    guard allowedActions.contains(name) else {
      throw OpenSurfaces.Problem.refused("\(item.title) isn't an editing or window item the ardia command may choose (quitting, hiding, closing windows and updates have their own paths or stay with you).")
    }
    guard let key = NSApp.keyWindow else {
      throw OpenSurfaces.Problem.refused("No window is key, so \(item.title) would have no window of its own to act on.")
    }
    guard let window = WindowManager.shared.window(windowId), key === window else {
      throw OpenSurfaces.Problem.refused("\(item.title) acts on the key window, and that isn't the window the ardia command named.")
    }
    let target: AnyObject
    if appWideActions.contains(name) {
      guard !WindowManager.shared.anyIncognitoWindow else { throw OpenSurfaces.Problem.refused("\(item.title) acts on every window, and a private window is open.") }
      if let fixed = item.target {
        guard fixed === MenuTarget.shared, fixed.responds(to: action) else { throw OpenSurfaces.Problem.refused("\(item.title) can't be sent to an explicit target.") }
        target = fixed
      } else {
        guard NSApp.responds(to: action) else { throw OpenSurfaces.Problem.refused("\(item.title) can't be sent to an explicit target.") }
        target = NSApp
      }
    } else {
      guard item.target == nil, window.responds(to: action) else {
        throw OpenSurfaces.Problem.refused("\(item.title) can't be sent to the named window itself, only along the responder chain, so the ardia command doesn't choose it.")
      }
      target = window
    }
    guard NSApp.sendAction(action, to: target, from: item) else { throw OpenSurfaces.Problem.refused("\(item.title) did nothing.") }
    return item.title
  }
}
