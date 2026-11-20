import ApplicationServices
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let app = AXUIElementCreateApplication(pid)
func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v }
func desc(_ w: AnyObject?) -> String {
  guard let w else { return "nil" }
  let e = w as! AXUIElement
  let t = attr(e, kAXTitleAttribute) as? String ?? "?"
  var size = CGSize.zero
  if let s = attr(e, kAXSizeAttribute) { AXValueGetValue(s as! AXValue, .cgSize, &size) }
  let sub = attr(e, kAXSubroleAttribute) as? String ?? "-"
  return "'\(t)' \(Int(size.width))x\(Int(size.height)) \(sub)"
}
print("trusted:", AXIsProcessTrusted())
print("focused:", desc(attr(app, kAXFocusedWindowAttribute)))
print("main:   ", desc(attr(app, kAXMainWindowAttribute)))
if let ws = attr(app, kAXWindowsAttribute) as? [AnyObject] { print("windows:", ws.map { desc($0) }) }
if let bar = attr(app, kAXMenuBarAttribute) {
  for top in (attr(bar as! AXUIElement, kAXChildrenAttribute) as? [AnyObject]) ?? [] {
    let topE = top as! AXUIElement
    guard (attr(topE, kAXTitleAttribute) as? String) == "Window" else { continue }
    for m in (attr(topE, kAXChildrenAttribute) as? [AnyObject]) ?? [] {
      for item in (attr(m as! AXUIElement, kAXChildrenAttribute) as? [AnyObject]) ?? [] {
        let i = item as! AXUIElement
        let t = attr(i, kAXTitleAttribute) as? String ?? ""
        if t.hasPrefix("Minimize") || t == "Zoom" { print("menu:", t, "enabled=", attr(i, kAXEnabledAttribute) as? Bool ?? false) }
      }
    }
  }
}
