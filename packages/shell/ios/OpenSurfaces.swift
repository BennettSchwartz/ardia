import AppKit
import ArdiaCore

final class OpenSurfaces: NSObject {
  static let shared = OpenSurfaces()

  enum Problem: Error {
    case missing(String)
    case refused(String)
  }

  private final class Tracked {
    let id: String
    let kind: String
    let menu: NSMenu?
    let held: NSMutableDictionary?
    let tab: String?
    let openedAt = Date()
    init(id: String, kind: String, menu: NSMenu?, held: NSMutableDictionary?, tab: String?) {
      self.id = id
      self.kind = kind
      self.menu = menu
      self.held = held
      self.tab = tab
    }
  }

  var send: ((String, [String: Any]) -> Void)?
  var holdsPageMenus = false
  private var open: [Tracked] = []
  private var next = 0
  private var colorPanelId: String?
  private var colorPanelTab: String?
  private var observers: [NSObjectProtocol] = []

  func start() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] in self?.began($0.object as? NSMenu) },
      center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] in self?.ended($0.object as? NSMenu) },
      center.addObserver(forName: Notification.Name("ArdiaPageMenuOpened"), object: nil, queue: nil) { [weak self] in self?.heldOpened($0.object as? NSMutableDictionary) },
      center.addObserver(forName: Notification.Name("ArdiaPageMenuClosed"), object: nil, queue: nil) { [weak self] in self?.heldClosed($0.object as? NSMutableDictionary) },
      center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { [weak self] in self?.colorPanelShown($0.object as? NSWindow) },
      center.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: nil, queue: .main) { [weak self] in self?.colorPanelShown($0.object as? NSWindow) },
      center.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { [weak self] in self?.colorPanelClosed($0.object as? NSWindow) },
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

  private static func inMenuBar(_ menu: NSMenu) -> Bool {
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

  private static func pageTab() -> String? {
    if let responder = NSApp.keyWindow?.firstResponder as? NSView, let tab = ArdiaWebView.appTabId(containing: responder) { return tab }
    for window in NSApp.windows where window.isVisible {
      if let tab = selectAnchor(in: window.contentView) { return tab }
    }
    return nil
  }

  private static func selectAnchor(in view: NSView?) -> String? {
    guard let view else { return nil }
    if NSStringFromClass(type(of: view)).contains("RenderWidgetHostViewCocoa"),
       view.subviews.contains(where: { type(of: $0) == NSView.self }) {
      return ArdiaWebView.appTabId(containing: view)
    }
    for sub in view.subviews { if let found = selectAnchor(in: sub) { return found } }
    return nil
  }

  private func began(_ menu: NSMenu?) {
    guard let menu, menu.supermenu == nil || menu === NSApp.mainMenu, !open.contains(where: { $0.menu === menu }) else { return }
    let kind = Self.kind(of: menu)
    let tracked = Tracked(id: newId("m"), kind: kind, menu: menu, held: nil, tab: kind == "select" || kind == "page" ? Self.pageTab() : nil)
    open.append(tracked)
    send?("menuOpened", describe(tracked))
  }

  private func ended(_ menu: NSMenu?) {
    guard let menu, let index = open.firstIndex(where: { $0.menu === menu }) else { return }
    let tracked = open.remove(at: index)
    send?("menuClosed", ["id": tracked.id, "kind": tracked.kind])
  }

  private func heldOpened(_ box: NSMutableDictionary?) {
    guard let box, holdsPageMenus else { return }
    box["held"] = true
    let tab = (box["tab"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let tracked = Tracked(id: newId("m"), kind: "page", menu: nil, held: box, tab: tab)
    open.append(tracked)
    send?("menuOpened", describe(tracked))
  }

  private func heldClosed(_ box: NSMutableDictionary?) {
    guard let box, let index = open.firstIndex(where: { $0.held === box }) else { return }
    let tracked = open.remove(at: index)
    send?("menuClosed", ["id": tracked.id, "kind": tracked.kind])
  }

  private static func row(_ item: NSMenuItem, path: [Int]) -> [String: Any] {
    var row: [String: Any] = [
      "path": path, "title": item.title, "enabled": item.isEnabled, "checked": item.state == .on, "mixed": item.state == .mixed,
      "separator": item.isSeparatorItem, "hidden": item.isHidden, "alternate": item.isAlternate,
    ]
    if !item.keyEquivalent.isEmpty { row["key"] = item.keyEquivalent }
    if let command = item as? CommandItem {
      row["command"] = command.command
      if let arg = command.arg { row["arg"] = arg }
    } else if let action = item.action {
      row["action"] = NSStringFromSelector(action)
    }
    if let submenu = item.submenu { row["submenu"] = rows(submenu, path: path, validate: false) }
    return row
  }

  static func rows(_ menu: NSMenu, path: [Int], validate: Bool) -> [[String: Any]] {
    if validate { menu.update() }
    return menu.items.enumerated().compactMap { index, item in
      if let submenu = item.submenu, validate { submenu.update() }
      return item.isHidden ? nil : row(item, path: path + [index])
    }
  }

  private static func heldRows(_ items: [Any], path: [Int]) -> [[String: Any]] {
    items.enumerated().compactMap { index, raw in
      guard let item = raw as? [String: Any], item["hidden"] as? Bool != true else { return nil }
      var row: [String: Any] = [
        "path": path + [index], "title": item["title"] ?? "", "enabled": item["enabled"] ?? false, "checked": item["checked"] ?? false,
        "separator": item["separator"] ?? false, "command": item["id"] ?? 0,
      ]
      if let submenu = item["submenu"] as? [Any] { row["submenu"] = heldRows(submenu, path: path + [index]) }
      return row
    }
  }

  private func describe(_ tracked: Tracked) -> [String: Any] {
    var out: [String: Any] = ["id": tracked.id, "kind": tracked.kind, "openedAt": tracked.openedAt.timeIntervalSince1970 * 1000]
    if let tab = tracked.tab { out["tab"] = tab }
    if let menu = tracked.menu {
      out["items"] = Self.rows(menu, path: [], validate: false)
    } else if let held = tracked.held {
      out["items"] = Self.heldRows(held["items"] as? [Any] ?? [], path: [])
      out["link"] = held["link"] ?? ""
    }
    return out
  }

  func list() -> [[String: Any]] {
    var all = open.map(describe)
    if let panel = colorPanel() { all.append(panel) }
    return all
  }

  private func find(_ id: String) throws -> Tracked {
    guard let tracked = open.first(where: { $0.id == id }) else { throw Problem.missing("There's no open menu \(id); menus.open lists them.") }
    return tracked
  }

  func choose(_ id: String, path: [Int]) throws -> String {
    let tracked = try find(id)
    guard !path.isEmpty else { throw Problem.missing("path names an item.") }
    if let held = tracked.held {
      var items = held["items"] as? [Any] ?? []
      var found: [String: Any]?
      for (depth, step) in path.enumerated() {
        guard step >= 0, step < items.count, let item = items[step] as? [String: Any] else { throw Problem.missing("There's no item at that path.") }
        if depth == path.count - 1 { found = item } else { items = item["submenu"] as? [Any] ?? [] }
      }
      guard let item = found, item["separator"] as? Bool != true, item["submenu"] == nil else { throw Problem.refused("That item opens a submenu or is a separator.") }
      guard item["enabled"] as? Bool == true else { throw Problem.refused("That item is turned off.") }
      held["pick"] = ["command": item["id"] ?? 0, "path": path, "flags": 0]
      return item["title"] as? String ?? ""
    }
    guard let root = tracked.menu else { throw Problem.missing("That menu closed.") }
    var menu = root
    for step in path.dropLast() {
      guard step >= 0, step < menu.numberOfItems, let submenu = menu.item(at: step)?.submenu else { throw Problem.missing("There's no submenu at that path.") }
      menu = submenu
    }
    let last = path.last!
    guard last >= 0, last < menu.numberOfItems, let item = menu.item(at: last) else { throw Problem.missing("There's no item at that path.") }
    guard !item.isSeparatorItem, item.submenu == nil else { throw Problem.refused("That item opens a submenu or is a separator.") }
    guard item.isEnabled else { throw Problem.refused("That item is turned off.") }
    menu.performActionForItem(at: last)
    root.cancelTracking()
    return item.title
  }

  func dismiss(_ id: String) throws {
    if id == colorPanelId {
      NSColorPanel.shared.close()
      return
    }
    let tracked = try find(id)
    if let held = tracked.held { held["done"] = true } else { tracked.menu?.cancelTracking() }
  }

  private static var chromiumPanel: NSColorPanel? {
    guard NSColorPanel.sharedColorPanelExists else { return nil }
    let panel = NSColorPanel.shared
    guard let target = panel.target, NSStringFromClass(type(of: target)).contains("ColorPanelListener") else { return nil }
    return panel
  }

  private func colorPanelShown(_ window: NSWindow?) {
    guard let window, window === Self.chromiumPanel, colorPanelId == nil, window.isVisible || window.isKeyWindow else { return }
    colorPanelId = newId("c")
    colorPanelTab = Self.pageTab()
    if let panel = colorPanel() { send?("colorPanelOpened", panel) }
  }

  private func colorPanelClosed(_ window: NSWindow?) {
    guard let window, window is NSColorPanel, let id = colorPanelId else { return }
    colorPanelId = nil
    colorPanelTab = nil
    send?("colorPanelClosed", ["id": id, "kind": "color"])
  }

  private func colorPanel() -> [String: Any]? {
    guard let id = colorPanelId, let panel = Self.chromiumPanel else { return nil }
    var out: [String: Any] = ["id": id, "kind": "color", "color": Self.hex(panel.color)]
    if let tab = colorPanelTab { out["tab"] = tab }
    return out
  }

  static func hex(_ color: NSColor) -> String {
    guard let rgb = color.usingColorSpace(.genericRGB) else { return "#000000" }
    let part = { (v: CGFloat) in String(format: "%02x", Int((min(max(v, 0), 1) * 255).rounded())) }
    return "#" + part(rgb.redComponent) + part(rgb.greenComponent) + part(rgb.blueComponent)
  }

  func chooseColor(_ id: String, hex: String, close: Bool) throws -> String {
    guard id == colorPanelId, let panel = Self.chromiumPanel else { throw Problem.missing("There's no open color panel \(id); menus.open lists it.") }
    guard let rgb = Self.components(hex) else { throw Problem.refused("color is # and six hex digits.") }
    panel.color = NSColor(genericRed: rgb[0], green: rgb[1], blue: rgb[2], alpha: 1)
    if let action = panel.action { NSApp.sendAction(action, to: panel.target, from: panel) }
    if close { panel.close() }
    return hex.lowercased()
  }

  static func components(_ hex: String) -> [CGFloat]? {
    guard hex.count == 7, hex.first == "#", let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    return [16, 8, 0].map { CGFloat((value >> $0) & 0xff) / 255 }
  }
}

enum MenuBarAction {
  static let refusedActions: Set<String> = ["terminate:", "hide:", "hideOtherApplications:", "orderFrontCharacterPalette:", "startDictation:"]

  static func perform(_ path: [Int]) throws -> String {
    guard var menu = NSApp.mainMenu, let last = path.last else { throw OpenSurfaces.Problem.missing("path names a menu bar item.") }
    for step in path.dropLast() {
      guard step >= 0, step < menu.numberOfItems, let submenu = menu.item(at: step)?.submenu else { throw OpenSurfaces.Problem.missing("There's no menu at that path.") }
      menu = submenu
    }
    menu.update()
    guard last >= 0, last < menu.numberOfItems, let item = menu.item(at: last), !item.isSeparatorItem, item.submenu == nil, let action = item.action else {
      throw OpenSurfaces.Problem.missing("There's no menu bar item at that path.")
    }
    if item is CommandItem { throw OpenSurfaces.Problem.refused("That item runs an Ardia command; run it with run.") }
    if refusedActions.contains(NSStringFromSelector(action)) { throw OpenSurfaces.Problem.refused("\(item.title) would quit, hide Ardia or open system input, so the ardia command can't choose it.") }
    guard item.isEnabled else { throw OpenSurfaces.Problem.refused("\(item.title) is turned off.") }
    menu.performActionForItem(at: last)
    return item.title
  }
}
