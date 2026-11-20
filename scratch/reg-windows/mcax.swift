import AppKit
import ApplicationServices
func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v }
let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first!
let root = AXUIElementCreateApplication(dock.processIdentifier)
func walk(_ e: AXUIElement, _ depth: Int) {
  guard depth < 8 else { return }
  let role = attr(e, kAXRoleAttribute) as? String ?? "?"
  let title = (attr(e, kAXTitleAttribute) as? String) ?? (attr(e, kAXDescriptionAttribute) as? String) ?? ""
  var pos = CGPoint.zero, size = CGSize.zero
  if let p = attr(e, kAXPositionAttribute) { AXValueGetValue(p as! AXValue, .cgPoint, &pos) }
  if let s = attr(e, kAXSizeAttribute) { AXValueGetValue(s as! AXValue, .cgSize, &size) }
  let ident = attr(e, kAXIdentifierAttribute) as? String ?? ""
  print(String(repeating: "  ", count: depth) + "\(role) '\(title)' id=\(ident) @\(Int(pos.x)),\(Int(pos.y)) \(Int(size.width))x\(Int(size.height))")
  for c in (attr(e, kAXChildrenAttribute) as? [AnyObject]) ?? [] { walk(c as! AXUIElement, depth + 1) }
}
walk(root, 0)
