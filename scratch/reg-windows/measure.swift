import AppKit
import ApplicationServices

let args = CommandLine.arguments
let pid = Int32(args[1])!
let x = Double(args[2])!, y = Double(args[3])!
let app = AXUIElementCreateApplication(pid)
func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v }
func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }
func frontLayer0Owner() -> Int32? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
    let b = w[kCGWindowBounds as String] as! [String: Double]
    if (b["Width"] ?? 0) < 200 { continue }
    return w[kCGWindowOwnerPID as String] as? Int32
  }
  return nil
}
func keyTitle() -> String? {
  guard let w = attr(app, kAXFocusedWindowAttribute) else { return nil }
  return attr(w as! AXUIElement, kAXTitleAttribute) as? String
}
func minimizeEnabled() -> String {
  guard let bar = attr(app, kAXMenuBarAttribute) else { return "nobar" }
  for top in (attr(bar as! AXUIElement, kAXChildrenAttribute) as? [AnyObject]) ?? [] {
    guard (attr(top as! AXUIElement, kAXTitleAttribute) as? String) == "Window" else { continue }
    for m in (attr(top as! AXUIElement, kAXChildrenAttribute) as? [AnyObject]) ?? [] {
      for item in (attr(m as! AXUIElement, kAXChildrenAttribute) as? [AnyObject]) ?? [] {
        if (attr(item as! AXUIElement, kAXTitleAttribute) as? String) == "Minimize" { return "\(attr(item as! AXUIElement, kAXEnabledAttribute) as? Bool ?? false)" }
      }
    }
  }
  return "nomenu"
}
let src = CGEventSource(stateID: .hidSystemState)
let p = CGPoint(x: x, y: y)
CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(150000)
let t0 = now()
CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
usleep(40000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
var tFront: Double?, tTop: Double?, tKey: Double?
var lastTop: Int32? = nil
var topFlips: [String] = []
while now() - t0 < 2500 {
  let t = now() - t0
  if tFront == nil, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { tFront = t }
  let top = frontLayer0Owner()
  if top != lastTop { topFlips.append(String(format: "%.0f:%@", t, top == pid ? "ardia" : "\(top ?? -1)")); lastTop = top }
  if top == pid { if tTop == nil { tTop = t } } else if tTop != nil && t > (tTop! + 0) { tTop = nil }
  if tKey == nil, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, keyTitle() != nil { tKey = t }
  usleep(4000)
}
func f(_ v: Double?) -> String { v.map { String(format: "%.0f", $0) } ?? "never" }
print("frontmost_ms=\(f(tFront)) ardia_on_top_ms=\(f(tTop)) key_window_ms=\(f(tKey)) key='\(keyTitle() ?? "nil")' minimize=\(minimizeEnabled()) top_flips=\(topFlips.joined(separator: ","))")
